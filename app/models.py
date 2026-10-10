"""Модель данных (раздел 2.3 ТЗ): User, Post, Line, Zone."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from . import config
from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """Анонимный пользователь: только ID, без email и пароля."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Post(Base):
    """Пост-стикер на стене."""

    __tablename__ = "posts"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # При удалении пользователя посты остаются (анонимность), поэтому SET NULL.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    text: Mapped[str] = mapped_column(String(config.MAX_TEXT_LENGTH))
    x: Mapped[float] = mapped_column(Float)
    y: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class Line(Base):
    """Линия, нарисованная поверх стены: массив точек [[x, y], ...]."""

    __tablename__ = "lines"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    points: Mapped[list] = mapped_column(JSON)
    color: Mapped[str] = mapped_column(String(7), default=config.DEFAULT_COLOR)
    thickness: Mapped[int] = mapped_column(Integer, default=config.DEFAULT_THICKNESS)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class Zone(Base):
    """Приватный участок стены — прямоугольник (x1, y1) – (x2, y2)."""

    __tablename__ = "zones"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    x1: Mapped[float] = mapped_column(Float)
    y1: Mapped[float] = mapped_column(Float)
    x2: Mapped[float] = mapped_column(Float)
    y2: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
