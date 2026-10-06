import unittest

from invoice import total


class InvoiceTest(unittest.TestCase):
    def test_total_uses_quantities(self):
        lines = [{"unit_price": 10, "quantity": 2}]
        self.assertEqual(total(lines, 0.2), 24.0)


if __name__ == "__main__":
    unittest.main()
