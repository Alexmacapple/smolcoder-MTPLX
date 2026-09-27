"""Réglages de l'application, avec leurs valeurs par défaut."""

DEFAUTS = {"langue": "fr", "decimales": 2}


def charger(surcharges=None):
    reglages = dict(DEFAUTS)
    reglages.update(surcharges or {})
    return reglages
