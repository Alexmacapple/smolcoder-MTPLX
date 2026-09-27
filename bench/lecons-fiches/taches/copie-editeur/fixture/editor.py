from document import Document
from spellcheck import SpellChecker


class Editor:
    """Éditeur de texte avec vérification orthographique."""

    def __init__(self):
        self.document = Document()
        self.checker = SpellChecker(self.document)

    def type(self, text):
        self.document.append(text)

    def new_document(self):
        self.document = Document()

    def misspelled(self):
        return self.checker.misspelled()
