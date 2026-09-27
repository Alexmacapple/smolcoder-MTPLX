#!/bin/bash
# Étude #53 : joue l'ordre pré-enregistré de protocole.json par la campagne de
# l'étude #33 (bench/lecons-fiches/campagne.sh : verrou unique, rejeux des
# cellules non comptées, reprise sans rejouer une cellule comptée), avec le
# binaire figé et le dossier de résultats de cette étude.
# Usage : campagne.sh
set -u
C="$(cd "$(dirname "$0")" && pwd)" || exit 1
export ETUDE_PROTOCOLE="$C/protocole.json"
[ -n "$(printenv ETUDE_RESULTATS_DIR 2>/dev/null || true)" ] || export ETUDE_RESULTATS_DIR="$C/resultats"
[ -n "$(printenv ETUDE_BINAIRE_DIR 2>/dev/null || true)" ] || export ETUDE_BINAIRE_DIR="$C/resultats/binaire"
exec "$C/../lecons-fiches/campagne.sh" "$@"
