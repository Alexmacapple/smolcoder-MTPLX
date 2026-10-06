"""Contrats, fixtures, oracle et classement déterministe du banc #72."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
RESULTS = HERE / "resultats"
STATS_REQUIRED = {
    "durationMs",
    "modelCalls",
    "toolCalls",
    "generatedTokens",
    "promptTokensLast",
    "contextWindow",
}


def plan():
    return json.loads((HERE / "plan.json").read_text(encoding="utf-8"))


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tree_fingerprint(path):
    digest = hashlib.sha256()
    for file in sorted(Path(path).rglob("*")):
        if file.is_file():
            digest.update(
                str(file.relative_to(path)).encode() + b"\0" + file.read_bytes() + b"\0"
            )
    return digest.hexdigest()


def controler_protocole():
    pieces = plan()["pieces"]
    if not pieces:
        return ["aucune pièce figée dans le protocole"]
    errors = []
    for relative, expected in pieces.items():
        path = REPO / relative
        if not path.is_file():
            errors.append(f"pièce absente : {relative}")
        elif sha256_file(path) != expected:
            errors.append(f"pièce modifiée : {relative}")
    return errors


def git(args, cwd, check=True):
    return subprocess.run(
        ["git", *args], cwd=cwd, text=True, capture_output=True, check=check
    )


def task(task_id):
    try:
        return plan()["tasks"][task_id]
    except KeyError as error:
        raise ValueError(f"Tâche inconnue : {task_id}") from error


def preparer_espace(task_id, parent):
    spec = task(task_id)
    workspace = Path(parent) / "workspace"
    shutil.copytree(HERE / spec["fixture"], workspace)
    git(["init", "-q"], workspace)
    git(["add", "-A"], workspace)
    git(
        [
            "-c",
            "user.name=banc",
            "-c",
            "user.email=banc@local",
            "commit",
            "-qm",
            "reference",
        ],
        workspace,
    )
    git(["tag", "reference"], workspace)
    overlay = spec.get("human_overlay")
    if overlay:
        (workspace / overlay["path"]).write_text(overlay["content"], encoding="utf-8")
    return workspace


def appliquer_solution(task_id, workspace):
    for file in (HERE / task(task_id)["solution"]).iterdir():
        if file.is_file():
            shutil.copy2(file, Path(workspace) / file.name)


def verifier(task_id, workspace):
    spec = task(task_id)
    workspace = Path(workspace)
    process = subprocess.run(
        [sys.executable, str(HERE / "acceptation.py"), task_id, str(workspace)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=120,
        check=False,
        env={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": "/nonexistent",
            "PYTHONDONTWRITEBYTECODE": "1",
            "LANG": "fr_FR.UTF-8",
        },
    )
    changed = git(["diff", "--name-only", "reference"], workspace).stdout.splitlines()
    untracked = [
        line[3:]
        for line in git(
            ["status", "--porcelain", "--untracked-files=all"], workspace
        ).stdout.splitlines()
        if line.startswith("?? ") and "__pycache__" not in line
    ]
    overlay = spec.get("human_overlay")
    expected_untracked = {overlay["path"]} if overlay else set()
    overlay_ok = not overlay or (
        (workspace / overlay["path"]).is_file()
        and (workspace / overlay["path"]).read_text(encoding="utf-8")
        == overlay["content"]
    )
    scope_ok = (
        set(changed) <= set(spec["allowed_paths"])
        and set(untracked) == expected_untracked
    )
    return {
        "passed": process.returncode == 0 and scope_ok and overlay_ok,
        "acceptance_exit_code": process.returncode,
        "acceptance_output_tail": "\n".join(process.stdout.strip().splitlines()[-12:]),
        "changed_tracked": sorted(changed),
        "untracked": sorted(untracked),
        "scope_ok": scope_ok,
        "human_overlay_preserved": overlay_ok,
    }


def extraire_stats(text):
    found = None
    for line in text.splitlines():
        if line.startswith("[stats] "):
            try:
                candidate = json.loads(line.removeprefix("[stats] "))
            except json.JSONDecodeError:
                continue
            if STATS_REQUIRED <= candidate.keys():
                found = candidate
    return found


def classer(harness_ok, mtplx, exit_code, stats, verification, refus_securite=False):
    if not harness_ok:
        return "blocage_harnais"
    if mtplx is None:
        return "mtplx_indisponible"
    if stats is None:
        return "blocage_harnais"
    if refus_securite and exit_code != 0 and not verification["passed"]:
        return "refus_securite_attendu"
    return "succes" if exit_code == 0 and verification["passed"] else "echec_tache"


def write_json(path, data):
    temporary = Path(f"{path}.tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)
