from document import Document


def open_text(editor, text):
    """Ouvre un texte dans l'éditeur : il remplace le document courant."""
    editor.document = Document(text)


def save_text(editor):
    """Renvoie le texte du document courant, tel qu'il serait enregistré."""
    return editor.document.text
