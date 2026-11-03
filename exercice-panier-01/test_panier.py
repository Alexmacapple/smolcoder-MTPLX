import unittest

from panier import total


class TestPanier(unittest.TestCase):
    def test_trois_articles(self):
        self.assertEqual(total(10, 3), 30)

    def test_un_article(self):
        self.assertEqual(total(10, 1), 10)

    def test_zero_article(self):
        self.assertEqual(total(10, 0), 0)
