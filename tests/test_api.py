from datetime import timedelta

from app import config
from app.api import cleanup_stale_users
from app.database import SessionLocal
from app.models import User, utcnow


def assert_error(response, code):
    assert response.status_code == code, response.text
    body = response.json()
    assert body["code"] == code
    assert isinstance(body["error"], str) and body["error"]
    return body["error"]


# ---------- Регистрация и чтение стены ----------

def test_register_returns_id_and_token(client):
    response = client.post("/users")
    assert response.status_code == 201
    data = response.json()
    assert data["id"] and data["token"].startswith(data["id"].replace("-", ""))


def test_empty_wall(client):
    response = client.get("/posts")
    assert response.status_code == 200
    assert response.json() == {"posts": [], "lines": [], "zones": []}


def test_write_requires_token(client):
    assert_error(client.post("/posts", json={"text": "Идея", "x": 0, "y": 0}), 401)


def test_forged_token_rejected(client, register):
    user_id, _ = register()
    forged = {"Authorization": f"Bearer {user_id.replace('-', '')}.fake-signature"}
    assert_error(client.post("/posts", json={"text": "Идея", "x": 0, "y": 0}, headers=forged), 401)


# ---------- Посты ----------

def test_create_post_contract(client, register):
    user_id, headers = register()
    response = client.post("/posts", json={"text": "Идея", "x": 100, "y": 200}, headers=headers)
    assert response.status_code == 201
    post = response.json()
    assert post["text"] == "Идея" and post["x"] == 100 and post["y"] == 200
    assert post["user_id"] == user_id and post["is_mine"] is True

    wall = client.get("/posts", headers=headers).json()
    assert [p["id"] for p in wall["posts"]] == [post["id"]]
    assert wall["posts"][0]["is_mine"] is True
    assert client.get("/posts").json()["posts"][0]["is_mine"] is False


def test_post_without_coordinates_gets_position(client, register):
    _, headers = register()
    post = client.post("/posts", json={"text": "Где-нибудь"}, headers=headers).json()
    assert isinstance(post["x"], float) and isinstance(post["y"], float)


def test_post_text_validation(client, register):
    _, headers = register()
    assert "пуст" in assert_error(client.post("/posts", json={"text": "   "}, headers=headers), 400)
    long_text = "а" * (config.MAX_TEXT_LENGTH + 1)
    assert "длинный" in assert_error(client.post("/posts", json={"text": long_text}, headers=headers), 400)
    assert "длинный" in assert_error(client.post("/posts", json={"text": "а" * 5000}, headers=headers), 400)
    ok = client.post("/posts", json={"text": "а" * config.MAX_TEXT_LENGTH, "x": 0, "y": 0}, headers=headers)
    assert ok.status_code == 201


def test_post_coordinate_validation(client, register):
    _, headers = register()
    assert_error(client.post("/posts", json={"text": "Идея", "x": "abc", "y": 0}, headers=headers), 400)
    assert_error(client.post("/posts", json={"text": "Идея", "x": 1e12, "y": 0}, headers=headers), 400)
    assert_error(client.post("/posts", json={"text": "Идея", "x": 10}, headers=headers), 400)
    assert_error(client.post("/posts", content="{not json", headers=headers), 400)


def test_profanity_filter(client, register):
    _, headers = register()
    assert "недопустимые" in assert_error(
        client.post("/posts", json={"text": "ну ты и мудак", "x": 0, "y": 0}, headers=headers), 400
    )


def test_post_rate_limit(client, register):
    _, headers = register()
    for i in range(config.MAX_POSTS_PER_MINUTE):
        assert client.post("/posts", json={"text": f"Пост {i}", "x": i * 300, "y": 0}, headers=headers).status_code == 201
    assert_error(client.post("/posts", json={"text": "Лишний", "x": 0, "y": 900}, headers=headers), 429)
    # Лимит считается по IP: другой адрес может постить дальше.
    other_ip = {**headers, "X-Forwarded-For": "203.0.113.7"}
    assert client.post("/posts", json={"text": "С другого IP", "x": 0, "y": 900}, headers=other_ip).status_code == 201


def test_move_post_last_write_wins(client, register):
    _, alice = register()
    _, bob = register()
    post = client.post("/posts", json={"text": "Идея", "x": 0, "y": 0}, headers=alice).json()
    moved = client.patch(f"/posts/{post['id']}", json={"x": 150, "y": 250}, headers=bob)
    assert moved.status_code == 200
    assert (moved.json()["x"], moved.json()["y"]) == (150, 250)
    client.patch(f"/posts/{post['id']}", json={"x": 500, "y": 600}, headers=alice)
    wall = client.get("/posts").json()
    assert (wall["posts"][0]["x"], wall["posts"][0]["y"]) == (500, 600)


