import datetime
import unittest

from dates import is_weekend, next_business_day


class DatesTest(unittest.TestCase):
    def test_weekend(self):
        self.assertTrue(is_weekend(datetime.date(2026, 9, 26)))
        self.assertFalse(is_weekend(datetime.date(2026, 9, 28)))

    def test_vendredi_vers_lundi(self):
        self.assertEqual(
            next_business_day(datetime.date(2026, 9, 25)), datetime.date(2026, 9, 28)
        )


if __name__ == "__main__":
    unittest.main()
