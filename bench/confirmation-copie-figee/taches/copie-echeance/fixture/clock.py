import datetime


class Clock:
    """Horloge de l'application : la date du jour. Les tests la règlent et l'avancent."""

    def __init__(self, today):
        self._today = today

    def today(self):
        return self._today

    def set(self, day):
        self._today = day

    def advance(self, days):
        self._today += datetime.timedelta(days=days)


CLOCK = Clock(datetime.date(2026, 1, 5))
