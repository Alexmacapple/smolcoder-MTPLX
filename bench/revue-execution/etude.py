#!/usr/bin/env python3
"""Campagne locale et traçable de l'étude #68, sans écriture dans le HOME réel."""

import hashlib
import glob
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RESULTS = HERE / "resultats"
PROTOCOL = HERE / "protocole.json"
FIXTURES = ("reservation-protegee", "tarif-zero", "reservation-race")
MODEL = "mtplx-qwen38-27b-optimized-speed-fp16"
URL = os.environ.get("MTPLX_URL", "http://127.0.0.1:8000").rstrip("/")
TIMEOUT = 600
REPETITIONS = 2
MAX_ATTEMPTS = 2


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(path):
    return sha(path.read_bytes())


def tree_hashes(path):
    return {
        p.relative_to(path).as_posix(): digest(p)
        for p in sorted(path.rglob("*"))
        if p.is_file() and ".git" not in p.parts
    }


def command(args, cwd=ROOT, **kwargs):
    env = dict(os.environ)
    if args[0] == "git":
        env.update({"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True, env=env, **kwargs)


def server(path):
    with urllib.request.urlopen(f"{URL}{path}", timeout=5) as reply:
        return json.load(reply)


def sources():
    paths = [HERE / "etude.py", HERE / "consigne.txt", HERE / "variante-b.md", HERE / "test-fixtures.cjs", HERE / "test-etude.py"]
    paths += [p for p in (HERE / "fixtures").rglob("*") if p.is_file()]
    return {p.relative_to(ROOT).as_posix(): digest(p) for p in sorted(paths)}


def binary():
    target = RESULTS / "binaire"
    if not target.exists():
        if not (ROOT / "dist/index.js").is_file():
            raise RuntimeError("Binaire absent : lancer npm run build avant prepare")
        target.mkdir(parents=True)
        shutil.copytree(ROOT / "dist", target / "dist")
        shutil.copy2(ROOT / "package.json", target / "package.json")
        for path in target.rglob("*"):
            if path.is_file():
                path.chmod(path.stat().st_mode & ~0o222)
    return target


def prepare():
    if PROTOCOL.exists():
        raise RuntimeError("Protocole déjà figé ; ne pas le remplacer")
    served = server("/v1/models")
    if MODEL not in [item.get("id") for item in served.get("data", [])]:
        raise RuntimeError("Le modèle attendu n'est pas servi")
    ref = command(["git", "rev-parse", "HEAD"]).stdout.strip()
    global_rules = Path.home() / ".smolcoder/AGENTS.md"
    config = Path.home() / ".smolcoder.json"
    if not global_rules.is_file() or not config.is_file():
        raise RuntimeError("Consignes globales ou configuration smolcoder absentes")
    sheets = {}
    for path in sorted((ROOT / "docs/skills").glob("*.md")):
        content = command(["git", "show", f"{ref}:{path.relative_to(ROOT)}"]).stdout.encode()
        sheets[path.name] = sha(content)
    protocol = {
        "format": "revue-execution/protocole/v1",
        "issue": 68,
        "question": "La simulation des chemins d'exécution améliore-t-elle la revue de Qwen–MTPLX ?",
        "ref": ref,
        "modele": MODEL,
        "mode": "ro",
        "url": URL,
        "binaire_sha256": sha(json.dumps(tree_hashes(binary()), sort_keys=True).encode()),
        "noyau_sha256": digest(global_rules),
        "configuration_sha256": digest(config),
        "fiches_a": sheets,
        "sources": sources(),
        "fixtures": list(FIXTURES),
        "repetitions": REPETITIONS,
        "delai_essai_s": TIMEOUT,
        "rejeux_max": MAX_ATTEMPTS - 1,
        "ordre_aa": [[fixture, series, rep] for rep in range(1, REPETITIONS + 1)
                     for fixture in FIXTURES for series in ("A", "A2")],
        "ordre_b": [[fixture, "B", rep] for rep in range(1, REPETITIONS + 1)
                    for fixture in FIXTURES],
        "regle": {
            "vrais_defauts": ["tarif-zero", "reservation-race"],
            "temoin_sans_defaut": "reservation-protegee",
            "keep": "B détecte au moins deux défauts de plus que la meilleure série A/A, sans nouveau faux positif ni mutation ; sa durée médiane ne dépasse pas deux fois celle de A et A2 réunies.",
            "reject": "B détecte au plus autant de vrais défauts que la moins bonne série A/A, ou ajoute un faux positif ou une mutation.",
            "inconclusive": "Tous les autres résultats, ou une cellule non comptée."
        },
        "notation": "Un défaut est trouvé seulement si la réponse décrit sa condition, son chemin d'appel et son effet. Un autre défaut affirmé sans reproduction est un faux positif. Le témoin protégé ne contient pas de défaut. La notation cite les sorties brutes."
    }
    PROTOCOL.write_text(json.dumps(protocol, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Protocole figé : {PROTOCOL} SHA-256 {digest(PROTOCOL)}")
    print(f"Binaire figé : {protocol['binaire_sha256']}")


def load_protocol():
    protocol = json.loads(PROTOCOL.read_text(encoding="utf-8"))
    if protocol["sources"] != sources():
        raise RuntimeError("Les sources de l'étude diffèrent du protocole figé")
    if protocol["url"] != URL:
        raise RuntimeError("L'adresse MTPLX diffère du protocole figé")
    if protocol["binaire_sha256"] != sha(json.dumps(tree_hashes(binary()), sort_keys=True).encode()):
        raise RuntimeError("Le binaire diffère du protocole figé")
    global_rules = Path.home() / ".smolcoder/AGENTS.md"
    config = Path.home() / ".smolcoder.json"
    if digest(global_rules) != protocol["noyau_sha256"] or digest(config) != protocol["configuration_sha256"]:
        raise RuntimeError("Le noyau ou la configuration de l'hôte a changé")
    return protocol


def wait_model():
    for _ in range(24):
        for filename in glob.glob(str(ROOT / "bench/*/resultats/.verrou-campagne")) + glob.glob(str(Path.home() / "Claude-worktrees/*/bench/*/resultats/.verrou-campagne")):
            path = Path(filename)
            if path == RESULTS / ".verrou-campagne":
                continue
            try:
                pid = int(path.read_text().splitlines()[0])
                os.kill(pid, 0)
            except (OSError, ValueError, IndexError):
                continue
            break
        else:
            pid = None
        snapshot = server("/v1/mtplx/snapshot")
        if snapshot.get("model_id") != MODEL:
            raise RuntimeError("Modèle MTPLX différent du protocole")
        if pid is None and snapshot.get("active_requests") == 0:
            return snapshot
        time.sleep(5)
    raise RuntimeError("MTPLX ou une autre campagne reste occupé après 120 secondes")


def stage_sheets(protocol, series, home, scratch):
    source = scratch / "fiches"
    source.mkdir()
    for name, expected in protocol["fiches_a"].items():
        data = command(["git", "show", f"{protocol['ref']}:docs/skills/{name}"]).stdout.encode()
        if sha(data) != expected:
            raise RuntimeError(f"Fiche A modifiée : {name}")
        (source / name).write_bytes(data)
    if series == "B":
        shutil.copy2(HERE / "variante-b.md", source / "revue-de-code.md")
    installed = command([
        "node", str(ROOT / "bench/lecons-fiches/installer-fiches.cjs"),
        str(binary() / "dist"), str(source), str(home / ".smolcoder/fiches")
    ])
    result = json.loads(installed.stdout)
    expected = digest(HERE / "variante-b.md") if series == "B" else protocol["fiches_a"]["revue-de-code.md"]
    actual = next(item["sha256"] for item in result["fiches"] if item["name"] == "revue-de-code")
    if actual != expected:
        raise RuntimeError("La fiche servie n'est pas la variante attendue")
    return actual


def stage_workspace(fixture, scratch, output):
    source = HERE / "fixtures" / fixture
    workspace = scratch / "workspace"
    shutil.copytree(source / "base", workspace)
    command(["git", "init", "-q", "-b", "main"], cwd=workspace)
    command(["git", "config", "user.email", "etude@example.invalid"], cwd=workspace)
    command(["git", "config", "user.name", "Étude locale"], cwd=workspace)
    command(["git", "add", "."], cwd=workspace)
    command(["git", "commit", "-qm", "Référence"], cwd=workspace)
    command(["git", "tag", "reference"], cwd=workspace)
    for path in (source / "candidate").rglob("*"):
        if path.is_file():
            target = workspace / path.relative_to(source / "candidate")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            # Deux versions de même taille peuvent avoir le même horodatage :
            # Git croirait alors que le fichier indexé n'a pas changé.
            target.touch()
    diff = command(["git", "diff", "reference"], cwd=workspace).stdout
    if not diff:
        raise RuntimeError(f"Diff vide pour {fixture}")
    (output / "diff.txt").write_text(diff, encoding="utf-8")
    return workspace


def run_cell(protocol, fixture, series, repetition, attempt):
    cell = f"{fixture}-{series}-{repetition}"
    output = RESULTS / f"{cell}-essai-{attempt}"
    output.mkdir(parents=True)
    start = time.time()
    result = {"cellule": cell, "fixture": fixture, "serie": series, "repetition": repetition,
              "tentative": attempt, "protocole_sha256": digest(PROTOCOL), "statut": "erreur"}
    try:
        snapshot = wait_model()
        (output / "snapshot-avant.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
        with tempfile.TemporaryDirectory(prefix="revue-execution-") as temp:
            scratch = Path(temp)
            home = scratch / "home"
            (home / ".smolcoder").mkdir(parents=True)
            shutil.copy2(Path.home() / ".smolcoder/AGENTS.md", home / ".smolcoder/AGENTS.md")
            shutil.copy2(Path.home() / ".smolcoder.json", home / ".smolcoder.json")
            result["fiche_sha256"] = stage_sheets(protocol, series, home, scratch)
            workspace = stage_workspace(fixture, scratch, output)
            before = tree_hashes(workspace)
            before_git = command(["git", "status", "--porcelain", "-uall"], cwd=workspace).stdout
            before_head = command(["git", "rev-parse", "HEAD"], cwd=workspace).stdout
            env = dict(os.environ)
            env.update({"HOME": str(home), "NO_COLOR": "1"})
            for name in ("SMOL_NO_FICHES", "SMOL_NO_GLOBAL_AGENTS", "SMOLCODER_CONFIG", "OLLAMA_HOST"):
                env.pop(name, None)
            prompt = (HERE / "consigne.txt").read_text(encoding="utf-8")
            prompt = prompt.replace("{{REFERENCE}}", "reference (HEAD)")
            prompt = prompt.replace("{{STATUT}}", before_git.strip())
            prompt = prompt.replace("{{DIFF}}", (output / "diff.txt").read_text(encoding="utf-8"))
            result["prompt_sha256"] = sha(prompt.encode("utf-8"))
            result["mode"] = protocol["mode"]
            proc = subprocess.Popen(
                ["node", str(binary() / "dist/index.js"), str(workspace), "-m", "ro", "--model", MODEL, "-p", prompt],
                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, start_new_session=True,
            )
            try:
                stdout, stderr = proc.communicate(timeout=protocol["delai_essai_s"])
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    stdout, stderr = proc.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    stdout, stderr = proc.communicate()
                result["timeout"] = True
            (output / "sortie.txt").write_text(stdout, encoding="utf-8")
            (output / "erreurs.txt").write_text(stderr, encoding="utf-8")
            result["code_sortie"] = proc.returncode
            result["fiche_lue"] = "fiche:revue-de-code" in stderr
            result["ecritures_tentees"] = [line for line in stderr.splitlines()
                                            if line.startswith(("→ write_file", "→ edit_file", "→ apply_patch"))]
            result["mutation"] = (before != tree_hashes(workspace)
                                  or before_git != command(["git", "status", "--porcelain", "-uall"], cwd=workspace).stdout
                                  or before_head != command(["git", "rev-parse", "HEAD"], cwd=workspace).stdout)
            result["modele_attendu"] = MODEL
            result["statut"] = "comptee" if proc.returncode == 0 and result["fiche_lue"] and not result.get("timeout") else "non_comptee"
            for line in stderr.splitlines():
                if line.startswith("[stats] "):
                    result["stats"] = json.loads(line[8:])
    except Exception as error:
        result["erreur"] = str(error)
    result["duree_s"] = round(time.time() - start, 2)
    (output / "manifeste.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{cell} essai {attempt} : {result['statut']} ({result['duree_s']} s)", flush=True)
    return result


def campaign(stage):
    protocol = load_protocol()
    if stage == "b":
        missing = [cell for cell in protocol["ordre_aa"] if not counted(cell)]
        if missing:
            raise RuntimeError(f"A/A incomplet : {missing}")
        if not (RESULTS / "analyse-aa.json").is_file():
            raise RuntimeError("Publier l'analyse A/A avant la série B")
    order = protocol["ordre_aa" if stage == "aa" else "ordre_b"]
    RESULTS.mkdir(parents=True, exist_ok=True)
    lock = RESULTS / ".verrou-campagne"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise RuntimeError("Une campagne #68 détient déjà le verrou") from error
    try:
        os.write(fd, f"{os.getpid()}\n".encode())
        os.close(fd)
        for fixture, series, repetition in order:
            cell = (fixture, series, repetition)
            if counted(cell):
                print(f"Déjà comptée : {cell}", flush=True)
                continue
            for attempt in range(1, MAX_ATTEMPTS + 1):
                if (RESULTS / f"{fixture}-{series}-{repetition}-essai-{attempt}").exists():
                    continue
                result = run_cell(protocol, fixture, series, repetition, attempt)
                if result["statut"] == "comptee":
                    break
        missing = [cell for cell in order if not counted(cell)]
        if missing:
            raise RuntimeError(f"Cellules non comptées : {missing}")
    finally:
        lock.unlink(missing_ok=True)


def counted(cell):
    fixture, series, repetition = cell
    for output in RESULTS.glob(f"{fixture}-{series}-{repetition}-essai-*"):
        manifest = output / "manifeste.json"
        if manifest.is_file() and json.loads(manifest.read_text())["statut"] == "comptee":
            return True
    return False


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("prepare", "aa", "b"):
        raise SystemExit("Usage : etude.py <prepare|aa|b>")
    if sys.argv[1] == "prepare":
        prepare()
    else:
        campaign(sys.argv[1])


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"Erreur : {error}", file=sys.stderr)
        raise SystemExit(1)
