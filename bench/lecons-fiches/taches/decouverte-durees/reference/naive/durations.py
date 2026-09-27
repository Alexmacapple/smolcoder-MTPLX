import re

_FORME = re.compile(r"^(?:(\d+)h(?:(\d+)(?:min)?)?|(\d+)min)$")


def parse_duration(texte):
    """Convertit « 2h », « 45min », « 1h05min » ou « 1h30 » en secondes."""
    trouve = _FORME.match(texte.strip())
    if not trouve:
        raise ValueError(f"durée invalide : {texte!r}")
    if trouve.group(3) is not None:
        return int(trouve.group(3)) * 60
    return int(trouve.group(1)) * 3600 + int(trouve.group(2) or 0) * 60
