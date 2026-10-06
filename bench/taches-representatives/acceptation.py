"""Oracle externe des trois tâches : ce fichier n'entre jamais dans la fixture."""

import importlib
import subprocess
import sys
from pathlib import Path


def load(workspace, module):
    sys.path.insert(0, str(workspace))
    try:
        return importlib.import_module(module)
    finally:
        sys.path.pop(0)


def unit_tests(workspace):
    return subprocess.run(
        [sys.executable, "-m", "unittest", "-q"],
        cwd=workspace,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        text=True,
    )


def main():
    task_id, workspace_arg = sys.argv[1:3]
    workspace = Path(workspace_arg).resolve()
    result = unit_tests(workspace)
    if result.returncode != 0:
        print(result.stdout)
        return 1

    if task_id == "multi-fichiers":
        invoice = load(workspace, "invoice")
        lines = [
            {"unit_price": 10, "quantity": 2},
            {"unit_price": 2.5, "quantity": 4},
        ]
        assert invoice.total(lines, 0.2) == 36.0
        assert invoice.render(lines, 0.2, "EUR") == "36.00 EUR"
    elif task_id == "ajout-limite":
        cli = load(workspace, "cli")
        tasks = [
            {"title": "A", "due": "2026-10-06"},
            {"title": "B", "due": "2026-10-08"},
            {"title": "C"},
            {"title": "D", "due": "2026-10-05", "done": True},
        ]
        assert [task["title"] for task in cli.list_tasks(tasks, "2026-10-07")] == ["A"]
    elif task_id == "preservation":
        service = load(workspace, "service")
        assert (
            service.endpoint("http://localhost:8000/", "/health")
            == "http://localhost:8000/health"
        )
        assert (
            service.endpoint("http://localhost:8000", "health")
            == "http://localhost:8000/health"
        )
    else:
        raise ValueError(f"Tâche inconnue : {task_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
