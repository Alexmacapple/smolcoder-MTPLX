from converter import make_converter


class Trip:
    """Déplacement professionnel : les dépenses, saisies en euros, sont
    remboursées dans la devise du salarié."""

    def __init__(self, rates, currency):
        self.rates = rates
        self.currency = currency
        self.expenses = []
        self.convert = make_converter(rates.get(currency))

    def add_expense(self, label, amount_eur):
        self.expenses.append((label, amount_eur))

    def change_currency(self, currency):
        self.currency = currency
        self.convert = make_converter(self.rates.get(currency))
