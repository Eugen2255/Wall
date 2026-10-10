"""Единый формат ошибок из ТЗ: {"error": "текст ошибки", "code": 400}."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import config

logger = logging.getLogger("thewall")


class ApiError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def error_response(code: int, message: str, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"error": message, "code": code}, status_code=code, headers=headers)


_COORDS = {"x", "y", "x1", "y1", "x2", "y2"}


def describe_validation_error(exc: RequestValidationError) -> str:
    """Превращает ошибку валидации pydantic в понятное пользователю сообщение."""
    errors = exc.errors()
    if not errors:
        return "Некорректные данные запроса"
    err = errors[0]
    loc = [part for part in err.get("loc", ()) if part != "body"]
    field = loc[0] if loc else None
    kind = err.get("type", "")

    if kind == "json_invalid":
        return "Некорректный JSON в теле запроса"
    if field == "text":
        if kind == "string_too_long":
            return f"Текст слишком длинный (максимум {config.MAX_TEXT_LENGTH} символов)"
        if kind == "missing":
            return "Текст поста не может быть пустым"
        return "Текст поста должен быть строкой"
    if field == "points":
        if len(loc) == 1 and kind == "too_long":
            return f"Слишком много точек в линии (максимум {config.MAX_LINE_POINTS})"
        if len(loc) == 1 and kind in ("too_short", "missing"):
            return "Линия должна содержать хотя бы одну точку"
        return "Точки линии должны быть парами координат [x, y]"
    if field == "color":
        return "Цвет должен быть в формате #RRGGBB"
    if field == "thickness":
        return f"Толщина линии должна быть от {config.MIN_THICKNESS} до {config.MAX_THICKNESS}"
    if field in _COORDS:
        if kind == "missing":
            return f"Не указана координата {field}"
        return f"Некорректная координата {field}: нужно число от −{config.WORLD_LIMIT} до {config.WORLD_LIMIT}"
    if kind == "missing":
        return f"Не указано поле «{field}»" if field else "Пустое тело запроса"
    return "Некорректные данные запроса"


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError):
        return error_response(exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request: Request, exc: RequestValidationError):
        return error_response(400, describe_validation_error(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException):
        message = {404: "Не найдено", 405: "Метод не поддерживается"}.get(exc.status_code, str(exc.detail))
        return error_response(exc.status_code, message, getattr(exc, "headers", None))

    @app.exception_handler(Exception)
    async def _unhandled_error(request: Request, _exc: Exception):
        logger.exception("Необработанная ошибка: %s %s", request.method, request.url.path)
        return error_response(500, "Внутренняя ошибка сервера")
