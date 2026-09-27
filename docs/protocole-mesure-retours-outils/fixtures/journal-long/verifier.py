"""Vérificateur de la tâche journal-long (#19) : une ligne par cas."""
import sys

from calc import carre, double, maximum, minimum, moitie, moyenne, oppose, triple

n = 0
echecs = 0


def verifie(nom, obtenu, attendu):
    global n, echecs
    n += 1
    if obtenu == attendu:
        print(f"ok {n} - {nom}")
    else:
        echecs += 1
        print(f"not ok {n} - {nom}")
        print(f"  AssertionError: {nom} attendu {attendu!r}, obtenu {obtenu!r}")


for i in range(400):
    verifie(f"double({i})", double(i), 2 * i)
    verifie(f"triple({i})", triple(i), 3 * i)
    verifie(f"carre({i})", carre(i), i * i)
    verifie(f"oppose({i})", oppose(i), -i)
verifie("moyenne([2, 4])", moyenne([2, 4]), 3)
verifie("moyenne([2, 3])", moyenne([2, 3]), 2.5)
verifie("moyenne([1, 2, 3, 4])", moyenne([1, 2, 3, 4]), 2.5)
for i in range(1, 351):
    verifie(f"moitie({2 * i})", moitie(2 * i), i)
    verifie(f"maximum([0, {i}])", maximum([0, i]), i)
    verifie(f"minimum([0, {i}])", minimum([0, i]), 0)
    verifie(f"double({-i})", double(-i), -2 * i)
print(f"# {n} vérifications, {echecs} échec(s)")
sys.exit(1 if echecs else 0)
