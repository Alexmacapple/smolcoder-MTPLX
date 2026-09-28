class User:
    """Compte d'un utilisateur et son rôle courant."""

    def __init__(self, name, role):
        self.name = name
        self.role = role


def change_role(user, role):
    """Affecte un autre rôle à l'utilisateur ; il vaut aussi pour ses sessions ouvertes."""
    user.role = role