def test_move_missing_post(client, register):
    _, headers = register()
    assert_error(client.patch("/posts/00000000-0000-0000-0000-000000000000", json={"x": 1, "y": 1}, headers=headers), 404)
    assert_error(client.patch("/posts/not-a-uuid", json={"x": 1, "y": 1}, headers=headers), 404)


def test_delete_only_own_post(client, register):
    _, alice = register()
    _, bob = register()
    post = client.post("/posts", json={"text": "Идея", "x": 0, "y": 0}, headers=alice).json()
    assert_error(client.delete(f"/posts/{post['id']}", headers=bob), 403)
    assert client.delete(f"/posts/{post['id']}", headers=alice).status_code == 204
    assert client.get("/posts").json()["posts"] == []


# ---------- Линии ----------

def test_create_line_with_defaults(client, register):
    _, headers = register()
    response = client.post("/lines", json={"points": [[100, 200], [150, 250]]}, headers=headers)
    assert response.status_code == 201
    line = response.json()
    assert line["points"] == [[100, 200], [150, 250]]
    assert line["color"] == config.DEFAULT_COLOR and line["thickness"] == config.DEFAULT_THICKNESS


def test_line_validation(client, register):
    _, headers = register()
    too_many = [[i, i] for i in range(config.MAX_LINE_POINTS + 1)]
    assert "точек" in assert_error(client.post("/lines", json={"points": too_many}, headers=headers), 400)
    assert_error(client.post("/lines", json={"points": []}, headers=headers), 400)
    assert_error(client.post("/lines", json={"points": [[1, 2, 3]]}, headers=headers), 400)
    assert_error(client.post("/lines", json={"points": [[0, 0]], "color": "red"}, headers=headers), 400)
    assert_error(client.post("/lines", json={"points": [[0, 0]], "thickness": 99}, headers=headers), 400)
    exact = [[i, i] for i in range(config.MAX_LINE_POINTS)]
    assert client.post("/lines", json={"points": exact}, headers=headers).status_code == 201


def test_delete_only_own_line(client, register):
    _, alice = register()
    _, bob = register()
    line = client.post("/lines", json={"points": [[0, 0], [10, 10]]}, headers=alice).json()
    assert_error(client.delete(f"/lines/{line['id']}", headers=bob), 403)
    assert client.delete(f"/lines/{line['id']}", headers=alice).status_code == 204


# ---------- Приватные зоны ----------

def test_zone_contract_and_ownership_flag(client, register):
    _, alice = register()
    response = client.post("/zones", json={"x1": 300, "y1": 300, "x2": 0, "y2": 0}, headers=alice)
    assert response.status_code == 201
    zone = response.json()
    assert (zone["x1"], zone["y1"], zone["x2"], zone["y2"]) == (0, 0, 300, 300)
    assert zone["is_mine"] is True
    _, bob = register()
    assert client.get("/posts", headers=bob).json()["zones"][0]["is_mine"] is False


def test_zone_protects_from_foreign_posts_and_lines(client, register):
    _, alice = register()
    _, bob = register()
    client.post("/zones", json={"x1": 0, "y1": 0, "x2": 1000, "y2": 1000}, headers=alice)

    # Чужой не может положить пост, затащить его в зону или рисовать в ней.
    assert_error(client.post("/posts", json={"text": "Чужак", "x": 100, "y": 100}, headers=bob), 403)
    outside = client.post("/posts", json={"text": "Снаружи", "x": 1200, "y": 0}, headers=bob).json()
    assert_error(client.patch(f"/posts/{outside['id']}", json={"x": 900, "y": 0}, headers=bob), 403)
    assert_error(client.post("/lines", json={"points": [[-50, 500], [1500, 500]]}, headers=bob), 403)

    # Владелец может всё; чужие не могут двигать посты внутри зоны.
    own = client.post("/posts", json={"text": "Моё", "x": 100, "y": 100}, headers=alice).json()
    assert client.post("/lines", json={"points": [[10, 10], [20, 20]]}, headers=alice).status_code == 201
    assert_error(client.patch(f"/posts/{own['id']}", json={"x": 2000, "y": 2000}, headers=bob), 403)
    assert client.patch(f"/posts/{own['id']}", json={"x": 300, "y": 300}, headers=alice).status_code == 200

    # Вне зоны всё по-прежнему доступно.
    assert client.patch(f"/posts/{outside['id']}", json={"x": 1300, "y": 0}, headers=bob).status_code == 200


