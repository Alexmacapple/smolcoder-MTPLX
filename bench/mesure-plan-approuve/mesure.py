#!/usr/bin/env python3
"""Outils de la mesure appariée de #29 (protocole
docs/protocole-mesure-plan-approuve.md) : contrôle des pièces figées, lecture
de la trace des runs (appels de l'outil plan, erreurs du serveur), classement
de la validité d'un essai, manifeste, état des cellules.

La réussite réelle vient du verdict de controle.py (protocole) et du code de
sortie du run de travail, jamais du récit du modèle. La sonde et
l'attribution des requêtes MTPLX sont celles de la mesure #19
(bench/mesure-retours-outils/mesure.py, commandes sonde et concurrence),
appelées telles quelles par essai.sh.
"""

import hashlib
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ICI = Path(__file__).resolve().parent
FORMAT_ESSAI = "mesure-plan-approuve/v1"
RUNS = ("preparation", "proposition", "travail")
APPEL = re.compile(r"^→ (\S+) ?(.*)$")
RESULTAT = re.compile(r"^  [✓✗] ")
ARRETS_FORCES = {124, 137, 143}
# Échec du serveur dans la trace de smol : nouvelle tentative (« backend
# error … retrying ») ou tour arrêté sur une erreur du transport.
ERREUR_SERVEUR = re.compile(
    r"ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|LM Studio returned|"
    r"stream ended before completion|Backend stream|Backend returned|backend error|UND_ERR"
)


def lire_plan():
    chemin = Path(os.environ.get("MESURE_PLAN") or ICI / "plan.json")
    return json.loads(chemin.read_text(encoding="utf-8"))


def sha256_fichier(chemin):
    return hashlib.sha256(Path(chemin).read_bytes()).hexdigest()


