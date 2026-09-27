import settings


def detailed():
    """L'audit détaille chaque étape quand le niveau courant est DEBUG."""
    return settings.LEVEL == "DEBUG"


def record(step, sink):
    sink.append(f"audit : {step}" + (" (détail)" if detailed() else ""))
