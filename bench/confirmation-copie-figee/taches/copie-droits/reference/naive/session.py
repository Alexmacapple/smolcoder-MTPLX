class Session:
    """Session ouverte par un utilisateur."""

    def __init__(self, user, roles):
        self.user_name = user.name
        self.role = user.role
        self.roles = roles

    def can(self, permission):
        return permission in self.roles.permissions(self.role)
