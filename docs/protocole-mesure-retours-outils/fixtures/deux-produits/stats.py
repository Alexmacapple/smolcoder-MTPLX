def produit(valeurs):
    total = 1
    for v in valeurs:
        total *= v
    if total < 0:
        total = 0
    return total


def produit_absolu(valeurs):
    total = 1
    for v in valeurs:
        total *= abs(v)
    if total < 0:
        total = 0
    return total
