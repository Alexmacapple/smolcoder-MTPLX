import unittest

from stats import produit, produit_absolu


class TestStats(unittest.TestCase):
    def test_produit(self):
        self.assertEqual(produit([2, 3]), 6)
        self.assertEqual(produit([-2, 3]), 0)

    def test_produit_absolu(self):
        self.assertEqual(produit_absolu([-2, 3]), 6)


if __name__ == "__main__":
    unittest.main()
