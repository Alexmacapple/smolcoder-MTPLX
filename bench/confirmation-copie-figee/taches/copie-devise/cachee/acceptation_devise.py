import unittest

import refund
import report
from rates import Rates
from trip import Trip


class DeviseAcceptation(unittest.TestCase):
    def setUp(self):
        self.rates = Rates({"USD": 1.10, "GBP": 0.85})
        self.trip = Trip(self.rates, "USD")
        self.trip.add_expense("hôtel", 100)
        self.trip.add_expense("taxi", 20)

    def test_total_initial(self):
        self.assertAlmostEqual(report.total(self.trip), 132.0)

    def test_total_au_nouveau_taux(self):
        self.rates.update("USD", 1.20)
        self.assertAlmostEqual(report.total(self.trip), 144.0)

    def test_lignes_au_nouveau_taux(self):
        self.rates.update("USD", 1.20)
        self.assertEqual(
            report.lines(self.trip), ["hôtel : 120.00 USD", "taxi : 24.00 USD"]
        )

    def test_reste_du_au_nouveau_taux(self):
        self.rates.update("USD", 1.20)
        self.assertAlmostEqual(refund.balance(self.trip, 50.0), 94.0)

    def test_changement_de_devise_puis_de_taux(self):
        self.trip.change_currency("GBP")
        self.assertAlmostEqual(report.total(self.trip), 102.0)
        self.rates.update("GBP", 0.90)
        self.assertAlmostEqual(report.total(self.trip), 108.0)
        self.assertAlmostEqual(refund.balance(self.trip, 8.0), 100.0)
