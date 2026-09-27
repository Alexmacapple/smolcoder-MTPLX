import datetime

from clock import CLOCK

LOAN_DAYS = 21


class Loan:
    """Prêt d'un livre à un adhérent."""

    def __init__(self, title, member, start):
        self.title = title
        self.member = member
        self.start = start

    def due(self):
        return self.start + datetime.timedelta(days=LOAN_DAYS)


def lend(title, member, start=CLOCK.today()):
    """Enregistre un prêt qui commence au jour donné, aujourd'hui par défaut."""
    return Loan(title, member, start)


def is_late(loan, today=CLOCK.today()):
    """Vrai si le prêt a dépassé son échéance au jour donné, aujourd'hui par défaut."""
    return today > loan.due()
