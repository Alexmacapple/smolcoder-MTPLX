#!/usr/bin/env python3
"""Analyse de la mesure appariée de #29 selon la règle de décision figée du
protocole (docs/protocole-mesure-plan-approuve.md, « Règle de décision »),
lue dans les manifestes bruts, jamais dans le récit du modèle. Les
précisions opératoires sont celles des écarts déclarés du rapport
(docs/mesure-plan-approuve-2026-09-27.md), commités avant le premier essai.

Étape « reussites » : validité et réussites seulement, et décision
d'extension (point 6), sans lire les autres mesures.
Étape « verdict » : les sept points de la règle, puis les mesures
descriptives, qui ne décident pas.

Usage : analyse.py <resultats> --sha <SHA> --etape reussites|verdict
        [--json <fichier>] [--extension-de <tâche>] [--plan <plan.json>]
"""

import argparse
import hashlib
import json
import math
import os
import statistics
import sys
from fractions import Fraction
from pathlib import Path

ICI = Path(__file__).resolve().parent
FORMAT_ESSAI = "mesure-plan-approuve/v1"
BRAS = ("sans", "avec")


def lire(chemin):
    try:
        return json.loads(Path(chemin).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def charger(resultats, sha, plan_sha):
    """Essais de ce SHA, arbre propre et plan figé, par cellule."""
    essais, ecartes = {}, []
    for chemin in sorted(Path(resultats).glob("*/manifeste.json")):
        m = lire(chemin)
        if not isinstance(m, dict) or m.get("format") != FORMAT_ESSAI:
            continue
        nom = chemin.parent.name
        h = m.get("harness", {})
        if h.get("repository_sha") != sha:
            ecartes.append(
                (nom, f"SHA du harnais {h.get('repository_sha')} au lieu de {sha}")
            )
            continue
        # MESURE_ACCEPTER_MODIFIE=1 : réservé à test-mesure.sh (runner pas
        # encore commité) ; jamais pour la campagne réelle.
        if (
            h.get("working_tree_dirty") is not False
            and os.environ.get("MESURE_ACCEPTER_MODIFIE") != "1"
        ):
            ecartes.append((nom, "arbre de travail du harnais modifié ou inconnu"))
            continue
        if plan_sha and h.get("plan_sha256") != plan_sha:
            ecartes.append((nom, "plan différent du plan figé"))
            continue
        r = m["run"]
        essais.setdefault((r["tache"], r["paire"], r["bras"]), []).append(m)
    for groupe in essais.values():
        groupe.sort(
            key=lambda x: (
                x["run"].get("tentative") or 1,
                x["run"].get("started_at") or x["run"]["id"],
            )
        )
    return essais, ecartes


def retenir(tentatives):
    """Premier essai valide parmi les deux premières tentatives (jeu, puis
    rejeu à la même place) ; les invalides sont déclarés, l'excédent ignoré."""
    retenu, invalides, ignores = None, [], []
    for i, m in enumerate(tentatives):
        if i >= 2:
            ignores.append(m)
        elif m.get("valide"):
            if retenu is None:
                retenu = m
            else:
                ignores.append(m)
        else:
            invalides.append(m)
    return retenu, invalides, ignores


def paires_valides(essais, taches, derniere):
    """tâche -> {paire: {"sans": manifeste, "avec": manifeste}} pour les paires
    dont les deux essais retenus sont valides et servis par le même modèle."""
    resultat = {t: {} for t in taches}
    ecartees = []
    for t in taches:
        for p in range(1, derniere + 1):
            if not any(essais.get((t, p, b)) for b in BRAS):
                continue
            retenus = {b: retenir(essais.get((t, p, b), []))[0] for b in BRAS}
            if any(v is None for v in retenus.values()):
                ecartees.append((t, p, "un essai de la paire reste invalide ou manque"))
                continue
            if (
                retenus["sans"]["server"]["model_id"]
                != retenus["avec"]["server"]["model_id"]
            ):
                ecartees.append((t, p, "modèle différent dans la paire"))
                continue
            resultat[t][p] = retenus
    return resultat, ecartees


def reussites(paires):
    return {
        b: sum(1 for v in paires.values() if v[b].get("reussite_reelle")) for b in BRAS
    }


def etape_reussites(plan, essais):
    base = plan["paires"]
    par_tache, _ = paires_valides(essais, plan["taches"], base)
    sortie = {}
    for t in plan["taches"]:
        n = len(par_tache[t])
        r = reussites(par_tache[t])
        sortie[t] = {
            "paires_valides_base": n,
            "reussites_sans": r["sans"],
            "reussites_avec": r["avec"],
            "ecart": r["avec"] - r["sans"],
            "extension_permise": n >= plan["paires_valides_minimales"]
            and abs(r["avec"] - r["sans"]) == 1,
        }
    return sortie


def mesure(m, cle):
    return (m.get("mesures") or {}).get(cle)


def mediane(valeurs):
    valeurs = [v for v in valeurs if v is not None]
    return statistics.median(valeurs) if valeurs else None


def fr(x):
    if isinstance(x, Fraction):
        return (
            f"{x.numerator}/{x.denominator}" if x.denominator != 1 else str(x.numerator)
        )
    return str(x)


def appels_modele(m):
    """Appels au modèle d'un essai : travail, plus proposition pour le bras
    avec plan ; None si un compte manque."""
    travail = mesure(m, "appels_modele_travail_retenus")
    if m["run"]["bras"] == "avec":
        prop = mesure(m, "appels_modele_proposition")
        return None if travail is None or prop is None else travail + prop
    return travail


def trace_run(m, nom):
    return ((m.get("execution") or {}).get(nom) or {}).get("trace") or {}


def resume_bras(ms):
    """Mesures descriptives d'un bras sur une tâche : publiées, ne décident pas."""
    precisions = [mesure(m, "precision_plan") for m in ms]
    rappels = [mesure(m, "rappel_plan") for m in ms]
    travail = [trace_run(m, "travail") for m in ms]
    ecarts = {
        c: sum((mesure(m, "ecarts_par_nature") or {}).get(c, 0) for m in ms)
        for c in ["file", "steps", "files", "risks", "proofs"]
    }
    return {
        "n": len(ms),
        "reussites": sum(1 for m in ms if m.get("reussite_reelle")),
        "paires_reussies": [m["run"]["paire"] for m in ms if m.get("reussite_reelle")],
        "verdict_verified": sum(
            1 for m in ms if mesure(m, "verdict_smol") == "verified"
        ),
        "verdict_accord_reussite": sum(
            1
            for m in ms
            if (mesure(m, "verdict_smol") == "verified")
            == bool(m.get("reussite_reelle"))
        ),
        "codes_travail": [mesure(m, "rc_travail") for m in ms],
        "delais_depasses_travail": sum(
            1 for m in ms if str(mesure(m, "rc_travail")) in {"124", "137", "143"}
        ),
        "appels_outils_travail": [
            mesure(m, "appels_outils_travail_retenus") for m in ms
        ],
        "appels_modele_travail": [
            mesure(m, "appels_modele_travail_retenus") for m in ms
        ],
        "appels_outils_proposition": [
            mesure(m, "appels_outils_proposition") for m in ms
        ],
        "appels_modele_proposition": [
            mesure(m, "appels_modele_proposition") for m in ms
        ],
        "sources_hors_stats": sum(
            1
            for m in ms
            if mesure(m, "source_appels_modele_travail") != "stats"
            or mesure(m, "source_appels_outils_travail") != "stats"
        ),
        "duree_murale_s": [
            (m.get("execution") or {}).get("duree_murale_s") for m in ms
        ],
        "duree_ms_travail": [mesure(m, "duree_ms_travail") for m in ms],
        "duree_ms_proposition": [mesure(m, "duree_ms_proposition") for m in ms],
        "duree_murale_mediane_s": mediane(
            [(m.get("execution") or {}).get("duree_murale_s") for m in ms]
        ),
        "hors_perimetre": sum(mesure(m, "hors_perimetre_nombre") or 0 for m in ms),
        "hors_perimetre_fichiers": [
            mesure(m, "hors_perimetre_attendu") or [] for m in ms
        ],
        "plans_proposes": sum(1 for m in ms if mesure(m, "plan_propose")),
        "plans_approuves": sum(1 for m in ms if mesure(m, "plan_approuve")),
        "sans_plan_signale": sum(1 for m in ms if m.get("sans_plan_signale")),
        "criteres_sans_preuve": [mesure(m, "criteres_sans_preuve") for m in ms],
        "ecarts": sum(mesure(m, "ecarts") or 0 for m in ms),
        "ecarts_par_nature": ecarts,
        "ecarts_avec_motif": sum(mesure(m, "ecarts_avec_motif") or 0 for m in ms),
        "precision_plan": precisions,
        "rappel_plan": rappels,
        "precision_mediane": mediane(precisions),
        "rappel_median": mediane(rappels),
        "travail_plan_propose": sum(t.get("propose", 0) for t in travail),
        "travail_plan_propose_essais": sum(
            1 for t in travail if t.get("propose", 0) > 0
        ),
        "travail_plan_propose_refuses": sum(
            t.get("propose_refuses", 0) for t in travail
        ),
        "travail_plan_propose_deja_approuve": sum(
            t.get("propose_deja_approuve", 0) for t in travail
        ),
        "travail_plan_par_action": {
            a: sum((t.get("plan_par_action") or {}).get(a, 0) for t in travail)
            for a in sorted(
                {a for t in travail for a in (t.get("plan_par_action") or {})}
            )
        },
        "travail_relances_plan": sum(t.get("relances_plan", 0) for t in travail),
    }


def etape_verdict(plan, essais):
    taches = plan["taches"]
    base, ext = plan["paires"], plan["paires_extension"]
    minimum = plan["paires_valides_minimales"]
    lignes = []
    decision = etape_reussites(plan, essais)
    # Point 6 : une tâche n'est lue au-delà des paires de base que si son
    # extension était permise (un seul écart de réussite) et a été jouée ;
    # tout autre essai au-delà est ignoré et déclaré.
    extensions_jouees = {
        t
        for (t, p, _b) in essais
        if p > base and decision.get(t, {}).get("extension_permise")
    }
    hors_regle = sorted(
        f"{t} paire {p} {b}"
        for (t, p, b) in essais
        if p > base and t not in extensions_jouees
    )
    par_tache, ecartees = paires_valides(essais, taches, ext)
    ecartees = [e for e in ecartees if e[1] <= base or e[0] in extensions_jouees]
    for t in taches:
        if t not in extensions_jouees:
            par_tache[t] = {p: v for p, v in par_tache[t].items() if p <= base}

    # 1. Validité.
    invalides = []
    for cellule, tentatives in sorted(essais.items(), key=lambda kv: kv[0]):
        if cellule[1] > base and cellule[0] not in extensions_jouees:
            continue
        _, inv, _ = retenir(tentatives)
        invalides += [
            (
                cellule,
                m["run"]["tentative"],
                m.get("invalidite") or m.get("status_reason"),
            )
            for m in inv
        ]
    valides_base = {t: sum(1 for p in par_tache[t] if p <= base) for t in taches}
    concluante = all(valides_base[t] >= minimum for t in taches)
    point1 = {
        "paires_valides_base": valides_base,
        "minimum": minimum,
        "concluante": concluante,
        "essais_invalides": [
            {"cellule": list(c), "tentative": t, "motif": mo} for c, t, mo in invalides
        ],
        "paires_ecartees": [
            {"tache": t, "paire": p, "motif": mo} for t, p, mo in ecartees
        ],
    }

    # 2. Faisabilité : runs de proposition des essais « avec » retenus dans
    # les paires valides de base ; seuil 12 sur 15, soit au moins 80 % des
    # runs comptés, arrondi au-dessus (12 quand les 15 sont là).
    props = [par_tache[t][p]["avec"] for t in taches for p in par_tache[t] if p <= base]
    n_props = len(props)
    plans = sum(1 for m in props if mesure(m, "plan_propose"))
    seuil = math.ceil(
        Fraction(plan["faisabilite"]["plans"], plan["faisabilite"]["sur"]) * n_props
    )
    faisable = n_props > 0 and plans >= seuil
    props_ext = [
        par_tache[t][p]["avec"] for t in taches for p in par_tache[t] if p > base
    ]
    point2 = {
        "runs_de_proposition": n_props,
        "plans_proposes": plans,
        "seuil": seuil,
        "faisable": faisable,
        "extension_runs": len(props_ext),
        "extension_plans": sum(1 for m in props_ext if mesure(m, "plan_propose")),
    }

    # 3. Blocages.
    par_t = {t: reussites(par_tache[t]) for t in taches}
    total = {b: sum(par_t[t][b] for t in taches) for b in BRAS}
    blocages_taches = {
        t: par_t[t] for t in taches if par_t[t]["avec"] <= par_t[t]["sans"] - 2
    }
    blocage_total = total["avec"] < total["sans"]
    blocages = [
        f"{t} : {r['avec']} réussites avec plan contre {r['sans']} sans"
        for t, r in blocages_taches.items()
    ]
    if blocage_total:
        blocages.append(
            f"total : {total['avec']} réussites avec plan contre {total['sans']} sans"
        )
    point3 = {
        "reussites_par_tache": par_t,
        "total": total,
        "taches_bloquees": sorted(blocages_taches),
        "blocage_total": blocage_total,
        "blocages": blocages,
    }

    # 4. Effet favorable.
    tous = {b: [v[b] for t in taches for v in par_tache[t].values()] for b in BRAS}
    hors = {
        b: sum(mesure(m, "hors_perimetre_nombre") or 0 for m in tous[b]) for b in BRAS
    }
    effet_reussites = total["avec"] >= total["sans"] + 2
    effet_perimetre = (
        hors["sans"] >= 3
        and Fraction(hors["avec"]) <= Fraction(7, 10) * hors["sans"]
        and total["avec"] >= total["sans"]
    )
    effet = (not blocages) and faisable and (effet_reussites or effet_perimetre)
    point4 = {
        "reussites_avec_moins_sans": total["avec"] - total["sans"],
        "effet_reussites": effet_reussites,
        "hors_perimetre": hors,
        "rapport_hors_perimetre": fr(Fraction(hors["avec"], hors["sans"]))
        if hors["sans"]
        else None,
        "effet_perimetre": effet_perimetre,
        "effet_demontre": effet,
    }

    # 5. Coût : appels au modèle, proposition et travail avec plan, travail
    # sans plan (la préparation n'appelle pas le modèle).
    appels = {b: [appels_modele(m) for m in tous[b]] for b in BRAS}
    complet = all(a is not None for b in BRAS for a in appels[b])
    somme_appels = {b: sum(a or 0 for a in appels[b]) for b in BRAS}
    depasse = (not complet) or Fraction(somme_appels["avec"]) > Fraction(
        3, 2
    ) * somme_appels["sans"]
    point5 = {
        "appels_modele": somme_appels,
        "comptes_complets": complet,
        "rapport": fr(Fraction(somme_appels["avec"], somme_appels["sans"]))
        if somme_appels["sans"]
        else None,
        "rapport_decimal": round(somme_appels["avec"] / somme_appels["sans"], 3)
        if somme_appels["sans"]
        else None,
        "cout_depasse": depasse,
    }

    # 6. Bruit et extension.
    point6 = {
        t: {
            **decision[t],
            "extension_jouee": t in extensions_jouees,
            "paires_valides_retenues": len(par_tache[t]),
        }
        for t in taches
    }

    # 7. Issue. Préséance : un blocage ou un défaut de faisabilité exclut
    # l'exigibilité par défaut « quel que soit le reste », validité comprise ;
    # sinon validité insuffisante, non concluante ; sinon effet et coût.
    if blocages or not faisable:
        motifs = (["défaut de faisabilité"] if not faisable else []) + (
            ["blocage"] if blocages else []
        )
        issue = "BLOCAGE OU DÉFAUT DE FAISABILITÉ (" + ", ".join(motifs) + ")"
        recommandation = 'garder le plan facultatif et déconseiller "plan": "required" avec ce modèle, limite documentée'
    elif not concluante:
        issue = "NON CONCLUANTE"
        recommandation = "aucune recommandation de changement : la décision de #29 (plan facultatif) reste en place"
    elif effet and not depasse:
        issue = "EFFET DÉMONTRÉ, COÛT TENU"
        recommandation = "recommander le plan exigible par défaut sous --mission"
    elif effet:
        issue = "EFFET DÉMONTRÉ, COÛT DÉPASSÉ"
        recommandation = 'garder le plan facultatif, recommander "plan": "required" au cas par cas (contrats qui touchent plusieurs fichiers)'
    else:
        issue = "NI EFFET NI BLOCAGE"
        recommandation = "garder la décision de #29 : plan facultatif"

    descriptif = {
        t: {b: resume_bras([v[b] for v in par_tache[t].values()]) for b in BRAS}
        for t in taches
    }

    lignes.append("Point 1 — validité")
    for t in taches:
        lignes.append(
            f"- {t} : {valides_base[t]} paires valides sur {base} (minimum {minimum}), "
            f"{len(par_tache[t])} retenues au total"
        )
    lignes.append(
        f"- essais invalides : {len(invalides)} ; paires écartées : {len(ecartees)}"
    )
    for c, tent, mo in invalides:
        lignes.append(f"  - {c[0]} paire {c[1]} {c[2]} tentative {tent} : {mo}")
    for t, p, mo in ecartees:
        lignes.append(f"  - paire écartée : {t} paire {p} : {mo}")
    lignes.append(f"- campagne {'concluante' if concluante else 'NON concluante'}")
    lignes.append("Point 2 — faisabilité")
    lignes.append(
        f"- plan proposé dans {plans} runs de proposition sur {n_props} (seuil {seuil}) → "
        f"{'tenue' if faisable else 'NON tenue'}"
    )
    if props_ext:
        lignes.append(
            f"- hors règle, extension : {point2['extension_plans']} plans sur {len(props_ext)} runs"
        )
    lignes.append("Point 3 — blocages")
    for t in taches:
        r = par_t[t]
        lignes.append(
            f"- {t} : avec {r['avec']} contre sans {r['sans']} → "
            f"{'BLOCAGE' if t in blocages_taches else 'non'}"
        )
    lignes.append(
        f"- total : avec {total['avec']} contre sans {total['sans']} → {'BLOCAGE' if blocage_total else 'non'}"
    )
    lignes.append("Point 4 — effet favorable")
    lignes.append(
        f"- réussites : avec − sans = {total['avec'] - total['sans']:+d} (effet si ≥ +2) → "
        f"{'tenu' if effet_reussites else 'non tenu'}"
    )
    lignes.append(
        f"- hors périmètre : avec {hors['avec']} contre sans {hors['sans']} (effet si sans ≥ 3, "
        f"avec ≤ 70 % de sans, sans moins de réussites) → {'tenu' if effet_perimetre else 'non tenu'}"
    )
    lignes.append(f"- effet démontré : {'oui' if effet else 'non'}")
    lignes.append("Point 5 — coût")
    lignes.append(
        f"- appels au modèle : avec {somme_appels['avec']} (proposition et travail) contre sans "
        f"{somme_appels['sans']}, rapport {point5['rapport_decimal']} (seuil 1,5) ; comptes "
        f"{'complets' if complet else 'INCOMPLETS'} → {'dépassé' if depasse else 'tenu'}"
    )
    lignes.append("Point 6 — bruit et extension")
    for t in taches:
        d = point6[t]
        lignes.append(
            f"- {t} : écart {d['ecart']:+d} sur les paires de base ; extension permise "
            f"{'oui' if d['extension_permise'] else 'non'}, jouée {'oui' if d['extension_jouee'] else 'non'}"
        )
    if hors_regle:
        lignes.append(
            f"- essais au-delà des paires de base sans extension permise, ignorés : {', '.join(hors_regle)}"
        )
    lignes.append(f"Point 7 — issue : {issue}")
    lignes.append(f"- recommandation : {recommandation}")
    return {
        "point1": point1,
        "point2": point2,
        "point3": point3,
        "point4": point4,
        "point5": point5,
        "point6": point6,
        "issue": issue,
        "recommandation": recommandation,
        "essais_hors_regle": hors_regle,
        "descriptif": descriptif,
    }, lignes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("resultats")
    parser.add_argument("--sha", required=True)
    parser.add_argument("--etape", choices=["reussites", "verdict"], required=True)
    parser.add_argument("--json")
    parser.add_argument("--extension-de")
    parser.add_argument("--plan", default=str(ICI / "plan.json"))
    args = parser.parse_args()
    octets = Path(args.plan).read_bytes()
    plan = json.loads(octets)
    essais, ecartes = charger(
        args.resultats, args.sha, hashlib.sha256(octets).hexdigest()
    )
    if args.etape == "reussites":
        sortie = {
            "etape": "reussites",
            "sha": args.sha,
            "taches": etape_reussites(plan, essais),
            "ecartes": ecartes,
        }
        for t, d in sortie["taches"].items():
            print(
                f"{t} : {d['paires_valides_base']} paires valides, sans {d['reussites_sans']}, "
                f"avec {d['reussites_avec']}, écart {d['ecart']:+d}, extension permise "
                f"{'oui' if d['extension_permise'] else 'non'}"
            )
        if args.json:
            Path(args.json).write_text(
                json.dumps(sortie, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        if args.extension_de:
            return (
                0
                if sortie["taches"].get(args.extension_de, {}).get("extension_permise")
                else 1
            )
        return 0
    resultat, lignes = etape_verdict(plan, essais)
    resultat.update({"etape": "verdict", "sha": args.sha, "ecartes": ecartes})
    print("\n".join(lignes))
    if ecartes:
        print(
            f"Manifestes écartés (autre SHA, arbre modifié, autre plan) : {len(ecartes)}"
        )
    if args.json:
        Path(args.json).write_text(
            json.dumps(resultat, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
