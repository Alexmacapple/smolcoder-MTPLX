"""Rapport texte du stock."""

from stock import articles, total


def rapport(stock):
    lignes = [f"{nom} : {stock[nom]}" for nom in articles(stock)]
    lignes.append(f"Total : {total(stock)}")
    return "\n".join(lignes)
