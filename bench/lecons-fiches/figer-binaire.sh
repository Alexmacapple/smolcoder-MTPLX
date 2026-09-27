#!/bin/bash
# Fige une copie du binaire construit dans ce worktree (dist/ et package.json)
# sous resultats/binaire/ : tous les essais de l'étude tournent sur cette
# copie, jamais sur le smol installé, qui changera à la fusion d'autres
# tickets. La copie est en lecture seule ; son empreinte d'arborescence est
# inscrite dans protocole.json et vérifiée avant chaque essai.
# Usage : figer-binaire.sh
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO="$(git -C "$B" rev-parse --show-toplevel)" || exit 1
CIBLE="$B/resultats/binaire"
CIBLE_OVERRIDE="$(printenv ETUDE_BINAIRE_DIR 2>/dev/null || true)"
[ -n "$CIBLE_OVERRIDE" ] && CIBLE="$CIBLE_OVERRIDE"

[ -f "$REPO/dist/index.js" ] || { echo "dist/index.js absent : lancer npm run build d'abord" >&2; exit 2; }
if [ -e "$CIBLE" ]; then
  echo "Binaire déjà figé, non remplacé : $CIBLE" >&2
  python3 "$B/etude.py" empreinte-arbre "$CIBLE"
  exit 0
fi
mkdir -p "$CIBLE" || exit 1
cp -R "$REPO/dist" "$CIBLE/dist" || exit 1
cp "$REPO/package.json" "$CIBLE/package.json" || exit 1
chmod -R a-w "$CIBLE" || exit 1
node "$CIBLE/dist/index.js" --version >/dev/null || { echo "La copie figée ne démarre pas" >&2; exit 1; }
python3 "$B/etude.py" empreinte-arbre "$CIBLE"
