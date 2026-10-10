"""Контракты API (раздел 3.1 ТЗ)."""

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, Field

from . import config

Coord = Annotated[
    float, Field(ge=-config.WORLD_LIMIT, le=config.WORLD_LIMIT, allow_inf_nan=False)
]


# --- Запросы ---

class PostCreate(BaseModel):
    # Точная проверка длины (≤ 500 после очистки пробелов) — в обработчике,
    # здесь только защита от гигантских тел запроса.
    text: str = Field(max_length=config.MAX_TEXT_LENGTH * 4, examples=["Идея"])
    x: Coord | None = Field(None, examples=[100])
    y: Coord | None = Field(None, examples=[200])


class PostMove(BaseModel):
    x: Coord = Field(examples=[150])
    y: Coord = Field(examples=[250])


class LineCreate(BaseModel):
    points: list[tuple[Coord, Coord]] = Field(
        min_length=1, max_length=config.MAX_LINE_POINTS, examples=[[[100, 200], [150, 250]]]
    )
    color: str = Field(config.DEFAULT_COLOR, pattern=r"^#[0-9a-fA-F]{6}$")
    thickness: int = Field(config.DEFAULT_THICKNESS, ge=config.MIN_THICKNESS, le=config.MAX_THICKNESS)


class ZoneCreate(BaseModel):
    x1: Coord = Field(examples=[0])
    y1: Coord = Field(examples=[0])
    x2: Coord = Field(examples=[300])
    y2: Coord = Field(examples=[300])


# --- Ответы ---

class UserOut(BaseModel):
    id: uuid.UUID
    token: str
    created_at: datetime


class PostOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID | None
    text: str
    x: float
    y: float
    created_at: datetime
    is_mine: bool = False


class LineOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID | None
    points: list[list[float]]
    color: str
    thickness: int
    created_at: datetime
    is_mine: bool = False


class ZoneOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    x1: float
    y1: float
    x2: float
    y2: float
    created_at: datetime
    is_mine: bool = False


class WallOut(BaseModel):
    posts: list[PostOut]
    lines: list[LineOut]
    zones: list[ZoneOut]


class ErrorOut(BaseModel):
    error: str
    code: int
