import unittest

from durations import parse_duration


class ParseDurationTest(unittest.TestCase):
    def test_exemples(self):
        self.assertEqual(parse_duration("1h30"), 5400)
        self.assertEqual(parse_duration("45min"), 2700)

    def test_invalide(self):
        with self.assertRaises(ValueError):
            parse_duration("abc")


if __name__ == "__main__":
    unittest.main()
