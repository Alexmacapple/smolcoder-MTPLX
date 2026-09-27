import unittest

from inventory import Inventory
from promotions import apply_discount


class InventaireAcceptation(unittest.TestCase):
    def stock(self):
        inventory = Inventory()
        inventory.add("vis", 10, 0.5)
        inventory.add("clou", 100, 0.3)
        self.assertAlmostEqual(inventory.total_value(), 35.0)
        return inventory

    def test_retrait_partiel(self):
        inventory = self.stock()
        inventory.remove("clou", 50)
        self.assertAlmostEqual(inventory.total_value(), 20.0)

    def test_retrait_complet(self):
        inventory = self.stock()
        inventory.remove("clou", 100)
        self.assertAlmostEqual(inventory.total_value(), 5.0)

    def test_changement_de_prix(self):
        inventory = self.stock()
        inventory.set_price("vis", 1.0)
        self.assertAlmostEqual(inventory.total_value(), 40.0)

    def test_promotion(self):
        inventory = self.stock()
        apply_discount(inventory, "clou", 50)
        self.assertAlmostEqual(inventory.total_value(), 20.0)

    def test_ajout(self):
        inventory = self.stock()
        inventory.add("vis", 10, 0.5)
        self.assertAlmostEqual(inventory.total_value(), 40.0)
