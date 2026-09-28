#!/usr/bin/env python3
"""Recalcule les scores de l'étude #68 depuis les sorties et annotations citées."""

import hashlib
import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "resultats"
PROOFS = HERE / "preuves"
PROTOCOL = HERE / "protocole.json"
ANNOTATIONS = HERE / "annotations.json"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def main(stage, source=None):
    source = source or RESULTS
    protocol = read(PROTOCOL)
    annotations = read(ANNOTATIONS)
    cells = protocol["ordre_aa"] + (protocol["ordre_b"] if stage == "ab" else [])
    result = {"etape": stage, "protocole_sha256": sha(PROTOCOL.read_bytes()),
              "cellules": {}, "cellules_manquantes": [], "series": {}}
    for fixture, series, repetition in cells:
        name = f"{fixture}-{series}-{repetition}"
        attempts = []
        for folder in source.glob(f"{name}-essai-*"):
            manifest = folder / "manifeste.json"
            if manifest.is_file():
                item = read(manifest)
                if item.get("protocole_sha256") == result["protocole_sha256"] and item["statut"] == "comptee":
                    attempts.append((folder, item))
        if not attempts and stage == "ab":
            result["cellules_manquantes"].append(name)
            continue
        if len(attempts) != 1:
            raise ValueError(f"{name} : {len(attempts)} tentative(s) comptée(s), une attendue")
        folder, manifest = attempts[0]
        annotation = annotations.get(name)
        if not annotation:
            raise ValueError(f"{name} : annotation absente")
        output = (folder / "sortie.txt").read_text(encoding="utf-8")
        proof = annotation["preuve"]
        if proof.casefold() not in output.casefold():
            raise ValueError(f"{name} : l'extrait cité ne figure pas dans la sortie")
        for extra_proof in annotation.get("preuves_supplementaires", []):
            if extra_proof.casefold() not in output.casefold():
                raise ValueError(f"{name} : un constat supplémentaire ne figure pas dans la sortie")
        if annotation["faux_positifs"] < 0 or not isinstance(annotation["trouve"], bool):
            raise ValueError(f"{name} : annotation invalide")
        if fixture == protocol["regle"]["temoin_sans_defaut"] and annotation["trouve"]:
            raise ValueError(f"{name} : le témoin ne porte aucun défaut cible")
        if manifest.get("stats", {}).get("model") != protocol["modele"]:
            raise ValueError(f"{name} : modèle réel différent")
        if not manifest["fiche_lue"] or manifest["mode"] != protocol["mode"]:
            raise ValueError(f"{name} : fiche ou mode absent")
        result["cellules"][name] = {
            "sortie_sha256": sha(output.encode("utf-8")),
            "trouve": annotation["trouve"],
            "faux_positifs": annotation["faux_positifs"],
            "preuve": proof,
            "preuves_supplementaires": annotation.get("preuves_supplementaires", []),
            "justification": annotation["justification"],
            "duree_s": manifest["duree_s"],
            "mutation": manifest["mutation"],
            "ecritures_tentees": len(manifest["ecritures_tentees"]),
            "prompt_sha256": manifest["prompt_sha256"],
            "fiche_sha256": manifest["fiche_sha256"],
        }
    for series in ("A", "A2", "B")[: 3 if stage == "ab" else 2]:
        subset = [v for name, v in result["cellules"].items() if name.split("-")[-2] == series]
        bug_cells = [v for name, v in result["cellules"].items()
                     if name.split("-")[-2] == series and not name.startswith(protocol["regle"]["temoin_sans_defaut"] + "-")]
        result["series"][series] = {
            "cellules": len(subset),
            "vrais_defauts": sum(v["trouve"] for v in bug_cells),
            "faux_positifs": sum(v["faux_positifs"] for v in subset),
            "mutations": sum(v["mutation"] for v in subset),
            "ecritures_tentees": sum(v["ecritures_tentees"] for v in subset),
            "duree_mediane_s": statistics.median(v["duree_s"] for v in subset) if subset else None,
        }
    if stage == "aa":
        result["ecart_aa"] = abs(result["series"]["A"]["vrais_defauts"] - result["series"]["A2"]["vrais_defauts"])
    else:
        a, a2, b = (result["series"][name] for name in ("A", "A2", "B"))
        baseline_cells = [v["duree_s"] for name, v in result["cellules"].items()
                          if name.split("-")[-2] in ("A", "A2")]
        baseline_duration = statistics.median(baseline_cells) if baseline_cells else None
        result["duree_mediane_aa_s"] = baseline_duration
        if result["cellules_manquantes"]:
            result["verdict"] = "INCONCLUSIVE"
        elif (b["vrais_defauts"] >= max(a["vrais_defauts"], a2["vrais_defauts"]) + 2
            and b["faux_positifs"] <= min(a["faux_positifs"], a2["faux_positifs"])
            and b["mutations"] <= min(a["mutations"], a2["mutations"])
            and b["duree_mediane_s"] <= 2 * baseline_duration):
            result["verdict"] = "KEEP"
        elif (b["vrais_defauts"] <= min(a["vrais_defauts"], a2["vrais_defauts"])
              or b["faux_positifs"] > max(a["faux_positifs"], a2["faux_positifs"])
              or b["mutations"] > max(a["mutations"], a2["mutations"])):
            result["verdict"] = "REJECT"
        else:
            result["verdict"] = "INCONCLUSIVE"
    target = RESULTS / ("analyse-aa.json" if stage == "aa" else "analyse-ab.json")
    RESULTS.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"etape": stage, "series": result["series"],
                      "verdict": result.get("verdict"), "ecart_aa": result.get("ecart_aa")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or sys.argv[1] not in ("aa", "ab") or (len(sys.argv) == 3 and sys.argv[2] != "--preuves"):
        raise SystemExit("Usage : analyse.py <aa|ab> [--preuves]")
    try:
        main(sys.argv[1], PROOFS if len(sys.argv) == 3 else RESULTS)
    except (ValueError, KeyError) as error:
        print(f"Erreur de notation : {error}", file=sys.stderr)
        raise SystemExit(1)
