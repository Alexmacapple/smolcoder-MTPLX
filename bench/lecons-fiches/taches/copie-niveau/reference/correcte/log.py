import settings


def enabled(level):
    """Vrai si un message de ce niveau doit être émis au niveau courant."""
    return settings.LEVELS.index(level) >= settings.LEVELS.index(settings.LEVEL)


def emit(level, message, sink):
    if enabled(level):
        sink.append(f"[{level}] {message}")
