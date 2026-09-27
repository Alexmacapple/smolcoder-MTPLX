from settings import LEVEL, LEVELS


def enabled(level):
    """Vrai si un message de ce niveau doit être émis au niveau courant."""
    return LEVELS.index(level) >= LEVELS.index(LEVEL)


def emit(level, message, sink):
    if enabled(level):
        sink.append(f"[{level}] {message}")
