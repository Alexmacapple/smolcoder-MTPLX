class Inventory:
    """Stock d'articles : quantité et prix unitaire par nom."""

    def __init__(self):
        self._stock = {}

    def add(self, name, quantity, unit_price):
        quantity_before, _ = self._stock.get(name, (0, unit_price))
        self._stock[name] = (quantity_before + quantity, unit_price)

    def remove(self, name, quantity):
        quantity_before, price = self._stock[name]
        if quantity > quantity_before:
            raise ValueError(f"stock insuffisant pour {name}")
        if quantity == quantity_before:
            del self._stock[name]
        else:
            self._stock[name] = (quantity_before - quantity, price)

    def set_price(self, name, unit_price):
        quantity, _ = self._stock[name]
        self._stock[name] = (quantity, unit_price)

    def names(self):
        return sorted(self._stock)

    def total_value(self):
        # Plus de cache : la valeur est lue à la source, quel que soit qui modifie le stock.
        return sum(quantity * price for quantity, price in self._stock.values())
