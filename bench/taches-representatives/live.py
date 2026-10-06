"""Orchestration séquentielle d'un essai et du pilote réel A/A."""

import re
import subprocess
import tarfile
import tempfile
from datetime import UTC, datetime

from core import (
    REPO,
    RESULTS,
    classer,
    controler_protocole,
    extraire_stats,
    plan,
    preparer_espace,
    task,
    tree_fingerprint,
    verifier,
    write_json,
)
from host import (
    campaign_lock,
    clean_repo,
    head_sha,
    mtplx_state,
    prepare_home,
    run_model,
)


def result_folder(arm, task_id, campaign_id):
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output = RESULTS / campaign_id / f"{stamp}-{arm}-{task_id}"
    suffix = 1
    while output.exists():
        suffix += 1
        output = RESULTS / campaign_id / f"{stamp}-{arm}-{task_id}-{suffix}"
    output.mkdir(parents=True)
    return output


def trial(arm, task_id, campaign_id):
    config, output = plan(), result_folder(arm, task_id, campaign_id)
    manifest = {
        "format": "taches-representatives/essai/v1",
        "campaign": campaign_id,
        "arm": arm,
        "task": task_id,
        "started_at": datetime.now(UTC).isoformat(),
        "finished_at": None,
        "status": "blocage_harnais",
        "status_reason": "Essai initialisé, préconditions non vérifiées",
        "executed": False,
        "valid": False,
    }
    write_json(output / "manifest.json", manifest)
    errors = controler_protocole()
    harness_ok = not errors and clean_repo() and (REPO / "dist/index.js").is_file()
    before = mtplx_state(config) if harness_ok else None
    if not harness_ok or before is None:
        manifest.update(
            status=classer(harness_ok, before, 4, None, {"passed": False}),
            status_reason=(
                "; ".join(errors)
                if errors
                else "Dépôt non propre ou binaire dist absent"
                if not harness_ok
                else "MTPLX indisponible, occupé ou autre modèle servi"
            ),
            finished_at=datetime.now(UTC).isoformat(),
        )
        write_json(output / "manifest.json", manifest)
        return manifest

    with tempfile.TemporaryDirectory(prefix="smol-banc-72-") as temporary:
        root = __import__("pathlib").Path(temporary)
        workspace = preparer_espace(task_id, root)
        home, tmpdir = prepare_home(root, config)
        run = run_model(config, task_id, workspace, home, tmpdir)
        (output / "stdout.txt").write_text(run["stdout"], encoding="utf-8")
        (output / "stderr.txt").write_text(run["stderr"], encoding="utf-8")
        stats, verification, after = (
            extraire_stats(run["stderr"]),
            verifier(task_id, workspace),
            mtplx_state(config),
        )
        status = classer(harness_ok, after, run["exit_code"], stats, verification)
        with tarfile.open(output / "workspace-final.tar.gz", "w:gz") as archive:
            archive.add(workspace, arcname="workspace")
        overlay = task(task_id).get("human_overlay")
        manifest.update(
            finished_at=datetime.now(UTC).isoformat(),
            status=status,
            valid=status in {"succes", "echec_tache", "refus_securite_attendu"},
            executed=True,
            status_reason={
                "succes": "Contrôle externe réussi et exécution complète",
                "echec_tache": "Contrôle externe ou exécution en échec",
                "blocage_harnais": "Mesures obligatoires absentes ou harnais incomplet",
                "mtplx_indisponible": "MTPLX indisponible ou occupé après l'essai",
            }.get(status, status),
            binary={
                "git_sha": head_sha(),
                "dist_fingerprint": tree_fingerprint(REPO / "dist"),
                "command": run["command"],
                "node": subprocess.run(
                    ["node", "--version"], text=True, capture_output=True, check=True
                ).stdout.strip(),
            },
            server={"before": before, "after": after},
            context={
                "announced_window": before["announced_context_window"],
                "harness_cap": config["harness_context_cap"],
                "observed_prompt_tokens_last": stats.get("promptTokensLast")
                if stats
                else None,
            },
            execution={
                "exit_code": run["exit_code"],
                "timed_out": run["timed_out"],
                "wall_seconds": run["wall_seconds"],
                "model_calls": stats.get("modelCalls") if stats else None,
                "tool_calls": stats.get("toolCalls") if stats else None,
                "generated_tokens": stats.get("generatedTokens") if stats else None,
                "compactions": len(
                    re.findall(r"compact(?:ion|ed)", run["stderr"], re.IGNORECASE)
                ),
                "resumes": run["stderr"].count("[resume]"),
                "human_interventions": 1 if overlay else 0,
                "stats": stats,
            },
            verification=verification,
        )
        write_json(output / "manifest.json", manifest)
    return manifest


def campaign(campaign_id=None):
    campaign_id = campaign_id or datetime.now(UTC).strftime("pilote-%Y%m%dT%H%M%SZ")
    manifests = []
    with campaign_lock():
        for arm, task_id in plan()["order"]:
            manifest = trial(arm, task_id, campaign_id)
            manifests.append(manifest)
            print(f"{arm} {task_id}: {manifest['status']}", flush=True)
    return campaign_id, manifests
