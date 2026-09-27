import unittest

from rapport import rapport
from stock import alertes, total


class TestStock(unittest.TestCase):
    def test_total(self):
        self.assertEqual(total({"a": 2, "b": 3}), 5)

    def test_alertes(self):
        self.assertEqual(
            alertes({"vis": 2, "clou": 10, "boulon": 0}, 3), ["boulon", "vis"]
        )

    def test_rapport_avec_seuil(self):
        self.assertTrue(
            rapport({"vis": 2, "clou": 10}, seuil=3).endswith("\nAlertes : vis")
        )

    def test_rapport_sans_seuil(self):
        self.assertEqual(rapport({"vis": 2}), "vis : 2\nTotal : 2")


if __name__ == "__main__":
    unittest.main()
