import unittest

from service import endpoint


class ServiceTest(unittest.TestCase):
    def test_endpoint_has_one_separator(self):
        self.assertEqual(
            endpoint("http://localhost:8000/", "/health"),
            "http://localhost:8000/health",
        )


if __name__ == "__main__":
    unittest.main()
