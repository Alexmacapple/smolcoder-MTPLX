class Roles:
    """Permissions accordées à chaque rôle ; l'administrateur les change à chaud."""

    def __init__(self):
        self._grants = {}

    def grant(self, role, permission):
        self._grants.setdefault(role, set()).add(permission)

    def revoke(self, role, permission):
        self._grants.get(role, set()).discard(permission)

    def permissions(self, role):
        return set(self._grants.get(role, ()))
