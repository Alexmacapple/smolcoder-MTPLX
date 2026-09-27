#!/bin/bash
# Fiches A de l'étude #33 : docs/skills/ tel qu'au commit de pré-enregistrement
# 309c396, et non le docs/skills/ vivant, que les tickets suivants modifient.
# Leurs empreintes sont celles de protocole.json (fiches_a) ; l'étude reste
# ainsi rejouable quand les fiches évoluent. Usage : fiches-a.sh <dossier>.
set -euo pipefail
FICHES_REF=309c396
DEST="${1:?usage : fiches-a.sh <dossier>}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$DEST"
git -C "$REPO" ls-tree --name-only "$FICHES_REF" docs/skills/ | grep '\.md$' | while read -r f; do
  git -C "$REPO" show "$FICHES_REF:$f" > "$DEST/$(basename "$f")"
done
