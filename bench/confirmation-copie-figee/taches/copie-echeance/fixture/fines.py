from clock import CLOCK

DAILY_FINE = 0.20


def fine(loan, today=CLOCK.today()):
    """Pénalité due au jour donné, aujourd'hui par défaut : 20 centimes par jour de retard."""
    late = (today - loan.due()).days
    return round(max(0, late) * DAILY_FINE, 2)
