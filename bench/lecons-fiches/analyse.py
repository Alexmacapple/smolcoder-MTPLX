#!/usr/bin/env python3
"""Analyse de l'étude #33 selon la règle pré-enregistrée (protocole.json).

Étape « aa » : seulement les séries A et A2 (bruit), sans lire la série B.
Étape « ab » : écart A/A, puis A/B et verdict KEEP / REJECT / INCONCLUSIVE
par leçon, GO / NO-GO global.

Usage : analyse.py <resultats> --sha <SHA du pré-enregistrement> --etape aa|ab
        [--json <fichier>] [--accepter-non-fige]
"""

import argparse
import json
import statistics
import sys
from fractions import Fraction
from pathlib import Path

ICI = Path(__file__).resolve().parent
COMPTES = {"succes", "echec_test", "echec_execution"}


def charger(resultats, sha, series, accepter_non_fige, protocole_sha):
    retenus, ecartes, doublons = {}, [], []
    for chemin in sorted(Path(resultats).glob("*/manifeste.json")):
        try:
            m = json.loads(chemin.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            ecartes.append((chemin.parent.name, "manifeste illisible"))
            continue
        if m.get("format") != "etude-lecons-fiches/v1":
            continue
        run = m["run"]
        if run["serie"] not in series:
            continue  # l'étape aa ne lit jamais la série B
        nom = chemin.parent.name
        if m["harness"]["repository_sha"] != sha:
            ecartes.append(
                (
                    nom,
                    f"SHA du harnais {m['harness']['repository_sha']} au lieu de {sha}",
                )
            )
            continue
        if m["harness"].get("working_tree_dirty") is not False:
            ecartes.append((nom, "arbre de travail du harnais modifié ou inconnu"))
            continue
        if protocole_sha and m["harness"].get("protocole_sha256") != protocole_sha:
            ecartes.append((nom, "protocole différent du protocole figé"))
            continue
        if not accepter_non_fige and not m["binaire"]["fige"]:
            ecartes.append((nom, "binaire non figé"))
            continue
        if m["status"] not in COMPTES:
            ecartes.append((nom, f"{m['status']} : {m['status_reason']}"))
            continue
        cle = (run["lecon"], run["tache"], run["serie"], run["repetition"])
        if cle in retenus:
            if (m["run"]["started_at"] or "") < (
                retenus[cle]["run"]["started_at"] or ""
            ):
                doublons.append(retenus[cle]["run"]["id"])
                retenus[cle] = m
            else:
                doublons.append(run["id"])
            continue
        retenus[cle] = m
    return retenus, ecartes, doublons


def resume_serie(manifestes):
    n = len(manifestes)
    succes = sum(1 for m in manifestes if m["status"] == "succes")
    g = [m.get("garanties") or {} for m in manifestes]
    mesures = [m.get("mesures") or {} for m in manifestes]
    durees = [
        m["execution"]["duration_seconds"]
        for m in manifestes
        if m["execution"]["duration_seconds"] is not None
    ]
    outils = [
        x.get("appels_outils_trace")
        for x in mesures
        if x.get("appels_outils_trace") is not None
    ]
    return {
        "n": n,
        "succes": succes,
        "taux": Fraction(succes, n) if n else None,
        "faux_succes": sum(1 for x in g if x.get("faux_succes")),
        "violations_securite": sum(1 for x in g if x.get("violation_securite")),
        "violations_perimetre": sum(1 for x in g if x.get("violation_perimetre")),
        "echecs_execution": sum(
            1 for m in manifestes if m["status"] == "echec_execution"
        ),
        "fiche_concernee_lue": sum(1 for x in mesures if x.get("fiche_concernee_lue")),
        "fiches_lues": sorted({f for x in mesures for f in x.get("fiches_lues", [])}),
        "duree_mediane_s": statistics.median(durees) if durees else None,
        "duree_totale_s": sum(durees),
        "appels_outils_moyen": round(statistics.mean(outils), 1) if outils else None,
        "relectures": sum(x.get("relectures", 0) for x in mesures),
        "refus_harnais": sum(x.get("refus_harnais", 0) for x in mesures),
        "commande_documentee_jouee": sum(
            1 for x in mesures if x.get("commande_documentee_jouee")
        ),
        "recherches": sum(x.get("recherches", 0) for x in mesures),
        "reussite_si_fiche_lue": (
            f"{sum(1 for m in manifestes if m['status'] == 'succes' and (m.get('mesures') or {}).get('fiche_concernee_lue'))}"
            f"/{sum(1 for x in mesures if x.get('fiche_concernee_lue'))}"
        ),
    }


def verdict(lecon, series_par_nom, par_tache, regle):
    a, a2, b = series_par_nom["A"], series_par_nom["A2"], series_par_nom["B"]
    motifs = []
    minimum = regle["essais_comptes_minimaux_par_serie"]
    regression = any(
        b[champ] > max(a[champ], a2[champ])
        for champ in ("faux_succes", "violations_securite", "violations_perimetre")
    )
    if min(a["n"], a2["n"], b["n"]) < minimum:
        motifs.append(f"moins de {minimum} essais comptés dans une série")
        return ("REJECT" if regression else "INCONCLUSIVE"), motifs, None
    delta = abs(a["taux"] - a2["taux"])
    a_max = max(a["taux"], a2["taux"])
    a_pool = Fraction(a["succes"] + a2["succes"], a["n"] + a2["n"])
    gain = b["taux"] - a_max
    gain_minimal = Fraction(regle["gain_minimal"])
    gagnantes, perdantes = [], []
    for tache, s in par_tache.items():
        if s["B"]["taux"] is None or s["A"]["taux"] is None or s["A2"]["taux"] is None:
            continue
        if s["B"]["taux"] > max(s["A"]["taux"], s["A2"]["taux"]):
            gagnantes.append(tache)
        if s["B"]["taux"] < min(s["A"]["taux"], s["A2"]["taux"]):
            perdantes.append(tache)
    conditions = {
        "k1 gain > écart A/A": gain > delta,
        "k2 gain ≥ gain minimal": gain >= gain_minimal,
        "k3 tâches gagnantes": len(gagnantes) >= regle["taches_gagnantes_minimales"]
        and not perdantes,
        "k4 garanties": b["faux_succes"] == 0
        and b["violations_securite"] == 0
        and not regression,
        "k5 exposition": b["fiche_concernee_lue"] >= regle["exposition_minimale_b"],
    }
    chiffres = {
        "ecart_aa": str(delta),
        "a_max": str(a_max),
        "a_pool": str(a_pool),
        "taux_b": str(b["taux"]),
        "gain": str(gain),
        "taches_gagnantes": gagnantes,
        "taches_perdantes": perdantes,
        "regression_garantie": regression,
        "conditions": conditions,
    }
    if all(conditions.values()):
        return "KEEP", [k for k, v in conditions.items()], chiffres
    motifs = [k for k, v in conditions.items() if not v]
    if b["taux"] <= a_pool or regression:
        return "REJECT", motifs, chiffres
    return "INCONCLUSIVE", motifs, chiffres


def fr(x):
    if isinstance(x, Fraction):
        return (
            f"{x.numerator}/{x.denominator}" if x.denominator != 1 else str(x.numerator)
        )
    return str(x)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("resultats")
    parser.add_argument("--sha", required=True)
    parser.add_argument("--etape", choices=["aa", "ab"], required=True)
    parser.add_argument("--json")
    parser.add_argument("--accepter-non-fige", action="store_true")
    parser.add_argument("--protocole", default=str(ICI / "protocole.json"))
    args = parser.parse_args()
    import hashlib

    protocole_octets = Path(args.protocole).read_bytes()
    protocole = json.loads(protocole_octets)
    protocole_sha = hashlib.sha256(protocole_octets).hexdigest()
    series = ["A", "A2"] if args.etape == "aa" else ["A", "A2", "B"]
    retenus, ecartes, doublons = charger(
        args.resultats, args.sha, set(series), args.accepter_non_fige, protocole_sha
    )
    sortie = {
        "etape": args.etape,
        "sha": args.sha,
        "lecons": {},
        "ecartes": ecartes,
        "doublons": doublons,
    }
    lignes = [f"Étape {args.etape}, SHA {args.sha}"]
    verdicts = []
    for lecon, definition in protocole["lecons"].items():
        par_serie = {}
        par_tache = {}
        for serie in series:
            ms = [m for (l, t, s, r), m in retenus.items() if l == lecon and s == serie]
            par_serie[serie] = resume_serie(ms)
            for tache in definition["taches"]:
                mt = [
                    m
                    for (l, t, s, r), m in retenus.items()
                    if l == lecon and s == serie and t == tache
                ]
                par_tache.setdefault(tache, {})[serie] = resume_serie(mt)
        attendus = len(definition["taches"]) * protocole["repetitions"]
        lignes.append("")
        lignes.append(f"Leçon {lecon} (fiche {definition['fiche']})")
        for serie in series:
            s = par_serie[serie]
            lignes.append(
                f"- série {serie} : {s['succes']}/{s['n']} réussites (comptés {s['n']}/{attendus}), "
                f"faux succès {s['faux_succes']}, sécurité {s['violations_securite']}, périmètre {s['violations_perimetre']}, "
                f"échecs d'exécution {s['echecs_execution']}, fiche concernée lue {s['fiche_concernee_lue']}/{s['n']}, "
                f"réussite si fiche lue {s['reussite_si_fiche_lue']}, durée médiane {s['duree_mediane_s']} s, "
                f"appels d'outils moyens {s['appels_outils_moyen']}, relectures {s['relectures']}, refus du harnais {s['refus_harnais']}, "
                f"commande documentée jouée {s['commande_documentee_jouee']}, recherches {s['recherches']}"
            )
        for tache, s in par_tache.items():
            lignes.append(
                "  - "
                + tache
                + " : "
                + ", ".join(
                    f"{serie} {s[serie]['succes']}/{s[serie]['n']}" for serie in series
                )
            )
        entree = {
            "series": {k: {**v, "taux": fr(v["taux"])} for k, v in par_serie.items()},
            "taches": {
                t: {k: {"succes": v["succes"], "n": v["n"]} for k, v in s.items()}
                for t, s in par_tache.items()
            },
        }
        if par_serie["A"]["taux"] is not None and par_serie["A2"]["taux"] is not None:
            ecart = abs(par_serie["A"]["taux"] - par_serie["A2"]["taux"])
            entree["ecart_aa"] = fr(ecart)
            lignes.append(
                f"  Écart A/A : |{fr(par_serie['A']['taux'])} − {fr(par_serie['A2']['taux'])}| = {fr(ecart)}"
            )
        if args.etape == "ab":
            resultat, motifs, chiffres = verdict(
                lecon, par_serie, par_tache, protocole["regle"]
            )
            verdicts.append(resultat)
            entree["verdict"] = resultat
            entree["motifs"] = motifs
            entree["chiffres"] = chiffres
            lignes.append(f"  Verdict : {resultat}")
            if chiffres:
                lignes.append(
                    f"  gain = {chiffres['taux_b']} − {chiffres['a_max']} = {chiffres['gain']} ; écart A/A {chiffres['ecart_aa']} ; "
                    f"A regroupé {chiffres['a_pool']} ; tâches gagnantes {chiffres['taches_gagnantes'] or 'aucune'} ; "
                    f"tâches perdantes {chiffres['taches_perdantes'] or 'aucune'}"
                )
                for condition, tenue in chiffres["conditions"].items():
                    lignes.append(
                        f"    {condition} : {'tenue' if tenue else 'non tenue'}"
                    )
            else:
                lignes.append(f"  Motifs : {', '.join(motifs)}")
        sortie["lecons"][lecon] = entree
    if args.etape == "ab":
        sortie["verdict_global"] = "GO" if "KEEP" in verdicts else "NO-GO"
        lignes.append("")
        lignes.append(f"Verdict global : {sortie['verdict_global']}")
    lignes.append("")
    lignes.append(f"Essais écartés : {len(ecartes)}")
    for nom, raison in ecartes:
        lignes.append(f"- {nom} : {raison}")
    if doublons:
        lignes.append(
            f"Doublons ignorés (cellule déjà comptée) : {', '.join(doublons)}"
        )
    print("\n".join(lignes))
    if args.json:
        Path(args.json).write_text(
            json.dumps(sortie, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )


if __name__ == "__main__":
    sys.exit(main())
