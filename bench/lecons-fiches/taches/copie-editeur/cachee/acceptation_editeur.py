import unittest

from editor import Editor
from files import open_text, save_text


class EditeurAcceptation(unittest.TestCase):
    def test_texte_ouvert_verifie(self):
        editor = Editor()
        editor.type("salut")
        open_text(editor, "le chatt dort")
        self.assertEqual(editor.misspelled(), ["chatt"])

    def test_saisie_apres_ouverture(self):
        editor = Editor()
        open_text(editor, "le chat")
        editor.type("dortt")
        self.assertEqual(editor.misspelled(), ["dortt"])
        self.assertEqual(save_text(editor), "le chat dortt")

    def test_nouveau_document_apres_ouverture(self):
        editor = Editor()
        open_text(editor, "bonjourr")
        editor.new_document()
        editor.type("salut")
        self.assertEqual(editor.misspelled(), [])

    def test_nouveau_document(self):
        editor = Editor()
        editor.type("bonjour")
        editor.new_document()
        editor.type("chatt")
        self.assertEqual(editor.misspelled(), ["chatt"])
