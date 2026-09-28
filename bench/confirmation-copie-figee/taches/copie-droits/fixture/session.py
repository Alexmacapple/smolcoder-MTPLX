class Session:
    """Session ouverte par un utilisateur."""

    def __init__(self, user, roles):
        self.user_name = user.name
        self.role = user.role
        self.permissions = roles.permissions(user.role)

    def can(self, permission):
        return permission in self.permissions
