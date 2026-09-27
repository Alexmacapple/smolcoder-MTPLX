import unittest

import log
import settings


class LogTest(unittest.TestCase):
    def tearDown(self):
        settings.set_level("INFO")

    def test_info_by_default(self):
        sink = []
        log.emit("DEBUG", "caché", sink)
        log.emit("INFO", "visible", sink)
        self.assertEqual(sink, ["[INFO] visible"])

    def test_level_change_applies(self):
        settings.set_level("DEBUG")
        sink = []
        log.emit("DEBUG", "détail", sink)
        self.assertEqual(sink, ["[DEBUG] détail"])


if __name__ == "__main__":
    unittest.main()
