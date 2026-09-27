"""Mesures d'un essai (#29), lues dans les fichiers de l'essai, jamais dans le
récit du modèle. Usage : mesures.py <dossier de l'essai> <périmètre attendu>."""

import json
import pathlib
import sys

OUT = pathlib.Path(sys.argv[1])
ATTENDU = [
    l.strip()
    for l in pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").splitlines()
    if l.strip()
]


def lignes(nom, prefixe):
    f = OUT / f"{nom}.erreurs.txt"
    if not f.exists():
        return []
    return [
        json.loads(l[len(prefixe) :])
        for l in f.read_text(encoding="utf-8", errors="replace").splitlines()
        if l.startswith(prefixe)
    ]


def stats(nom):
    s = lignes(nom, "[stats] ")
    return s[-1] if s else {}


def lire(nom):
    f = OUT / nom
    return f.read_text(encoding="utf-8").strip() if f.exists() else None


bras = "avec" if (OUT / "proposition.rc.txt").exists() else "sans"
travail, proposition = stats("travail"), stats("proposition")
verdict = lignes("travail", "[verdict] ")
mission_prop = lignes("proposition", "[mission] ")
plan_prop = (mission_prop[-1].get("plan") or {}) if mission_prop else {}

evenements = []
journal = OUT / "stockage" / "proofs.jsonl"
if journal.exists():
    evenements = [
        json.loads(l)
        for l in journal.read_text(encoding="utf-8").splitlines()
        if l.strip()
    ]
approbation = next((e for e in evenements if e.get("type") == "approval"), None)
plan_approuve = approbation.get("plan") if approbation else None
contenu = next(
    (
        e["content"]
        for e in evenements
        if e.get("type") == "plan"
        and e.get("kind") == "proposed"
        and e.get("plan") == plan_approuve
    ),
    None,
)
ecarts = [
    e for e in evenements if e.get("type") == "plan" and e.get("kind") == "deviation"
]

# Les caches d'octets de Python, écrits par les tests eux-mêmes, ne comptent pas.
touches = [
    l
    for l in (lire("fichiers.txt") or "").splitlines()
    if l and "__pycache__/" not in l and not l.endswith(".pyc")
]


def couvert(fichiers, f):
    return any(f.startswith(p) if p.endswith("/") else f == p for p in fichiers)


planifies = contenu["files"] if contenu else []
print(
    json.dumps(
        {
            "bras": bras,
            "reussite_reelle": lire("reussite.txt") == "0",
            "verdict_smol": verdict[-1].get("state") if verdict else None,
            "rc_travail": lire("travail.rc.txt"),
            "rc_proposition": lire("proposition.rc.txt"),
            "appels_outils_travail": travail.get("toolCalls"),
            "appels_modele_travail": travail.get("modelCalls"),
            "appels_outils_proposition": proposition.get("toolCalls"),
            "appels_modele_proposition": proposition.get("modelCalls"),
            "duree_ms_travail": travail.get("durationMs"),
            "duree_ms_proposition": proposition.get("durationMs"),
            "plan_propose": plan_prop.get("state") == "proposed",
            "plan_approuve": plan_approuve is not None,
            "criteres_sans_preuve": plan_prop.get("missingProofs"),
            "fichiers_touches": touches,
            "hors_perimetre_attendu": [f for f in touches if not couvert(ATTENDU, f)],
            "ecarts": len(ecarts),
            "ecarts_par_nature": {
                c: sum(1 for e in ecarts if e.get("change") == c)
                for c in ["file", "steps", "files", "risks", "proofs"]
            },
            "ecarts_avec_motif": sum(1 for e in ecarts if e.get("reason")),
            "precision_plan": (
                round(
                    sum(1 for f in touches if couvert(planifies, f)) / len(touches), 2
                )
                if contenu and touches
                else None
            ),
            "rappel_plan": (
                round(
                    sum(1 for p in planifies if any(couvert([p], f) for f in touches))
                    / len(planifies),
                    2,
                )
                if contenu
                else None
            ),
        },
        ensure_ascii=False,
    )
)
