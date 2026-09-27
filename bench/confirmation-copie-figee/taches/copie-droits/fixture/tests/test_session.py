import unittest

from roles import Roles
from session import Session
from users import User


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.roles = Roles()
        self.roles.grant("editor", "read")
        self.roles.grant("editor", "publish")
        self.roles.grant("reader", "read")
        self.user = User("ana", "editor")

    def test_editor_can_publish(self):
        session = Session(self.user, self.roles)
        self.assertTrue(session.can("publish"))

    def test_revoked_permission_is_refused(self):
        session = Session(self.user, self.roles)
        self.roles.revoke("editor", "publish")
        self.assertFalse(session.can("publish"))


if __name__ == "__main__":
    unittest.main()
