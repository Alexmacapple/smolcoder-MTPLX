"""Affiche un montant avec les réglages par défaut."""

import sys

from format import montant

from config import charger

if __name__ == "__main__":
    print(montant(float(sys.argv[1]), charger()))
