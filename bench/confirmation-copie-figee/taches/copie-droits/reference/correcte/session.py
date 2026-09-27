class Session:
    """Session ouverte par un utilisateur."""

    def __init__(self, user, roles):
        self.user = user
        self.roles = roles

    @property
    def user_name(self):
        return self.user.name

    def can(self, permission):
        # Rôle et permissions lus à la source à chaque contrôle : un retrait,
        # un ajout ou un changement de rôle vaut aussi pour la session ouverte.
        return permission in self.roles.permissions(self.user.role)
