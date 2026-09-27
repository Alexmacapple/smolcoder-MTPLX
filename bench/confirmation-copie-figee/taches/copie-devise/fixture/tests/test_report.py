import unittest

import report
from rates import Rates
from trip import Trip


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.rates = Rates({"USD": 1.10, "GBP": 0.85})
        self.trip = Trip(self.rates, "USD")
        self.trip.add_expense("hôtel", 100)
        self.trip.add_expense("taxi", 20)

    def test_total_in_employee_currency(self):
        self.assertAlmostEqual(report.total(self.trip), 132.0)

    def test_total_follows_published_rate(self):
        self.rates.update("USD", 1.20)
        self.assertAlmostEqual(report.total(self.trip), 144.0)


if __name__ == "__main__":
    unittest.main()
