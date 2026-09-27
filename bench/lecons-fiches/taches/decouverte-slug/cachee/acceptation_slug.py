import unittest

from slug import slugify


class SlugifyAcceptation(unittest.TestCase):
    def test_exemple_de_la_demande(self):
        self.assertEqual(slugify("Été 2026 : Bilan !"), "ete-2026-bilan")

    def test_accents_et_cedille(self):
        self.assertEqual(slugify("Ça déçoit à peine"), "ca-decoit-a-peine")

    def test_suites_de_separateurs(self):
        self.assertEqual(slugify("  un -- deux//trois  "), "un-deux-trois")

    def test_chiffres(self):
        self.assertEqual(slugify("Version 2.0.1"), "version-2-0-1")

    def test_bords(self):
        self.assertEqual(slugify("!!Bonjour!!"), "bonjour")

    def test_vide(self):
        self.assertEqual(slugify(""), "")
