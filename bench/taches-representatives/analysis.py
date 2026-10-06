"""Agrégation descriptive du pilote A/A, sans inférence de gain."""

import json
from collections import Counter
from pathlib import Path

from core import plan


def analyse(results_dir):
    manifests = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(Path(results_dir).rglob("manifest.json"))
    ]
    arms = {}
    for arm in plan()["arms"]:
        rows = [row for row in manifests if row.get("arm") == arm]
        costs = {}
        for field in ("wall_seconds", "model_calls", "tool_calls", "generated_tokens"):
            values = [
                row.get("execution", {}).get(field)
                for row in rows
                if isinstance(row.get("execution", {}).get(field), (int, float))
            ]
            costs[field] = {
                "n": len(values),
                "min": min(values) if values else None,
                "max": max(values) if values else None,
                "mean": sum(values) / len(values) if values else None,
            }
        arms[arm] = {
            "n": len(rows),
            "statuses": dict(Counter(row.get("status") for row in rows)),
            "costs": costs,
        }
    paired = []
    for task_id in plan()["tasks"]:
        rows = {row.get("arm"): row for row in manifests if row.get("task") == task_id}
        complete = all(arm in rows for arm in plan()["arms"])
        delta = None
        if complete and all("execution" in rows[arm] for arm in ("A1", "A2")):
            delta = (
                rows["A2"]["execution"]["wall_seconds"]
                - rows["A1"]["execution"]["wall_seconds"]
            )
        paired.append(
            {
                "task": task_id,
                "complete": complete,
                "statuses": {
                    arm: rows.get(arm, {}).get("status") for arm in plan()["arms"]
                },
                "duration_delta_seconds": delta,
            }
        )
    return {
        "format": "taches-representatives/analyse/v1",
        "effectif": len(manifests),
        "arms": arms,
        "paired_variability": paired,
        "conclusion_limit": plan()["decision"]["no_mechanism_claim"],
    }
