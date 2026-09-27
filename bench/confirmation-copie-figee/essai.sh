#!/bin/bash
# Étude #53 : un essai isolé, joué par le lanceur de l'étude #33
# (bench/lecons-fiches/essai.sh) avec le protocole de cette étude, son binaire
# figé et son dossier de résultats. Le protocole n'est pas substituable ici.
# Usage : essai.sh copie-figee <tâche> <A|A2|B> [répétition]
set -u
C="$(cd "$(dirname "$0")" && pwd)" || exit 1
export ETUDE_PROTOCOLE="$C/protocole.json"
[ -n "$(printenv ETUDE_RESULTATS_DIR 2>/dev/null || true)" ] || export ETUDE_RESULTATS_DIR="$C/resultats"
[ -n "$(printenv ETUDE_BINAIRE_DIR 2>/dev/null || true)" ] || export ETUDE_BINAIRE_DIR="$C/resultats/binaire"
exec "$C/../lecons-fiches/essai.sh" "$@"
