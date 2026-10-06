"""Préconditions de l'hôte, MTPLX, verrou et arrêt de processus."""

import contextlib
import json
import os
import shutil
import signal
import subprocess
import time
import urllib.error
import urllib.request

from core import HERE, REPO, RESULTS, git, task


def request_json(url):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.URLError):
        return None


def mtplx_state(config):
    base = config["mtplx_url"].rstrip("/")
    models, snapshot = (
        request_json(f"{base}/v1/models"),
        request_json(f"{base}/v1/mtplx/snapshot"),
    )
    if not isinstance(models, dict) or not isinstance(snapshot, dict):
        return None
    rows = [row for row in models.get("data", []) if isinstance(row, dict)]
    expected = config["model_expected"]
    model = next((row for row in rows if row.get("id") == expected), None)
    if (
        model is None
        or snapshot.get("model_id") != expected
        or snapshot.get("active_requests") != 0
    ):
        return None
    return {
        "model": expected,
        "announced_context_window": model.get("context_length"),
        "snapshot": snapshot,
    }


def head_sha():
    return git(["rev-parse", "HEAD"], REPO).stdout.strip()


def clean_repo():
    return not git(
        ["status", "--porcelain", "--untracked-files=normal"], REPO
    ).stdout.strip()


def prepare_home(root, config):
    home, tmpdir = root / "home", root / "tmp"
    (home / ".smolcoder").mkdir(parents=True)
    tmpdir.mkdir()
    shutil.copy2(REPO / "docs/agents-md-global.md", home / ".smolcoder/AGENTS.md")
    (home / ".smolcoder.json").write_text(
        json.dumps(
            {
                "hosts": [{"address": config["mtplx_url"], "name": "mtplx"}],
                "lastModel": config["model_expected"],
                "lastModelUrl": config["mtplx_url"],
                "lastMode": "edit",
                "effort": None,
            }
        ),
        encoding="utf-8",
    )
    return home, tmpdir


def run_model(config, task_id, workspace, home, tmpdir):
    prompt = (HERE / task(task_id)["prompt"]).read_text(encoding="utf-8")
    command = [
        "node",
        str(REPO / "dist/index.js"),
        str(workspace),
        "--mode",
        "edit",
        "--model",
        config["model_expected"],
        "--ctx",
        str(config["harness_context_cap"]),
        "-p",
        prompt,
    ]
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "TMPDIR": str(tmpdir),
        "LANG": "fr_FR.UTF-8",
        "SMOL_NO_FICHES": "1",
    }
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        cwd=workspace,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=config["timeout_seconds"])
    except subprocess.TimeoutExpired:
        timed_out = True
        stdout, stderr = stop_process(process)
    return {
        "command": command,
        "stdout": stdout,
        "stderr": stderr,
        "timed_out": timed_out,
        "exit_code": 124 if timed_out else process.returncode,
        "wall_seconds": round(time.monotonic() - started, 3),
    }


@contextlib.contextmanager
def campaign_lock():
    RESULTS.mkdir(parents=True, exist_ok=True)
    lock = RESULTS / ".verrou-campagne"
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise RuntimeError(f"Verrou de campagne actif : {lock}") from error
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(f"{os.getpid()}\n")
    try:
        yield
    finally:
        try:
            if lock.read_text(encoding="utf-8").strip() == str(os.getpid()):
                lock.unlink()
        except FileNotFoundError:
            pass


def stop_process(process):
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        return process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        return process.communicate()
