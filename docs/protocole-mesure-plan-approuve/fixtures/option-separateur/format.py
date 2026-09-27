"""Mise en forme des montants."""


def montant(valeur, reglages):
    return f"{valeur:.{reglages['decimales']}f}"
