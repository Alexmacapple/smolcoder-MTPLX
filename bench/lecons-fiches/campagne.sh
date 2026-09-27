#!/bin/bash
# Étude #33 : joue l'ordre pré-enregistré des essais (protocole.json) sous un
# verrou de campagne unique, puis rejoue les cellules non comptées
# (MTPLX indisponible, blocage avant lancement) au plus rejeux_max fois.
# Reprise : une cellule déjà comptée pour le SHA courant n'est pas rejouée.
# Usage : campagne.sh
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
PROTOCOLE="$B/protocole.json"
PROTOCOLE_OVERRIDE="$(printenv ETUDE_PROTOCOLE 2>/dev/null || true)"
[ -n "$PROTOCOLE_OVERRIDE" ] && PROTOCOLE="$PROTOCOLE_OVERRIDE"
export ETUDE_PROTOCOLE="$PROTOCOLE"
RESULTATS_DIR="$B/resultats"
RESULTATS_OVERRIDE="$(printenv ETUDE_RESULTATS_DIR 2>/dev/null || true)"
[ -n "$RESULTATS_OVERRIDE" ] && RESULTATS_DIR="$RESULTATS_OVERRIDE"
# shellcheck disable=SC2034 # lu par verrou-campagne.sh
LOCK_FILE="$RESULTATS_DIR/.verrou-campagne"
ORDRE_OVERRIDE="$(printenv ETUDE_ORDRE 2>/dev/null || true)"

[ $# -eq 0 ] || { echo "Usage : campagne.sh" >&2; exit 2; }
mkdir -p "$RESULTATS_DIR" || exit 1
source "$B/../noyau-agents-md/verrou-campagne.sh" || { echo "Bibliothèque de verrou absente" >&2; exit 1; }
unset BANC_LOCK_OWNER_PID
# shellcheck disable=SC2034 # lu et écrit par verrou-campagne.sh
LOCK_OWNED=0
LOCK_REASON=""
prendre_verrou || { echo "$LOCK_REASON" >&2; exit 4; }
CAMPAGNE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
JOURNAL="$RESULTATS_DIR/campagne-$CAMPAGNE_ID.log"
SHA="$(git -C "$B" rev-parse HEAD 2>/dev/null || echo inconnu)"
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

ordre() {
  if [ -n "$ORDRE_OVERRIDE" ]; then
    cat "$ORDRE_OVERRIDE"
  else
    python3 -c 'import json,sys; [print(*c) for c in json.load(open(sys.argv[1]))["ordre"]]' "$PROTOCOLE"
  fi
}
REJEUX_MAX="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rejeux_max"])' "$PROTOCOLE")"

deja_comptee() {
  python3 "$B/etude.py" comptees "$RESULTATS_DIR" "$SHA" | grep -qxF "$1 $2 $3 $4"
}

journal() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$JOURNAL" >&2; }

jouer_passe() {
  local passe="$1" lecon tache serie repetition rc
  while read -r lecon tache serie repetition; do
    [ -n "$lecon" ] || continue
    if deja_comptee "$lecon" "$tache" "$serie" "$repetition"; then
      [ "$passe" -eq 0 ] && journal "déjà comptée : $lecon $tache $serie $repetition"
      continue
    fi
    journal "passe $passe : $lecon $tache $serie répétition $repetition"
    trap '' HUP INT TERM
    BANC_LOCK_OWNER_PID="$$" BANC_LOCK_FILE="$LOCK_FILE" ETUDE_RESULTATS_DIR="$RESULTATS_DIR" \
      BANC_CAMPAIGN_ID="$CAMPAGNE_ID" "$B/essai.sh" "$lecon" "$tache" "$serie" "$repetition" < /dev/null &
    ENFANT_PID=$!
    trap interrompre_campagne HUP INT TERM
    wait "$ENFANT_PID"
    rc=$?
    ENFANT_PID=""
    journal "fin : $lecon $tache $serie $repetition, code $rc"
  done < <(ordre)
}

journal "campagne $CAMPAGNE_ID sur $SHA"
jouer_passe 0
passe=1
while [ "$passe" -le "$REJEUX_MAX" ]; do
  jouer_passe "$passe"
  passe=$((passe + 1))
done

MANQUANTES=0
while read -r lecon tache serie repetition; do
  [ -n "$lecon" ] || continue
  deja_comptee "$lecon" "$tache" "$serie" "$repetition" || { MANQUANTES=$((MANQUANTES + 1)); journal "non comptée : $lecon $tache $serie $repetition"; }
done < <(ordre)
if [ "$MANQUANTES" -eq 0 ]; then
  journal "campagne terminée : toutes les cellules sont comptées"
  exit 0
fi
journal "campagne terminée : $MANQUANTES cellule(s) non comptée(s), résultats conservés"
exit 1
