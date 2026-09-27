import unittest

from durations import parse_duration


class ParseDurationAcceptation(unittest.TestCase):
    def test_exemples_de_la_demande(self):
        self.assertEqual(parse_duration("2h"), 7200)
        self.assertEqual(parse_duration("45min"), 2700)
        self.assertEqual(parse_duration("1h05min"), 3900)
        self.assertEqual(parse_duration("1h30"), 5400)

    def test_heures_seules(self):
        self.assertEqual(parse_duration("10h"), 36000)

    def test_formes_invalides(self):
        for texte in ("", "abc", "1x"):
            with self.subTest(texte=texte), self.assertRaises(ValueError):
                parse_duration(texte)
