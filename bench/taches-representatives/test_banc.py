"""Contrôles déterministes du banc #72, sans modèle ni MTPLX réel."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import core


class BancRepresentatifTest(unittest.TestCase):
    def test_protocole_et_pieces_sont_figes(self):
        self.assertEqual(core.controler_protocole(), [])

    def test_chaque_fixture_echoue_puis_sa_solution_passe(self):
        for task_id in core.plan()["tasks"]:
            with self.subTest(task=task_id), tempfile.TemporaryDirectory() as tmp:
                workspace = core.preparer_espace(task_id, Path(tmp))
                before = core.verifier(task_id, workspace)
                self.assertFalse(before["passed"])
                core.appliquer_solution(task_id, workspace)
                after = core.verifier(task_id, workspace)
                self.assertTrue(after["passed"], after)

    def test_classement_distingue_tous_les_statuts(self):
        ok = {"passed": True}
        ko = {"passed": False}
        stats = {
            "durationMs": 10,
            "modelCalls": 1,
            "toolCalls": 2,
            "generatedTokens": 3,
            "promptTokensLast": 4,
            "contextWindow": 8192,
        }
        self.assertEqual(core.classer(True, None, 0, stats, ok), "mtplx_indisponible")
        self.assertEqual(core.classer(False, None, 0, stats, ok), "blocage_harnais")
        self.assertEqual(core.classer(False, {}, 0, stats, ok), "blocage_harnais")
        self.assertEqual(core.classer(True, {}, 0, None, ok), "blocage_harnais")
        self.assertEqual(core.classer(True, {}, 0, stats, ok), "succes")
        self.assertEqual(core.classer(True, {}, 1, stats, ko), "echec_tache")
        self.assertEqual(
            core.classer(True, {}, 3, stats, ko, refus_securite=True),
            "refus_securite_attendu",
        )

    def test_stats_incompletes_ne_deviennent_jamais_une_reussite(self):
        complete = (
            '[stats] {"durationMs":10,"modelCalls":1,"toolCalls":2,'
            '"generatedTokens":3,"promptTokensLast":4,"contextWindow":8192}'
        )
        incomplete = '[stats] {"durationMs":10,"modelCalls":1}'
        self.assertIsNotNone(core.extraire_stats(complete))
        self.assertIsNone(core.extraire_stats(incomplete))


if __name__ == "__main__":
    unittest.main()
