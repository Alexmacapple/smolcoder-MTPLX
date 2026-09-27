"""Export CSV des pièces."""

import geometrie


def ligne_csv(piece):
    return f"{piece.nom};{geometrie.aire_rect(piece.largeur, piece.hauteur)}"
