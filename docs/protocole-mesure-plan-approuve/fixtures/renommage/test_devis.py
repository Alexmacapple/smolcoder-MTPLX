import unittest

import geometrie
from devis import devis_mur
from export import ligne_csv
from piece import Piece


class TestRenommage(unittest.TestCase):
    def test_nouveau_nom(self):
        self.assertEqual(geometrie.aire_rectangle(3, 4), 12)

    def test_ancien_nom_retire(self):
        self.assertFalse(hasattr(geometrie, "aire_" + "rect"))

    def test_carre(self):
        self.assertEqual(geometrie.aire_carre(3), 9)

    def test_piece(self):
        self.assertEqual(Piece("salon", 4, 5).surface(), 20)

    def test_devis(self):
        self.assertEqual(devis_mur(2, 3), 72)

    def test_export(self):
        self.assertEqual(ligne_csv(Piece("bureau", 3, 3)), "bureau;9")


if __name__ == "__main__":
    unittest.main()
