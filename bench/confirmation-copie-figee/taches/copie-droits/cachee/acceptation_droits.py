import unittest

from documents import publish
from roles import Roles
from session import Session
from users import User, change_role


class DroitsAcceptation(unittest.TestCase):
    def setUp(self):
        self.roles = Roles()
        self.roles.grant("editor", "read")
        self.roles.grant("editor", "publish")
        self.roles.grant("reader", "read")
        self.ana = User("ana", "editor")

    def test_retrait_refuse(self):
        session = Session(self.ana, self.roles)
        self.roles.revoke("editor", "publish")
        self.assertFalse(session.can("publish"))
        self.assertTrue(session.can("read"))

    def test_ajout_accorde(self):
        session = Session(self.ana, self.roles)
        self.roles.grant("editor", "archive")
        self.assertTrue(session.can("archive"))

    def test_publication_refusee_apres_retrait(self):
        session = Session(self.ana, self.roles)
        self.roles.revoke("editor", "publish")
        journal = []
        with self.assertRaises(PermissionError):
            publish(session, "rapport", journal)
        self.assertEqual(journal, [])

    def test_role_retire(self):
        session = Session(self.ana, self.roles)
        change_role(self.ana, "reader")
        self.assertFalse(session.can("publish"))
        self.assertTrue(session.can("read"))

    def test_role_promu(self):
        bob = User("bob", "reader")
        session = Session(bob, self.roles)
        change_role(bob, "editor")
        journal = []
        publish(session, "rapport", journal)
        self.assertEqual(journal, ["bob publie rapport"])
