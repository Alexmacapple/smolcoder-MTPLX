import unittest

from format import montant

from config import charger


class TestSeparateur(unittest.TestCase):
    def test_defaut_virgule(self):
        self.assertEqual(montant(3.5, charger()), "3,50")

    def test_point(self):
        self.assertEqual(montant(3.5, charger({"separateur": "."})), "3.50")

    def test_decimales(self):
        self.assertEqual(montant(2, charger({"decimales": 0})), "2")

    def test_defaut_declare(self):
        self.assertEqual(charger()["separateur"], ",")


if __name__ == "__main__":
    unittest.main()
