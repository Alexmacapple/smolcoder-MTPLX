import unittest

import audit
import log
import settings


class NiveauAcceptation(unittest.TestCase):
    def tearDown(self):
        settings.set_level("INFO")

    def test_journal_suit_le_niveau(self):
        settings.set_level("DEBUG")
        sink = []
        log.emit("DEBUG", "détail", sink)
        self.assertEqual(sink, ["[DEBUG] détail"])

    def test_audit_suit_le_niveau(self):
        settings.set_level("DEBUG")
        self.assertTrue(audit.detailed())
        sink = []
        audit.record("import", sink)
        self.assertEqual(sink, ["audit : import (détail)"])

    def test_niveau_releve(self):
        settings.set_level("ERROR")
        self.assertFalse(log.enabled("WARNING"))
        self.assertTrue(log.enabled("ERROR"))

    def test_retour_au_niveau_info(self):
        settings.set_level("DEBUG")
        settings.set_level("INFO")
        self.assertFalse(audit.detailed())
        self.assertFalse(log.enabled("DEBUG"))
