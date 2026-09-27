import unittest

import app
import config


class TestApp(unittest.TestCase):
    def test_adresse(self):
        self.assertEqual(app.adresse(), "http://localhost:8080")

    def test_timeout(self):
        self.assertEqual(config.TIMEOUT, 30)

    def test_delai(self):
        self.assertEqual(app.delai(), 30)


if __name__ == "__main__":
    unittest.main()
