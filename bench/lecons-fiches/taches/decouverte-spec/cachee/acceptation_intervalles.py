import unittest

from intervals import merge_intervals


def couples(resultat):
    return [tuple(couple) for couple in resultat]


class MergeIntervalsAcceptation(unittest.TestCase):
    def test_exemple_de_la_demande(self):
        self.assertEqual(
            couples(merge_intervals([(1, 3), (2, 6), (8, 10), (10, 12)])),
            [(1, 6), (8, 12)],
        )

    def test_liste_vide(self):
        self.assertEqual(couples(merge_intervals([])), [])

    def test_entree_non_triee(self):
        self.assertEqual(couples(merge_intervals([(8, 10), (1, 3)])), [(1, 3), (8, 10)])

    def test_intervalle_inclus(self):
        self.assertEqual(couples(merge_intervals([(1, 10), (2, 3)])), [(1, 10)])

    def test_intervalles_qui_se_touchent(self):
        self.assertEqual(couples(merge_intervals([(1, 2), (2, 3)])), [(1, 3)])
