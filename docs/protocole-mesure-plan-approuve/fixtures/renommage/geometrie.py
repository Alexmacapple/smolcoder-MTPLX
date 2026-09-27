"""Calculs de surfaces."""


def aire_rect(largeur, hauteur):
    """Aire d'un rectangle."""
    return largeur * hauteur


def aire_carre(cote):
    """Aire d'un carré."""
    return aire_rect(cote, cote)
