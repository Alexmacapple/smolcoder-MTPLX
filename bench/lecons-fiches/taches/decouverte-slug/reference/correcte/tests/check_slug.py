import unittest

from slug import slugify


class SlugifyTest(unittest.TestCase):
    def test_exemple(self):
        self.assertEqual(slugify("Été 2026 : Bilan !"), "ete-2026-bilan")

    def test_vide(self):
        self.assertEqual(slugify(""), "")


if __name__ == "__main__":
    unittest.main()
