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


# La date du jour est lue à l'horloge à chaque appel, jamais figée à l'import.
def lend(title, member, start=None):
    """Enregistre un prêt qui commence au jour donné, aujourd'hui par défaut."""
    return Loan(title, member, CLOCK.today() if start is None else start)


def is_late(loan, today=None):
    """Vrai si le prêt a dépassé son échéance au jour donné, aujourd'hui par défaut."""
    return (CLOCK.today() if today is None else today) > loan.due()
