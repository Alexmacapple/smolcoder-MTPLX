import unittest

from colors import hex_to_rgb, rgb_to_hex


class ColorsSpec(unittest.TestCase):
    def test_hex_vers_rgb(self):
        self.assertEqual(hex_to_rgb("#ff8000"), (255, 128, 0))
        self.assertEqual(hex_to_rgb("00ff00"), (0, 255, 0))

    def test_rgb_vers_hex(self):
        self.assertEqual(rgb_to_hex(255, 128, 0), "#ff8000")

    def test_invalide(self):
        with self.assertRaises(ValueError):
            hex_to_rgb("#fff")


if __name__ == "__main__":
    unittest.main()
