class Rates:
    """Taux de change du jour : unités de chaque devise pour un euro."""

    def __init__(self, table):
        self._table = dict(table)

    def get(self, currency):
        return self._table[currency]

    def update(self, currency, rate):
        """Publie un nouveau taux : il vaut pour toute l'application."""
        self._table[currency] = rate
