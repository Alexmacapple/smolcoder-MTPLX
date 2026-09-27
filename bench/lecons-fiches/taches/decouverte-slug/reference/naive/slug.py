import re
import unicodedata


def slugify(texte):
    """Identifiant d'URL : minuscules, sans accents, mots séparés par un tiret."""
    sans_accents = (
        unicodedata.normalize("NFKD", texte).encode("ascii", "ignore").decode("ascii")
    )
    return re.sub(r"[^a-z0-9]+", "-", sans_accents.lower()).strip("-")
