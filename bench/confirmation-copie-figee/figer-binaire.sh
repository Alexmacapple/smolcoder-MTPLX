#!/bin/bash
# Étude #53 : fige dist/ et package.json de ce worktree (construits depuis le
# commit de base par npm ci --ignore-scripts puis npm run build) sous
# resultats/binaire/, par le script de l'étude #33. Le contrôle de démarrage
# (smol --version) tourne dans un dossier personnel jetable : le vrai
# ~/.smolcoder n'est jamais écrit. Affiche l'empreinte à inscrire au protocole.
# Usage : figer-binaire.sh
set -u
C="$(cd "$(dirname "$0")" && pwd)" || exit 1
[ -n "$(printenv ETUDE_BINAIRE_DIR 2>/dev/null || true)" ] || export ETUDE_BINAIRE_DIR="$C/resultats/binaire"
MAISON="$(mktemp -d "${TMPDIR:-/tmp}/etude53-maison.XXXXXX")" || exit 1
trap 'rm -rf "$MAISON"' EXIT
HOME="$MAISON" "$C/../lecons-fiches/figer-binaire.sh"
