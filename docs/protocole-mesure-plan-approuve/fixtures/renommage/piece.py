"""Une pièce rectangulaire."""

from geometrie import aire_rect


class Piece:
    def __init__(self, nom, largeur, hauteur):
        self.nom = nom
        self.largeur = largeur
        self.hauteur = hauteur

    def surface(self):
        return aire_rect(self.largeur, self.hauteur)
