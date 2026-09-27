KNOWN = {"bonjour", "salut", "monde", "le", "la", "chat", "dort", "texte", "un", "une"}


class SpellChecker:
    """Relève les mots inconnus d'un document."""

    def __init__(self, document):
        self.document = document

    def misspelled(self):
        return [word for word in self.document.words() if word.lower() not in KNOWN]
