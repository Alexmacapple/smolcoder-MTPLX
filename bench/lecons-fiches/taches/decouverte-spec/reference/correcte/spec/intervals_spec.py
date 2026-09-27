import unittest

from intervals import merge_intervals


class MergeIntervalsSpec(unittest.TestCase):
    def test_exemple(self):
        self.assertEqual(
            merge_intervals([(1, 3), (2, 6), (8, 10), (10, 12)]), [(1, 6), (8, 12)]
        )

    def test_vide(self):
        self.assertEqual(merge_intervals([]), [])


if __name__ == "__main__":
    unittest.main()
