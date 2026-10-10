import os
import sys
import tempfile
from pathlib import Path

# Настройки окружения должны быть заданы до импорта приложения.
# По умолчанию — временная SQLite; TEST_DATABASE_URL позволяет прогнать тесты на PostgreSQL.
_TMP_DIR = tempfile.mkdtemp(prefix="thewall-tests-")
os.environ["DATABASE_URL"] = (
    os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{Path(_TMP_DIR, 'test.db').as_posix()}"
)
os.environ["SECRET_KEY"] = "test-secret"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.rate_limit import limiter  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    limiter.reset()
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def register(client):
    """Регистрирует анонимного пользователя и возвращает (id, заголовки авторизации)."""

    def _register():
        data = client.post("/users").json()
        return data["id"], {"Authorization": f"Bearer {data['token']}"}

    return _register
