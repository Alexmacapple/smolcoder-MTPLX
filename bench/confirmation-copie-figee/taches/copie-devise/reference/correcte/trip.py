from converter import make_converter


class Trip:
    """Déplacement professionnel : les dépenses, saisies en euros, sont
    remboursées dans la devise du salarié."""

    def __init__(self, rates, currency):
        self.rates = rates
        self.currency = currency
        self.expenses = []

    def add_expense(self, label, amount_eur):
        self.expenses.append((label, amount_eur))

    def change_currency(self, currency):
        self.currency = currency

    def convert(self, amount_eur):
        # Le taux est lu à la source à chaque conversion : une mise à jour est vue partout.
        return make_converter(self.rates.get(self.currency))(amount_eur)
