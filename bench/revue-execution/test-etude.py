#!/usr/bin/env python3
"""Vérifie que chaque changement candidat est visible par Git."""

import tempfile
from pathlib import Path

import etude


with tempfile.TemporaryDirectory(prefix="test-revue-execution-") as temp:
    root = Path(temp)
    for fixture in etude.FIXTURES:
        scratch = root / fixture
        output = scratch / "resultat"
        output.mkdir(parents=True)
        workspace = etude.stage_workspace(fixture, scratch, output)
        diff = (output / "diff.txt").read_text(encoding="utf-8")
        assert diff.startswith("diff --git "), fixture
        assert "reserve.js" in diff or "invoice.js" in diff, fixture
        assert workspace.is_dir(), fixture
print("PASS : trois diffs candidats visibles depuis reference")
