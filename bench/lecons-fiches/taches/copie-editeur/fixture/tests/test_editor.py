import unittest

from editor import Editor


class EditorTest(unittest.TestCase):
    def test_typing_is_checked(self):
        editor = Editor()
        editor.type("bonjour mondee")
        self.assertEqual(editor.misspelled(), ["mondee"])

    def test_new_document_is_checked(self):
        editor = Editor()
        editor.type("bonjour")
        editor.new_document()
        editor.type("chatt")
        self.assertEqual(editor.misspelled(), ["chatt"])


if __name__ == "__main__":
    unittest.main()
