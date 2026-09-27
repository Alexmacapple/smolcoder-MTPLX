import datetime
import unittest

from clock import CLOCK
from loans import is_late, lend


class LoansTest(unittest.TestCase):
    def setUp(self):
        CLOCK.set(datetime.date(2026, 1, 5))

    def test_new_loan_is_not_late(self):
        loan = lend("Dune", "ana")
        self.assertFalse(is_late(loan))

    def test_loan_is_late_after_four_weeks(self):
        loan = lend("Dune", "ana")
        CLOCK.advance(28)
        self.assertTrue(is_late(loan))


if __name__ == "__main__":
    unittest.main()
