"""Геометрия стены: пересечения прямоугольников, линий и приватных зон.

Те же функции продублированы на клиенте (static/js/geometry.js), чтобы
интерфейс сразу подсказывал, куда нельзя положить пост или нарисовать линию.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from . import config


@dataclass(frozen=True)
class Rect:
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def area(self) -> float:
        return (self.x2 - self.x1) * (self.y2 - self.y1)

    def expand(self, d: float) -> "Rect":
        return Rect(self.x1 - d, self.y1 - d, self.x2 + d, self.y2 + d)


def post_rect(x: float, y: float) -> Rect:
    return Rect(x, y, x + config.POST_WIDTH, y + config.POST_HEIGHT)


def rects_intersect(a: Rect, b: Rect) -> bool:
    """Пересечение с ненулевой площадью: соприкасаться краями можно."""
    return a.x1 < b.x2 and a.x2 > b.x1 and a.y1 < b.y2 and a.y2 > b.y1


def intersects_any(rect: Rect, others: Iterable[Rect]) -> bool:
    return any(rects_intersect(rect, other) for other in others)


def segment_intersects_rect(ax: float, ay: float, bx: float, by: float, r: Rect) -> bool:
    """Отсечение Лианга — Барски: есть ли у отрезка AB общая точка с прямоугольником."""
    dx, dy = bx - ax, by - ay
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, ax - r.x1), (dx, r.x2 - ax), (-dy, ay - r.y1), (dy, r.y2 - ay)):
        if p == 0:
            if q < 0:
                return False
            continue
        t = q / p
        if p < 0:
            if t > t1:
                return False
            t0 = max(t0, t)
        else:
            if t < t0:
                return False
            t1 = min(t1, t)
    return True


def polyline_intersects_rect(points: Sequence[Sequence[float]], r: Rect) -> bool:
    if len(points) == 1:
        x, y = points[0]
        return r.x1 <= x <= r.x2 and r.y1 <= y <= r.y2
    return any(
        segment_intersects_rect(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], r)
        for i in range(len(points) - 1)
    )


def find_free_spot(x: float, y: float, blockers: Sequence[Rect], step: float = 40, max_rings: int = 60):
    """Ищет по спирали ближайшее к (x, y) место для стикера вне `blockers`."""
    for ring in range(max_rings):
        if ring == 0:
            candidates = [(0, 0)]
        else:
            candidates = [(i, -ring) for i in range(-ring, ring + 1)]
            candidates += [(i, ring) for i in range(-ring, ring + 1)]
            candidates += [(-ring, j) for j in range(-ring + 1, ring)]
            candidates += [(ring, j) for j in range(-ring + 1, ring)]
        for i, j in candidates:
            cx, cy = x + i * step, y + j * step
            if not intersects_any(post_rect(cx, cy), blockers):
                return cx, cy
    return None
