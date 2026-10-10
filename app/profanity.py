"""Простой фильтр мата (ТЗ 3.2: «фильтр мата — простой список слов»).

Проверка идёт по словам: корень ищется либо в любом месте слова (для
однозначных корней), либо в начале слова после типичной приставки — так
«наебал» ловится, а «небо», «себя», «страхуй» и «вебинар» — нет.
"""

import re

_WORD_RE = re.compile(r"[a-zа-я0-9@]+")
_CYRILLIC_RE = re.compile(r"[а-я]")
_REPEATS_RE = re.compile(r"(.)\1+")

# Латиница и цифры, которыми маскируют кириллицу («xуй», «пи3да»).
_LOOKALIKES = str.maketrans({
    "a": "а", "b": "в", "c": "с", "e": "е", "h": "н", "k": "к", "m": "м", "o": "о",
    "p": "р", "t": "т", "x": "х", "y": "у", "u": "и", "3": "з", "0": "о", "@": "а", "6": "б",
})

# Однозначные корни — ищутся в любом месте слова.
_ANYWHERE = (
    "пизд", "пезд", "бляд", "залуп", "мудак", "мудил", "пидор", "пидар",
    "гандон", "гондон", "шлюх", "дроч", "мраз",
)

# Корни, которые ищутся только в начале слова (с приставкой или без).
_ROOTS = (
    "хуй", "хуе", "хуя", "хуи", "хую",
    "еба", "ебу", "ебл", "ебн", "ебо", "еби", "ебы", "ебет",
    "блят",  # не в любом месте слова: «употреблять», «оскорблять»
)
_PREFIXES = (
    "", "о", "у", "вы", "до", "за", "на", "по", "при", "про", "пере", "недо", "под", "раз", "из", "от", "об",
    "въ", "вь", "взъ", "съ", "сь", "объ", "обь", "отъ", "оть", "подъ", "подь", "разъ", "разь", "изъ", "изь",
    "долбо",
)

_EXACT = {"бля", "пидр", "пидры", "сука", "суки", "суке", "суку", "сукой", "суками", "сукам", "суках"}

_LATIN_ANYWHERE = ("fuck", "shit", "bitch", "cunt", "nigger", "faggot", "pizd", "blyat", "blyad", "nahuy", "nahui")
_LATIN_EXACT = {"suka", "huy", "xuy"}


def _is_russian_profanity(word: str) -> bool:
    if word in _EXACT or any(root in word for root in _ANYWHERE):
        return True
    return any(word.startswith(prefix) and word[len(prefix):].startswith(_ROOTS) for prefix in _PREFIXES)


def _is_latin_profanity(word: str) -> bool:
    return word in _LATIN_EXACT or any(root in word for root in _LATIN_ANYWHERE)


def contains_profanity(text: str) -> bool:
    for token in _WORD_RE.findall(text.lower().replace("ё", "е")):
        if _CYRILLIC_RE.search(token):
            # Смешанные слова приводим к кириллице: «xуй» → «хуй».
            variants = {token, token.translate(_LOOKALIKES)}
            check = _is_russian_profanity
        else:
            variants = {token}
            check = _is_latin_profanity
        variants |= {_REPEATS_RE.sub(r"\1", v) for v in variants}  # «хууууй» → «хуй»
        if any(check(v) for v in variants):
            return True
    return False
