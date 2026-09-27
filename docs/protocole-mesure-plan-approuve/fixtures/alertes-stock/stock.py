"""Gestion d'un petit stock : quantités par article."""


def total(stock):
    """Nombre total d'unités en stock."""
    return sum(stock.values())


def articles(stock):
    """Noms des articles, triés."""
    return sorted(stock)
