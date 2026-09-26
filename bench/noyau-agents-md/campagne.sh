#!/bin/bash
# Exécute des répétitions appariées avec/sans noyau sous un verrou unique.
# Usage : campagne.sh <répétitions> [bug|destructif|secret|injection|ajout ...]
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
RESULTATS_DIR="$B/resultats"
BANC_RESULTS_OVERRIDE="$(printenv BANC_RESULTS_DIR 2>/dev/null || true)"
[ -n "$BANC_RESULTS_OVERRIDE" ] && RESULTATS_DIR="$BANC_RESULTS_OVERRIDE"
LOCK_FILE="$RESULTATS_DIR/.verrou-campagne"
LOCK_FILE_OVERRIDE="$(printenv BANC_LOCK_FILE 2>/dev/null || true)"
[ -n "$LOCK_FILE_OVERRIDE" ] && LOCK_FILE="$LOCK_FILE_OVERRIDE"

usage() {
  echo "Usage : campagne.sh <répétitions> [bug|destructif|secret|injection|ajout ...]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
REPETITIONS="$1"
case "$REPETITIONS" in ''|*[!0-9]*) usage ;; esac
REPETITIONS=$((10#$REPETITIONS))
[ "$REPETITIONS" -gt 0 ] || usage
shift
if [ $# -eq 0 ]; then
  set -- bug destructif secret injection ajout
fi
for scenario in "$@"; do
  case "$scenario" in bug|destructif|secret|injection|ajout) ;; *) usage ;; esac
done

mkdir -p "$RESULTATS_DIR" || exit 1
source "$B/verrou-campagne.sh" || {
  echo "Bibliothèque de verrou absente : $B/verrou-campagne.sh" >&2
  exit 1
}
unset BANC_LOCK_OWNER_PID
LOCK_OWNED=0
LOCK_REASON=""
if ! prendre_verrou; then
  echo "$LOCK_REASON" >&2
  exit 4
fi
CAMPAGNE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ENFANT_PID=""
arreter_essai() {
  [ -n "$ENFANT_PID" ] || return 0
  kill -TERM "$ENFANT_PID" 2>/dev/null
  wait "$ENFANT_PID" 2>/dev/null
  ENFANT_PID=""
}
interrompre_campagne() {
  arreter_essai
  liberer_verrou
  exit 130
}
trap interrompre_campagne HUP INT TERM
trap liberer_verrou EXIT

ECHECS=0
for scenario in "$@"; do
  essai=1
  while [ "$essai" -le "$REPETITIONS" ]; do
    for condition in avec sans; do
      echo "Campagne : scénario=$scenario condition=$condition répétition=$essai/$REPETITIONS" >&2
      trap '' HUP INT TERM
      BANC_LOCK_OWNER_PID="$$" BANC_LOCK_FILE="$LOCK_FILE" BANC_RESULTS_DIR="$RESULTATS_DIR" \
        BANC_CAMPAIGN_ID="$CAMPAGNE_ID" BANC_REPEAT_INDEX="$essai" \
        "$B/banc.sh" "$scenario" "$condition" &
      ENFANT_PID=$!
      trap interrompre_campagne HUP INT TERM
      wait "$ENFANT_PID"
      rc=$?
      ENFANT_PID=""
      [ "$rc" -eq 0 ] || ECHECS=$((ECHECS + 1))
    done
    essai=$((essai + 1))
  done
done

if [ "$ECHECS" -eq 0 ]; then
  echo "Campagne terminée : toutes les répétitions ont un statut acceptable" >&2
  exit 0
fi
echo "Campagne terminée : $ECHECS essai(s) à statut non acceptable, résultats conservés" >&2
exit 1
