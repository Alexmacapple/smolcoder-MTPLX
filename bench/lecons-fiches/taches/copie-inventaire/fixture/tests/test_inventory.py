import unittest

from inventory import Inventory


class InventoryTest(unittest.TestCase):
    def test_total_after_add(self):
        inventory = Inventory()
        inventory.add("vis", 10, 0.5)
        inventory.total_value()
        inventory.add("clou", 100, 0.3)
        self.assertAlmostEqual(inventory.total_value(), 35.0)

    def test_total_after_remove(self):
        inventory = Inventory()
        inventory.add("vis", 10, 0.5)
        inventory.add("clou", 100, 0.3)
        inventory.total_value()
        inventory.remove("clou", 50)
        self.assertAlmostEqual(inventory.total_value(), 20.0)


if __name__ == "__main__":
    unittest.main()
