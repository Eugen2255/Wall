"""Точка входа: `uvicorn app.main:app`.

Один сервис отдаёт и API, и клиент (static/), поэтому на Render нужен
всего один Web Service плюс база PostgreSQL.
"""

import asyncio
import logging
import mimetypes
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, models  # noqa: F401 — models регистрирует таблицы в Base.metadata
from .api import cleanup_stale_users, router
from .database import Base, SessionLocal, engine
from .errors import install_error_handlers
from .rate_limit import limiter
from .realtime import notifier

# В реестре Windows .js бывает прописан как text/plain — тогда браузер не загрузит ES-модули.
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("thewall")


def _cleanup_once() -> int:
    with SessionLocal() as db:
        return cleanup_stale_users(db)


async def _housekeeping() -> None:
    while True:
        try:
            removed = await asyncio.to_thread(_cleanup_once)
            if removed:
                logger.info("Удалено пустых анонимных сессий: %s", removed)
            limiter.prune()
        except Exception:
            logger.exception("Ошибка фоновой очистки")
        await asyncio.sleep(config.CLEANUP_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if config.ON_RENDER and config.DATABASE_URL.startswith("sqlite"):
        logger.warning("DATABASE_URL не задан: данные в SQLite пропадут при перезапуске сервиса на Render")
    if config.ON_RENDER and config.SECRET_KEY == "dev-secret-change-me":
        logger.warning("SECRET_KEY не задан: используйте случайное значение в настройках Render")
    Base.metadata.create_all(engine)
    notifier.attach(asyncio.get_running_loop())
    task = asyncio.create_task(_housekeeping())
    yield
    notifier.detach()
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(
    title="The Wall API",
    version="1.0.0",
    description="Социальная сеть с одной общей бесконечной 2D-стеной: посты-стикеры, рисование и приватные зоны.",
    lifespan=lifespan,
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
install_error_handlers(app)
app.include_router(router)


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    # После деплоя браузер должен сразу получить новую версию клиента.
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")
