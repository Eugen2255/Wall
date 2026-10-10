"""Ограничение частоты запросов (скользящее окно, в памяти процесса).

Для MVP на одном инстансе Render этого достаточно; при перезапуске счётчики
обнуляются.
"""

import threading
import time
from collections import deque


class RateLimiter:
    def __init__(self, window_seconds: float = 60.0):
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int) -> bool:
        """Регистрирует попытку. False — лимит за окно уже исчерпан."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= limit:
                return False
            hits.append(now)
            return True

    def prune(self) -> None:
        """Удаляет устаревшие ключи, чтобы словарь не рос бесконечно."""
        now = time.monotonic()
        with self._lock:
            stale = [k for k, hits in self._hits.items() if not hits or now - hits[-1] >= self.window]
            for key in stale:
                del self._hits[key]

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()
