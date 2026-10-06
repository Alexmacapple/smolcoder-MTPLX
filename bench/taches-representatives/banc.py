"""Point d'entrée du banc #72."""

import argparse
import json
from pathlib import Path

from analysis import analyse
from core import (
    RESULTS,
    controler_protocole,
    plan,
    verifier,
)
from host import campaign_lock
from live import campaign, trial


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("controler")
    verify = commands.add_parser("verifier")
    verify.add_argument("task")
    verify.add_argument("workspace", type=Path)
    run = commands.add_parser("essai")
    run.add_argument("arm", choices=plan()["arms"])
    run.add_argument("task", choices=plan()["tasks"])
    run.add_argument("campaign")
    all_runs = commands.add_parser("campagne")
    all_runs.add_argument("--id")
    report = commands.add_parser("analyser")
    report.add_argument("results", type=Path)
    args = parser.parse_args()

    if args.command == "controler":
        errors = controler_protocole()
        print("\n".join(errors) if errors else "Protocole conforme")
        return 1 if errors else 0
    if args.command == "verifier":
        result = verifier(args.task, args.workspace)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["passed"] else 1
    if args.command == "essai":
        with campaign_lock():
            result = trial(args.arm, args.task, args.campaign)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] == "succes" else 1
    if args.command == "campagne":
        campaign_id, _ = campaign(args.id)
        print(RESULTS / campaign_id)
        return 0
    if args.command == "analyser":
        print(json.dumps(analyse(args.results), ensure_ascii=False, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
