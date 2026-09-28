#!/bin/bash
# Fiches A d'une étude : docs/skills/ tel qu'au commit de référence de son
# protocole (champ fiches_a_ref), et non le docs/skills/ vivant, que les
# tickets suivants modifient. Sans référence : 309c396, pré-enregistrement de
# l'étude #33. Leurs empreintes sont celles du protocole (fiches_a) ; l'étude
# reste ainsi rejouable quand les fiches évoluent.
# Usage : fiches-a.sh <dossier> [référence]
set -euo pipefail
DEST="${1:?usage : fiches-a.sh <dossier> [référence]}"
FICHES_REF="${2:-309c396}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$DEST"
git -C "$REPO" ls-tree --name-only "$FICHES_REF" docs/skills/ | grep '\.md$' | while read -r f; do
  git -C "$REPO" show "$FICHES_REF:$f" > "$DEST/$(basename "$f")"
done
