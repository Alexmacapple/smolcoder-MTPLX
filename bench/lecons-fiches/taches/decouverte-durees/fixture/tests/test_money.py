import unittest

from money import format_eur


class FormatEurTest(unittest.TestCase):
    def test_milliers(self):
        self.assertEqual(format_eur(123456), "1 234,56 €")

    def test_centimes(self):
        self.assertEqual(format_eur(5), "0,05 €")

    def test_negatif(self):
        self.assertEqual(format_eur(-250), "-2,50 €")


if __name__ == "__main__":
    unittest.main()
