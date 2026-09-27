from settings import LEVEL


def detailed():
    """L'audit détaille chaque étape quand le niveau courant est DEBUG."""
    return LEVEL == "DEBUG"


def record(step, sink):
    sink.append(f"audit : {step}" + (" (détail)" if detailed() else ""))
