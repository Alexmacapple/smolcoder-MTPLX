"""Mesures d'un essai (#19), lues dans la sortie d'erreur headless de smol."""
import json
import re
import sys

lignes = open(sys.argv[1], encoding="utf-8", errors="replace").read().splitlines()
appel = re.compile(r"^→ (\w+) ?(.*)$")
vus, relectures, journaux, echecs, apres_echec = set(), 0, 0, 0, 0
en_echec = set()  # chemins dont le dernier edit_file a échoué
stats, signaux = None, 0
for i, ligne in enumerate(lignes):
    if ligne.startswith("[stats] "):
        stats = json.loads(ligne[8:])
    if "was changed on disk after you last read it" in ligne:
        signaux += 1
    m = appel.match(ligne)
    if not m:
        continue
    outil, reste = m.groups()
    resultat = lignes[i + 1] if i + 1 < len(lignes) else ""
    chemin = re.sub(r" from line \d+$", "", reste).removeprefix("./")
    if outil == "read_file":
        if chemin.startswith("log:"):
            journaux += 1
            continue
        if chemin in vus:
            relectures += 1
        if chemin in en_echec:
            apres_echec += 1
        vus.add(chemin)
    elif outil == "edit_file":
        if resultat.lstrip().startswith("✗ Error: old_text"):
            echecs += 1
            en_echec.add(chemin)
        elif resultat.lstrip().startswith("✓"):
            en_echec.discard(chemin)
print(json.dumps({
    "appels_outils": stats and stats.get("toolCalls"),
    "appels_modele": stats and stats.get("modelCalls"),
    "duree_ms": stats and stats.get("durationMs"),
    "relectures": relectures,
    "lectures_journal": journaux,
    "echecs_edition": echecs,
    "relectures_apres_echec": apres_echec,
    "signaux_peremption": signaux,
}, ensure_ascii=False))
