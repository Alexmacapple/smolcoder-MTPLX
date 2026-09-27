"""Devis de peinture d'un mur."""

from geometrie import aire_rect

PRIX_M2 = 12


def devis_mur(largeur, hauteur):
    return aire_rect(largeur, hauteur) * PRIX_M2