def json_optionnel(chemin):
    try:
        return json.loads(Path(chemin).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def texte_optionnel(chemin):
    try:
        return Path(chemin).read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None


def entier_optionnel(valeur):
    try:
        return int(valeur) if valeur not in (None, "") else None
    except ValueError:
        return None


def ecrire_json(chemin, donnees):
    temporaire = Path(str(chemin) + ".tmp")
    temporaire.write_text(
        json.dumps(donnees, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporaire, chemin)


# ---- contrôle des pièces du protocole ------------------------------------


def controler(depot):
    """Refuse tout écart entre les pièces servies et celles du plan figé."""
    plan = lire_plan()
    ecarts = []
    attendues = dict(plan["protocole"]["pieces"])
    attendues.update(plan["protocole"].get("outillage_reutilise", {}))
    for relatif, attendu in attendues.items():
        chemin = Path(depot) / relatif
        if not chemin.is_file():
            ecarts.append(f"pièce absente : {relatif}")
        elif sha256_fichier(chemin) != attendu:
            ecarts.append(f"pièce modifiée : {relatif}")
    racine = Path(depot) / "docs/protocole-mesure-plan-approuve"
    for chemin in sorted(racine.rglob("*")):
        relatif = str(chemin.relative_to(depot))
        if (
            chemin.is_file()
            and "__pycache__" not in relatif
            and relatif not in attendues
        ):
            ecarts.append(f"pièce en plus : {relatif}")
    for ecart in ecarts:
        print(ecart, file=sys.stderr)
    if ecarts:
        raise SystemExit(1)
    print("pièces du protocole conformes")


# ---- lecture de la trace d'un run ----------------------------------------


def lignes_prefixees(texte, prefixe):
    sortie = []
    for ligne in texte.splitlines():
        if ligne.startswith(prefixe):
            try:
                sortie.append(json.loads(ligne[len(prefixe) :]))
            except json.JSONDecodeError:
                pass
    return sortie


def lire_run(dossier, nom):
    """Ce que la trace d'erreur d'un run dit, hors récit du modèle."""
    texte = texte_optionnel(Path(dossier) / f"{nom}.erreurs.txt")
    if texte is None:
        return None
    lignes = texte.splitlines()
    appels, plan_appels = [], []
    for i, ligne in enumerate(lignes):
        m = APPEL.match(ligne)
        if not m or m.group(1) == "verification":
            continue
        resultat = next((l for l in lignes[i + 1 :] if RESULTAT.match(l)), "")
        appels.append(m.group(1))
        if m.group(1) == "plan":
            action = (m.group(2).split() or [""])[0].rstrip(":")
            plan_appels.append(
                {
                    "action": action,
                    "resultat": resultat.strip()[:200],
                    "erreur": resultat.startswith("  ✗"),
                }
            )
    stats = lignes_prefixees(texte, "[stats] ")
    missions = lignes_prefixees(texte, "[mission] ")
    hors_outils = [l for l in lignes if not APPEL.match(l) and not RESULTAT.match(l)]
    return {
        "stats_presentes": bool(stats),
        "mission_presente": bool(missions),
        "issue": stats[-1].get("outcome") if stats else None,
        "etat_mission_debut": missions[0].get("state") if missions else None,
        "etat_mission_fin": missions[-1].get("state") if missions else None,
        "plan_debut": (missions[0].get("plan") or {}).get("state")
        if missions
        else None,
        "appels_trace": len(appels),
        "appels_plan": plan_appels,
        "plan_par_action": {
            a: sum(1 for p in plan_appels if p["action"] == a)
            for a in sorted({p["action"] for p in plan_appels})
        },
        "propose": sum(1 for p in plan_appels if p["action"] == "propose"),
        "propose_refuses": sum(
            1 for p in plan_appels if p["action"] == "propose" and p["erreur"]
        ),
        "propose_deja_approuve": sum(
            1
            for p in plan_appels
            if p["action"] == "propose" and "already approved" in p["resultat"]
        ),
        "relances_plan": sum(1 for l in lignes if "plan has unfinished steps" in l),
        "nouvelles_tentatives_serveur": sum(
            1 for l in lignes if "· backend error (" in l
        ),
        "erreurs_serveur": [
            l.strip()[:200] for l in hors_outils if ERREUR_SERVEUR.search(l)
        ][:5],
    }


def trace(dossier):
    """trace-plan.json : la lecture de chaque run de l'essai."""
    dossier = Path(dossier)
    donnees = {nom: lire_run(dossier, nom) for nom in RUNS}
    print(json.dumps(donnees, ensure_ascii=False, indent=2))


# ---- validité et statut d'un essai ---------------------------------------


def mtplx_repond(url):
    try:
        with urllib.request.urlopen(f"{url}/v1/models", timeout=5) as r:
            d = json.loads(r.read().decode("utf-8"))
        return any(isinstance(m, dict) and m.get("id") for m in d.get("data") or [])
    except (OSError, ValueError):
        return False


def classer(out, bras, modele_attendu, url, essai_rc):
    """Statut, raison et code de sortie d'un essai joué (règle, point 1, et
    écarts déclarés du rapport) : « statut\\traison\\tcode »."""
    out = Path(out)
    proto = out / "essai"
    runs = json_optionnel(out / "trace-plan.json") or {}
    travail = runs.get("travail") or {}

    def fin(statut, raison, code):
        print(f"{statut}\t{raison}\t{code}")

    if str(essai_rc) != "0" or json_optionnel(proto / "mesures.json") is None:
        return fin(
            "blocage_harnais",
            f"déroulé du protocole incomplet (essai.sh du protocole sorti {essai_rc})",
            4,
        )
    if not (travail.get("stats_presentes") or travail.get("mission_presente")):
        if not mtplx_repond(url):
            return fin(
                "mtplx_indisponible", "smol n'a pas démarré et MTPLX ne répond plus", 3
            )
        return fin(
            "blocage_harnais",
            "smol n'a pas démarré (ni [stats] ni [mission] au travail)",
            4,
        )
    if travail.get("etat_mission_debut") != "approved":
        return fin(
            "blocage_harnais",
            f"approbation refusée au run de travail (contrat {travail.get('etat_mission_debut')})",
            4,
        )
    for nom in ("proposition", "travail"):
        r = runs.get(nom) or {}
        if r.get("nouvelles_tentatives_serveur") or (
            r.get("issue") == "error" and r.get("erreurs_serveur")
        ):
            return fin(
                "mtplx_indisponible",
                f"erreur du serveur au run de {nom} : {(r.get('erreurs_serveur') or ['nouvelle tentative'])[0]}",
                3,
            )
    if not mtplx_repond(url):
        return fin("mtplx_indisponible", "MTPLX ne répond plus après l'essai", 3)
    rc_prop = texte_optionnel(proto / "proposition.rc.txt")
    if bras == "avec" and rc_prop != "3":
        return fin(
            "proposition_invalide",
            f"run de proposition sorti avec le code {rc_prop} au lieu de 3 (règle, point 1)",
            3,
        )
    concur = json_optionnel(out / "concurrence.json")
    if concur is None:
        return fin("blocage_harnais", "attribution des requêtes MTPLX impossible", 4)
    if concur.get("occupe"):
        return fin(
            "mtplx_indisponible",
            "MTPLX occupé pendant l'essai : " + "; ".join(concur.get("motifs") or []),
            3,
        )
    for nom in ("snapshot-avant.json", "snapshot-apres.json"):
        s = json_optionnel(proto / nom) or {}
        if s.get("model_id") != modele_attendu:
            return fin(
                "mtplx_indisponible",
                f"modèle {s.get('model_id')} au lieu de {modele_attendu} ({nom} du protocole)",
                3,
            )
    rc = entier_optionnel(texte_optionnel(proto / "travail.rc.txt"))
    if rc in ARRETS_FORCES:
        return fin(
            "echec_test", f"run de travail arrêté (code {rc}) : jamais une réussite", 1
        )
    if texte_optionnel(proto / "reussite.txt") == "0":
        return fin(
            "succes", f"controle.py sort 0 et smol sorti de lui-même (code {rc})", 0
        )
    return fin(
        "echec_test",
        f"controle.py en échec (voir essai/controle.txt), smol sorti {rc}",
        1,
    )


# ---- manifeste d'un essai ------------------------------------------------


def run_info(proto, nom, trace_run):
    rc = texte_optionnel(proto / f"{nom}.rc.txt")
    if rc is None:
        return None
    return {
        "rc": entier_optionnel(rc),
        "duree_murale_s": entier_optionnel(texte_optionnel(proto / f"{nom}.duree.txt")),
        "trace": trace_run,
    }


def manifeste(out):
    """Écrit manifeste.json à partir des variables ESSAI_* d'essai.sh et des
    fichiers de l'essai."""
    out = Path(out)
    proto = out / "essai"
    e = os.environ.get
    plan_chemin = Path(e("MESURE_PLAN") or ICI / "plan.json")
    runs = json_optionnel(out / "trace-plan.json") or {}
    mesures = json_optionnel(proto / "mesures.json")
    concur = json_optionnel(out / "concurrence.json")
    statut = e("ESSAI_STATUT", "blocage_harnais")
    invalidite = e("ESSAI_INVALIDITE", "") or None
    valide = statut in {"succes", "echec_test"} and invalidite is None
    travail = run_info(proto, "travail", runs.get("travail"))
    proposition = run_info(proto, "proposition", runs.get("proposition"))
    preparation = run_info(proto, "preparation", runs.get("preparation"))
    rc_travail = (travail or {}).get("rc")
    sorti_seul = rc_travail is not None and rc_travail not in ARRETS_FORCES
    controle_ok = texte_optionnel(proto / "reussite.txt") == "0"
    # Appels du run de travail : [stats] (protocole) ; sans [stats] (run
    # arrêté au délai), le budget débité avant chaque appel au modèle
    # (usage.steps du contrat archivé) et les lignes « → » de la trace.
    contrat = json_optionnel(proto / "stockage" / "contract.json") or {}
    m = mesures or {}
    modele_travail, source_modele = m.get("appels_modele_travail"), "stats"
    if modele_travail is None and travail is not None:
        modele_travail = (contrat.get("usage") or {}).get("steps")
        source_modele = "contrat" if modele_travail is not None else None
    outils_travail, source_outils = m.get("appels_outils_travail"), "stats"
    if outils_travail is None and runs.get("travail"):
        outils_travail, source_outils = runs["travail"]["appels_trace"], "trace"
    snaps = {
        nom: json_optionnel(proto / f"snapshot-{nom}.json") or {}
        for nom in ("avant", "apres")
    }
    modeles = [s.get("model_id") for s in snaps.values() if s.get("model_id")]
    donnees = {
        "format": FORMAT_ESSAI,
        "run": {
            "id": out.name,
            "campagne_id": e("ESSAI_CAMPAGNE", "") or None,
            "tache": e("ESSAI_TACHE", ""),
            "bras": e("ESSAI_BRAS", ""),
            "paire": entier_optionnel(e("ESSAI_PAIRE")),
            "tentative": entier_optionnel(e("ESSAI_TENTATIVE")) or 1,
            "started_at": e("ESSAI_DEBUT", "") or None,
            "finished_at": e("ESSAI_FIN", "") or None,
        },
        "status": statut,
        "status_reason": e("ESSAI_RAISON", ""),
        "valide": valide,
        "invalidite": invalidite if not valide else None,
        "harness": {
            "repository_sha": e("ESSAI_SHA_HARNAIS", "inconnu"),
            "working_tree_dirty": {"true": True, "false": False}.get(
                e("ESSAI_HARNAIS_MODIFIE", ""), None
            ),
            "plan_sha256": sha256_fichier(plan_chemin)
            if plan_chemin.is_file()
            else None,
        },
        "binaire": {
            "sha_source": e("ESSAI_BIN_SHA", "") or None,
            "empreinte_dist": e("ESSAI_BIN_EMPREINTE", "") or None,
            "commande": e("ESSAI_BIN_CMD", "") or None,
            "node": e("ESSAI_NODE", "") or None,
        },
        "maison_de_test": {
            "noyau_sha256": e("ESSAI_NOYAU_SHA", "") or None,
            "config_sha256": e("ESSAI_CONFIG_SHA", "") or None,
        },
        "server": {
            "url": e("ESSAI_MTPLX_URL", ""),
            "model_id": modeles[0]
            if len(modeles) == 2 and len(set(modeles)) == 1
            else ("change" if len(set(modeles)) > 1 else "inconnu"),
            "active_avant": snaps["avant"].get("active_requests"),
            "requests_total": [
                (s.get("lifetime") or {}).get("requests_total") for s in snaps.values()
            ],
            "concurrence": concur,
        },
        "execution": {
            "smol_lance": e("ESSAI_SMOL_LANCE", "0") == "1",
            "essai_protocole_rc": entier_optionnel(e("ESSAI_PROTO_RC")),
            "duree_murale_s": entier_optionnel(e("ESSAI_DUREE")),
            "delai_run_s": entier_optionnel(e("ESSAI_DELAI")),
            "preparation": preparation,
            "proposition": proposition,
            "travail": travail,
            "sorti_de_lui_meme": sorti_seul,
        },
        "sans_plan_signale": (proto / "sans-plan.txt").is_file(),
        "controle": texte_optionnel(proto / "controle.txt"),
        "reussite_reelle": bool(valide and controle_ok and sorti_seul),
        "mesures": dict(
            m,
            appels_modele_travail_retenus=modele_travail,
            source_appels_modele_travail=source_modele,
            appels_outils_travail_retenus=outils_travail,
            source_appels_outils_travail=source_outils,
            hors_perimetre_nombre=len(m.get("hors_perimetre_attendu") or []),
        ),
    }
    ecrire_json(out / "manifeste.json", donnees)


# ---- état des cellules (reprise et rejeu) --------------------------------


def cellules(resultats, sha):
    """Une ligne par cellule jouée pour ce SHA : clé, essais valides, essais."""
    compte = {}
    for chemin in sorted(Path(resultats).glob("*/manifeste.json")):
        m = json_optionnel(chemin)
        if not isinstance(m, dict) or m.get("format") != FORMAT_ESSAI:
            continue
        if m.get("harness", {}).get("repository_sha") != sha:
            continue
        r = m["run"]
        cle = f"{r['tache']} {r['paire']} {r['bras']}"
        v, n = compte.get(cle, (0, 0))
        compte[cle] = (v + (1 if m.get("valide") else 0), n + 1)
    for cle, (v, n) in sorted(compte.items()):
        print(f"{cle} {v} {n}")


def main(argv):
    fonctions = {
        "controler": controler,
        "trace": trace,
        "classer": classer,
        "manifeste": manifeste,
        "cellules": cellules,
    }
    if not argv or argv[0] not in fonctions:
        raise SystemExit(f"usage : mesure.py <{'|'.join(fonctions)}> …")
    fonctions[argv[0]](*argv[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
