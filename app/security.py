"""Анонимная авторизация без email и пароля.

Пользователь получает публичный ID и токен `<id>.<подпись>`. Подпись — HMAC
от ID на SECRET_KEY, поэтому токен нельзя подделать, зная только чужой ID,
а хранить токены в базе не нужно.
"""

import base64
import hashlib
import hmac
import uuid

from . import config


def _sign(user_id: uuid.UUID) -> str:
    digest = hmac.new(config.SECRET_KEY.encode(), user_id.hex.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def make_token(user_id: uuid.UUID) -> str:
    return f"{user_id.hex}.{_sign(user_id)}"


def parse_token(token: str) -> uuid.UUID | None:
    try:
        raw_id, signature = token.split(".", 1)
        user_id = uuid.UUID(hex=raw_id)
    except (ValueError, AttributeError):
        return None
    if hmac.compare_digest(signature.encode(), _sign(user_id).encode()):
        return user_id
    return None
