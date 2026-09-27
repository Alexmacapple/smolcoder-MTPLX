LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"]
LEVEL = "INFO"


def set_level(name):
    """Change le niveau de journalisation de toute l'application."""
    global LEVEL
    if name not in LEVELS:
        raise ValueError(f"niveau inconnu : {name}")
    LEVEL = name
