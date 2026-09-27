class Document:
    """Texte en cours d'édition."""

    def __init__(self, text=""):
        self.text = text

    def append(self, text):
        self.text = f"{self.text} {text}".strip()

    def words(self):
        return self.text.split()
