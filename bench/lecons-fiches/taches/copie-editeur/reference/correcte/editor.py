from document import Document
from spellcheck import SpellChecker


class Editor:
    """Éditeur de texte avec vérification orthographique."""

    def __init__(self):
        self.document = Document()

    def type(self, text):
        self.document.append(text)

    def new_document(self):
        self.document = Document()

    def misspelled(self):
        # Le vérificateur lit le document courant, quel que soit qui l'a remplacé.
        return SpellChecker(self.document).misspelled()
