def clamp(value, low, high):
    """Ramène value dans l'intervalle [low, high]."""
    if low > high:
        raise ValueError("low doit être inférieur ou égal à high")
    return max(low, min(value, high))


def mean(values):
    """Moyenne arithmétique d'une liste non vide."""
    if not values:
        raise ValueError("liste vide")
    return sum(values) / len(values)
