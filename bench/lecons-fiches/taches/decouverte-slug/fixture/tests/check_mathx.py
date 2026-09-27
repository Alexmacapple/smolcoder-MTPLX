import unittest

from mathx import clamp, mean


class ClampTest(unittest.TestCase):
    def test_inside(self):
        self.assertEqual(clamp(5, 0, 10), 5)

    def test_bounds(self):
        self.assertEqual(clamp(-3, 0, 10), 0)
        self.assertEqual(clamp(42, 0, 10), 10)


class MeanTest(unittest.TestCase):
    def test_mean(self):
        self.assertEqual(mean([1, 2, 3, 4]), 2.5)

    def test_empty(self):
        with self.assertRaises(ValueError):
            mean([])


if __name__ == "__main__":
    unittest.main()