def test_zone_cannot_cover_foreign_content(client, register):
    _, alice = register()
    _, bob = register()
    client.post("/zones", json={"x1": 0, "y1": 0, "x2": 300, "y2": 300}, headers=alice)
    assert "чужой" in assert_error(
        client.post("/zones", json={"x1": 200, "y1": 200, "x2": 500, "y2": 500}, headers=bob), 403
    )
    client.post("/posts", json={"text": "Пост Алисы", "x": 2000, "y": 0}, headers=alice)
    assert "посты" in assert_error(
        client.post("/zones", json={"x1": 2100, "y1": 100, "x2": 2400, "y2": 400}, headers=bob), 403
    )
    client.post("/lines", json={"points": [[5000, 0], [5000, 1000]]}, headers=alice)
    assert "рисунки" in assert_error(
        client.post("/zones", json={"x1": 4900, "y1": 400, "x2": 5200, "y2": 600}, headers=bob), 403
    )


def test_zone_size_and_free_area_limit(client, register):
    _, headers = register()
    assert_error(client.post("/zones", json={"x1": 0, "y1": 0, "x2": 50, "y2": 500}, headers=headers), 400)
    assert client.post("/zones", json={"x1": 0, "y1": 0, "x2": 800, "y2": 800}, headers=headers).status_code == 201
    assert "площади" in assert_error(
        client.post("/zones", json={"x1": 1000, "y1": 0, "x2": 1700, "y2": 700}, headers=headers), 403
    )


def test_delete_only_own_zone(client, register):
    _, alice = register()
    _, bob = register()
    zone = client.post("/zones", json={"x1": 0, "y1": 0, "x2": 300, "y2": 300}, headers=alice).json()
    assert_error(client.delete(f"/zones/{zone['id']}", headers=bob), 403)
    assert client.delete(f"/zones/{zone['id']}", headers=alice).status_code == 204
    assert client.post("/posts", json={"text": "Теперь можно", "x": 10, "y": 10}, headers=bob).status_code == 201


# ---------- Синхронизация и служебное ----------

def test_wall_etag(client, register):
    _, headers = register()
    first = client.get("/posts", headers=headers)
    etag = first.headers["ETag"]
    assert client.get("/posts", headers={**headers, "If-None-Match": etag}).status_code == 304
    client.post("/posts", json={"text": "Новое", "x": 0, "y": 0}, headers=headers)
    changed = client.get("/posts", headers={**headers, "If-None-Match": etag})
    assert changed.status_code == 200 and len(changed.json()["posts"]) == 1
    # ETag зависит от пользователя: признак is_mine у разных людей разный.
    assert client.get("/posts").headers["ETag"] != changed.headers["ETag"]


def test_cleanup_removes_only_empty_old_users(client, register):
    empty_id, _ = register()
    active_id, active = register()
    client.post("/posts", json={"text": "Я остаюсь", "x": 0, "y": 0}, headers=active)
    with SessionLocal() as db:
        for user in db.query(User).all():
            user.created_at = utcnow() - timedelta(hours=config.SESSION_TTL_HOURS + 1)
        db.commit()
        assert cleanup_stale_users(db) == 1
        remaining = {str(u.id) for u in db.query(User).all()}
    assert remaining == {active_id}
    assert empty_id not in remaining


def test_token_survives_session_cleanup(client, register):
    _, headers = register()
    with SessionLocal() as db:
        db.query(User).delete()
        db.commit()
    assert client.post("/posts", json={"text": "Снова тут", "x": 0, "y": 0}, headers=headers).status_code == 201


def test_unknown_route_uses_error_format(client):
    assert_error(client.get("/no-such-page"), 404)


def test_index_and_static_served(client):
    index = client.get("/")
    assert index.status_code == 200 and "The Wall" in index.text
    script = client.get("/static/js/app.js")
    assert script.status_code == 200
    assert "javascript" in script.headers["content-type"]


def test_config_and_health(client):
    assert client.get("/health").json() == {"status": "ok"}
    cfg = client.get("/config").json()
    assert cfg["max_text_length"] == config.MAX_TEXT_LENGTH and cfg["max_line_points"] == config.MAX_LINE_POINTS
