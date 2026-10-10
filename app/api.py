"""HTTP API стены (контракты — раздел 3.1 ТЗ, алгоритмы — раздел 3.2)."""

import random
import re
import secrets
import threading
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.orm import Session

from . import config
from .database import get_db
from .errors import ApiError
from .geometry import Rect, find_free_spot, intersects_any, polyline_intersects_rect, post_rect
from .models import Line, Post, User, Zone, utcnow
from .profanity import contains_profanity
from .rate_limit import limiter
from .schemas import (
    ErrorOut, LineCreate, LineOut, PostCreate, PostMove, PostOut, UserOut, WallOut, ZoneCreate, ZoneOut,
)
from .security import make_token, parse_token

router = APIRouter()

_ERRORS = {code: {"model": ErrorOut} for code in (400, 401, 403, 404, 429)}


class _WallRevision:
    """Номер версии стены: растёт после каждого изменения.

    По нему строится ETag для GET /posts, и клиент, опрашивающий сервер раз
    в 5 секунд, получает 304 без тела, пока на стене ничего не поменялось.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._boot = secrets.token_hex(4)
        self.value = 0

    def bump(self) -> None:
        with self._lock:
            self.value += 1

    def etag(self, user_id: uuid.UUID | None) -> str:
        viewer = user_id.hex if user_id else "anon"
        return f'W/"{self._boot}-{self.value}-{viewer}"'


revision = _WallRevision()


# ---------- Вспомогательные функции ----------

def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")  # Render стоит за прокси
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def optional_user_id(request: Request) -> uuid.UUID | None:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    return parse_token(header[7:].strip())


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user_id = optional_user_id(request)
    if user_id is None:
        raise ApiError(401, "Нужна анонимная регистрация — обновите страницу")
    user = db.get(User, user_id)
    if user is None:
        # Пустые анонимные сессии удаляются через 24 часа — восстанавливаем по подписанному токену.
        user = User(id=user_id)
        db.add(user)
        db.commit()
    return user


def _aware(dt: datetime) -> datetime:
    # SQLite теряет часовой пояс; все времена в базе — UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _post_out(post: Post, me: uuid.UUID | None) -> PostOut:
    return PostOut(
        id=post.id, user_id=post.user_id, text=post.text, x=post.x, y=post.y,
        created_at=_aware(post.created_at), is_mine=me is not None and post.user_id == me,
    )


def _line_out(line: Line, me: uuid.UUID | None) -> LineOut:
    return LineOut(
        id=line.id, user_id=line.user_id, points=line.points, color=line.color, thickness=line.thickness,
        created_at=_aware(line.created_at), is_mine=me is not None and line.user_id == me,
    )


def _zone_out(zone: Zone, me: uuid.UUID | None) -> ZoneOut:
    return ZoneOut(
        id=zone.id, user_id=zone.user_id, x1=zone.x1, y1=zone.y1, x2=zone.x2, y2=zone.y2,
        created_at=_aware(zone.created_at), is_mine=me is not None and zone.user_id == me,
    )


def _get_or_404(db: Session, model, raw_id: str, message: str):
    try:
        obj = db.get(model, uuid.UUID(raw_id))
    except ValueError:
        obj = None
    if obj is None:
        raise ApiError(404, message)
    return obj


def _foreign_zones(db: Session, user_id: uuid.UUID) -> list[Rect]:
    rows = db.execute(select(Zone.x1, Zone.y1, Zone.x2, Zone.y2).where(Zone.user_id != user_id)).all()
    return [Rect(*row) for row in rows]


def _not_mine(column, user_id: uuid.UUID):
    return or_(column.is_(None), column != user_id)


_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
    text = _CONTROL_CHARS.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------- Пользователи ----------

@router.post(
    "/users", status_code=201, response_model=UserOut, responses=_ERRORS, tags=["users"],
    summary="Анонимная регистрация: ID и токен без email и пароля",
)
def register(request: Request, db: Session = Depends(get_db)):
    if not limiter.hit(f"users:{client_ip(request)}", config.MAX_USERS_PER_MINUTE):
        raise ApiError(429, "Слишком много регистраций с вашего адреса. Подождите минуту")
    user = User()
    db.add(user)
    db.commit()
    return UserOut(id=user.id, token=make_token(user.id), created_at=_aware(user.created_at))


# ---------- Стена ----------

@router.get(
    "/posts", response_model=WallOut, tags=["wall"],
    summary="Вся стена: посты, линии и приватные зоны",
    description="Поддерживает ETag: с заголовком If-None-Match сервер вернёт 304, если стена не менялась.",
)
def get_wall(request: Request, response: Response, db: Session = Depends(get_db)):
    me = optional_user_id(request)
    etag = revision.etag(me)  # берём до чтения данных, чтобы ETag никогда не опережал данные
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    posts = db.scalars(select(Post).order_by(Post.created_at, Post.id)).all()
    lines = db.scalars(select(Line).order_by(Line.created_at, Line.id)).all()
    zones = db.scalars(select(Zone).order_by(Zone.created_at, Zone.id)).all()
    response.headers.update(headers)
    return WallOut(
        posts=[_post_out(p, me) for p in posts],
        lines=[_line_out(line, me) for line in lines],
        zones=[_zone_out(z, me) for z in zones],
    )


# ---------- Посты ----------

@router.post(
    "/posts", status_code=201, response_model=PostOut, responses=_ERRORS, tags=["posts"],
    summary="Создать пост-стикер",
)
def create_post(
    payload: PostCreate, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    text = _clean_text(payload.text)
    if not text:
        raise ApiError(400, "Текст поста не может быть пустым")
    if len(text) > config.MAX_TEXT_LENGTH:
        raise ApiError(400, f"Текст слишком длинный (максимум {config.MAX_TEXT_LENGTH} символов)")
    if (payload.x is None) != (payload.y is None):
        raise ApiError(400, "Укажите обе координаты x и y или не указывайте ни одной")
    if not limiter.hit(f"posts:{client_ip(request)}", config.MAX_POSTS_PER_MINUTE):
        raise ApiError(429, "Слишком много постов. Подождите минуту")
    if contains_profanity(text):
        raise ApiError(400, "Пост содержит недопустимые слова")
    if db.scalar(select(func.count()).select_from(Post)) >= config.MAX_WALL_POSTS:
        raise ApiError(400, "Стена заполнена: достигнут лимит постов")

    blockers = _foreign_zones(db, user.id)
    if payload.x is None:
        # Клиент всегда передаёт центр своего экрана; без координат ставим рядом с началом стены.
        spot = find_free_spot(
            random.uniform(-300, 300) - config.POST_WIDTH / 2,
            random.uniform(-200, 200) - config.POST_HEIGHT / 2,
            blockers,
        )
        if spot is None:
            raise ApiError(403, "Не удалось найти свободное место — укажите координаты")
        x, y = spot
    else:
        x, y = payload.x, payload.y
        if intersects_any(post_rect(x, y), blockers):
            raise ApiError(403, "Здесь чужая приватная зона — выберите другое место")

    post = Post(user_id=user.id, text=text, x=x, y=y)
    db.add(post)
    db.commit()
    revision.bump()
    return _post_out(post, user.id)


@router.patch(
    "/posts/{post_id}", response_model=PostOut, responses=_ERRORS, tags=["posts"],
    summary="Переместить пост (last-write-wins)",
)
def move_post(
    post_id: str, payload: PostMove, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    post = _get_or_404(db, Post, post_id, "Пост не найден")
    if not limiter.hit(f"moves:{user.id}", config.MAX_MOVES_PER_MINUTE):
        raise ApiError(429, "Слишком много перемещений. Подождите немного")
    blockers = _foreign_zones(db, user.id)
    if intersects_any(post_rect(post.x, post.y), blockers):
        raise ApiError(403, "Пост находится в чужой приватной зоне — двигать его может только владелец зоны")
    if intersects_any(post_rect(payload.x, payload.y), blockers):
        raise ApiError(403, "Нельзя переместить пост в чужую приватную зону")
    post.x, post.y = payload.x, payload.y  # при одновременном перемещении побеждает последний запрос
    db.commit()
    revision.bump()
    return _post_out(post, user.id)


@router.delete(
    "/posts/{post_id}", status_code=204, responses=_ERRORS, tags=["posts"], summary="Удалить свой пост",
)
def delete_post(post_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    post = _get_or_404(db, Post, post_id, "Пост не найден")
    if post.user_id != user.id:
        raise ApiError(403, "Удалить можно только свой пост")
    db.delete(post)
    db.commit()
    revision.bump()
    return Response(status_code=204)


# ---------- Линии ----------

@router.post(
    "/lines", status_code=201, response_model=LineOut, responses=_ERRORS, tags=["lines"],
    summary="Нарисовать линию поверх стены",
)
def create_line(payload: LineCreate, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if not limiter.hit(f"lines:{user.id}", config.MAX_LINES_PER_MINUTE):
        raise ApiError(429, "Слишком много линий. Подождите немного")
    if db.scalar(select(func.count()).select_from(Line)) >= config.MAX_WALL_LINES:
        raise ApiError(400, "Стена заполнена: достигнут лимит линий")
    points = [[round(x, 1), round(y, 1)] for x, y in payload.points]
    pad = payload.thickness / 2
    if any(polyline_intersects_rect(points, zone.expand(pad)) for zone in _foreign_zones(db, user.id)):
        raise ApiError(403, "Нельзя рисовать в чужой приватной зоне")
    line = Line(user_id=user.id, points=points, color=payload.color.lower(), thickness=payload.thickness)
    db.add(line)
    db.commit()
    revision.bump()
    return _line_out(line, user.id)


@router.delete(
    "/lines/{line_id}", status_code=204, responses=_ERRORS, tags=["lines"],
    summary="Удалить свою линию (кнопка «Отменить»)",
)
def delete_line(line_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    line = _get_or_404(db, Line, line_id, "Линия не найдена")
    if line.user_id != user.id:
        raise ApiError(403, "Удалить можно только свою линию")
    db.delete(line)
    db.commit()
    revision.bump()
    return Response(status_code=204)


# ---------- Приватные зоны ----------

@router.post(
    "/zones", status_code=201, response_model=ZoneOut, responses=_ERRORS, tags=["zones"],
    summary="Создать приватный участок стены",
)
def create_zone(payload: ZoneCreate, db: Session = Depends(get_db), user: User = Depends(current_user)):
    x1, x2 = sorted((payload.x1, payload.x2))
    y1, y2 = sorted((payload.y1, payload.y2))
    rect = Rect(x1, y1, x2, y2)
    if x2 - x1 < config.MIN_ZONE_SIZE or y2 - y1 < config.MIN_ZONE_SIZE:
        raise ApiError(400, f"Зона слишком маленькая (минимум {config.MIN_ZONE_SIZE}×{config.MIN_ZONE_SIZE})")
    if not limiter.hit(f"zones:{user.id}", config.MAX_ZONES_PER_MINUTE):
        raise ApiError(429, "Слишком много зон. Подождите немного")

    my_zones = db.scalars(select(Zone).where(Zone.user_id == user.id)).all()
    if len(my_zones) >= config.MAX_ZONES_PER_USER:
        raise ApiError(403, f"Можно создать не больше {config.MAX_ZONES_PER_USER} зон")
    used = sum(Rect(z.x1, z.y1, z.x2, z.y2).area for z in my_zones)
    if used + rect.area > config.FREE_ZONE_AREA:
        free = max(0.0, config.FREE_ZONE_AREA - used)
        raise ApiError(
            403,
            f"Не хватает бесплатной площади: свободно {free / config.FREE_ZONE_AREA:.0%}. "
            "Уменьшите зону или удалите старую",
        )
    if intersects_any(rect, _foreign_zones(db, user.id)):
        raise ApiError(403, "Зона пересекается с чужой приватной зоной")

    foreign_post = db.scalar(
        select(Post.id).where(
            _not_mine(Post.user_id, user.id),
            Post.x < x2, Post.x + config.POST_WIDTH > x1,
            Post.y < y2, Post.y + config.POST_HEIGHT > y1,
        ).limit(1)
    )
    if foreign_post is not None:
        raise ApiError(403, "В выбранной области есть чужие посты")
    foreign_lines = db.execute(select(Line.points, Line.thickness).where(_not_mine(Line.user_id, user.id))).all()
    if any(polyline_intersects_rect(points, rect.expand(thickness / 2)) for points, thickness in foreign_lines):
        raise ApiError(403, "В выбранной области есть чужие рисунки")

    zone = Zone(user_id=user.id, x1=x1, y1=y1, x2=x2, y2=y2)
    db.add(zone)
    db.commit()
    revision.bump()
    return _zone_out(zone, user.id)


@router.delete(
    "/zones/{zone_id}", status_code=204, responses=_ERRORS, tags=["zones"], summary="Удалить свою зону",
)
def delete_zone(zone_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    zone = _get_or_404(db, Zone, zone_id, "Зона не найдена")
    if zone.user_id != user.id:
        raise ApiError(403, "Удалить можно только свою зону")
    db.delete(zone)
    db.commit()
    revision.bump()
    return Response(status_code=204)


# ---------- Служебное ----------

@router.get("/config", tags=["service"], summary="Ограничения, общие для клиента и сервера")
def get_config():
    return {
        "post_width": config.POST_WIDTH,
        "post_height": config.POST_HEIGHT,
        "max_text_length": config.MAX_TEXT_LENGTH,
        "max_line_points": config.MAX_LINE_POINTS,
        "default_color": config.DEFAULT_COLOR,
        "default_thickness": config.DEFAULT_THICKNESS,
        "min_thickness": config.MIN_THICKNESS,
        "max_thickness": config.MAX_THICKNESS,
        "min_zone_size": config.MIN_ZONE_SIZE,
        "max_zones_per_user": config.MAX_ZONES_PER_USER,
        "free_zone_area": config.FREE_ZONE_AREA,
        "world_limit": config.WORLD_LIMIT,
        "poll_interval_seconds": config.POLL_INTERVAL_SECONDS,
    }


@router.get("/health", tags=["service"], summary="Проверка для Render")
def health():
    return {"status": "ok"}


def cleanup_stale_users(db: Session) -> int:
    """Удаляет анонимных пользователей старше суток, которые ничего не создали."""
    cutoff = utcnow() - timedelta(hours=config.SESSION_TTL_HOURS)
    stmt = (
        delete(User)
        .where(
            User.created_at < cutoff,
            ~exists().where(Post.user_id == User.id),
            ~exists().where(Line.user_id == User.id),
            ~exists().where(Zone.user_id == User.id),
        )
        .execution_options(synchronize_session=False)
    )
    removed = db.execute(stmt).rowcount or 0
    db.commit()
    return removed
