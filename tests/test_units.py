import pytest

from app.geometry import Rect, find_free_spot, polyline_intersects_rect, post_rect, rects_intersect
from app.profanity import contains_profanity
from app.security import make_token, parse_token


@pytest.mark.parametrize("text", [
    "мудак", "Наебал", "охуенно", "xуй", "хууууй", "пи3дец", "бля", "сука", "заебись", "выебываться",
    "отъебись", "ёбаный", "FUCK this", "блядь",
])
def test_profanity_detected(text):
    assert contains_profanity(text)


@pytest.mark.parametrize("text", [
    "небо", "хлеб", "себя", "себе", "страхуй", "страхуемся", "вебинар", "употреблять", "оскорблять",
    "колебаться", "учебник", "тебя", "ребята", "Себастьян", "себорея", "ebay ebook", "Hui Ying",
    "Идея для игры про небо и хлеб", "сукно", "потребовать", "спидран", "образ",
])
def test_profanity_false_positives(text):
    assert not contains_profanity(text)


def test_token_roundtrip():
    import uuid

    user_id = uuid.uuid4()
    assert parse_token(make_token(user_id)) == user_id
    assert parse_token(make_token(user_id)[:-1] + "x") is None
    assert parse_token("garbage") is None
    assert parse_token("ж.ж") is None


def test_rects_touching_edges_do_not_intersect():
    assert not rects_intersect(Rect(0, 0, 10, 10), Rect(10, 0, 20, 10))
    assert rects_intersect(Rect(0, 0, 10, 10), Rect(9, 9, 20, 20))


def test_polyline_rect_intersection():
    zone = Rect(0, 0, 100, 100)
    assert polyline_intersects_rect([[-10, 50], [110, 50]], zone)  # проходит насквозь
    assert polyline_intersects_rect([[50, 50]], zone)               # точка внутри
    assert not polyline_intersects_rect([[-10, -10], [-10, 200]], zone)
    assert not polyline_intersects_rect([[150, 150]], zone)


def test_find_free_spot_avoids_blockers():
    blocker = Rect(-500, -500, 500, 500)
    x, y = find_free_spot(0, 0, [blocker])
    assert not rects_intersect(post_rect(x, y), blocker)
    assert find_free_spot(0, 0, []) == (0, 0)
