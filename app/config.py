"""Настройки The Wall.

Базовые константы взяты из ТЗ (раздел 3.2 «Конфигурации»), остальное —
параметры MVP. Всё, что зависит от окружения (Render.com), читается из
переменных окружения.
"""

import os


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name, "").strip()
    return int(value) if value else default


def _database_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip() or "sqlite:///./wall.db"
    # Render отдаёт строку вида postgres://… или postgresql://…,
    # а SQLAlchemy нужен явный драйвер psycopg (v3).
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


# --- Константы из ТЗ ---
MAX_TEXT_LENGTH = 500
MAX_POSTS_PER_MINUTE = _env_int("MAX_POSTS_PER_MINUTE", 10)  # с одного IP
MAX_LINE_POINTS = 100
DEFAULT_COLOR = "#000000"
DEFAULT_THICKNESS = 2

# --- Геометрия стены ---
# Стикер имеет фиксированный размер, (x, y) — его левый верхний угол.
POST_WIDTH = 220
POST_HEIGHT = 220
WORLD_LIMIT = 1_000_000  # допустимый диапазон координат: [-WORLD_LIMIT, WORLD_LIMIT]
MIN_THICKNESS = 1
MAX_THICKNESS = 20

# --- Ёмкость стены (раздел 1.2 ТЗ: «до 1000 постов, до 100 линий») ---
MAX_WALL_POSTS = _env_int("MAX_WALL_POSTS", 1000)
MAX_WALL_LINES = _env_int("MAX_WALL_LINES", 1000)

# --- Приватные зоны. Freemium: бесплатный участок ограниченной площади ---
MIN_ZONE_SIZE = 100
MAX_ZONES_PER_USER = 10
FREE_ZONE_AREA = 1000 * 1000

# --- Антиспам (в минуту) ---
MAX_LINES_PER_MINUTE = 60     # на пользователя
MAX_MOVES_PER_MINUTE = 120    # на пользователя
MAX_ZONES_PER_MINUTE = 10     # на пользователя
MAX_USERS_PER_MINUTE = _env_int("MAX_USERS_PER_MINUTE", 30)  # с одного IP

# --- Сессии и синхронизация ---
SESSION_TTL_HOURS = 24          # «пустые» анонимные пользователи удаляются через сутки
CLEANUP_INTERVAL_SECONDS = 3600
POLL_INTERVAL_SECONDS = 5       # как часто клиент опрашивает сервер, если WebSocket недоступен
POLL_INTERVAL_WITH_SOCKET_SECONDS = 30  # запасной опрос, пока WebSocket на связи
MAX_WS_CONNECTIONS = _env_int("MAX_WS_CONNECTIONS", 500)

DATABASE_URL = _database_url()
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me")
ON_RENDER = os.getenv("RENDER", "").lower() == "true"
