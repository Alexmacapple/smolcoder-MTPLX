import datetime
import unittest

from clock import CLOCK
from fines import fine
from loans import is_late, lend


class EcheanceAcceptation(unittest.TestCase):
    def setUp(self):
        CLOCK.set(datetime.date(2026, 1, 5))

    def test_retard_apres_quatre_semaines(self):
        loan = lend("Dune", "ana")
        CLOCK.advance(28)
        self.assertTrue(is_late(loan))

    def test_penalite_du_jour(self):
        loan = lend("Dune", "ana")
        CLOCK.advance(31)  # dix jours après l'échéance
        self.assertAlmostEqual(fine(loan), 2.0)

    def test_rien_a_l_echeance(self):
        loan = lend("Dune", "ana")
        CLOCK.advance(21)
        self.assertFalse(is_late(loan))
        self.assertAlmostEqual(fine(loan), 0.0)

    def test_pret_consenti_plus_tard(self):
        CLOCK.advance(40)
        loan = lend("Dune", "ana")
        self.assertEqual(loan.start, CLOCK.today())
        CLOCK.advance(25)  # quatre jours après l'échéance
        self.assertTrue(is_late(loan))
        self.assertAlmostEqual(fine(loan), 0.8)

    def test_dates_explicites(self):
        loan = lend("Dune", "ana", datetime.date(2026, 3, 1))
        self.assertFalse(is_late(loan, datetime.date(2026, 3, 22)))
        self.assertTrue(is_late(loan, datetime.date(2026, 3, 23)))
        self.assertAlmostEqual(fine(loan, datetime.date(2026, 3, 27)), 1.0)
