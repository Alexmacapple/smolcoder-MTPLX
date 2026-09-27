def apply_discount(inventory, name, percent):
    """Baisse le prix unitaire d'un article de percent %."""
    quantity, price = inventory._stock[name]
    inventory._stock[name] = (quantity, round(price * (100 - percent) / 100, 2))
