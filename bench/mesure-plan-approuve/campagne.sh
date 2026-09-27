#!/bin/bash
# Mesure appariée de #29 : campagne du protocole
# (docs/protocole-mesure-plan-approuve.md, « Fichiers du protocole »), sous le
# verrou du banc, pris avant la première sonde et gardé jusqu'au dernier
# essai. Ordre du protocole : tâche après tâche, répétitions 1 à 5, sans puis
# avec aux répétitions impaires, l'inverse aux paires. Un essai invalide est
# rejoué une fois à la même place (règle, point 1).
# Reprise : une cellule qui a un essai valide, ou déjà deux essais, n'est pas
# rejouée pour le SHA courant.
# Usage : campagne.sh                     (les cinq paires de chaque tâche)
#         campagne.sh --extension <tâche> (paires 6 à 10, règle point 6)
set -u

export PATH="/opt/homebrew/bin:$PATH"
B="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO="$(git -C "$B" rev-parse --show-toplevel)" || exit 1
PLAN="$B/plan.json"
PLAN_OVERRIDE="$(printenv MESURE_PLAN 2>/dev/null || true)"
[ -n "$PLAN_OVERRIDE" ] && PLAN="$PLAN_OVERRIDE"
export MESURE_PLAN="$PLAN"
RESULTATS_DIR="$B/resultats"
RESULTATS_OVERRIDE="$(printenv MESURE_RESULTATS_DIR 2>/dev/null || true)"
[ -n "$RESULTATS_OVERRIDE" ] && RESULTATS_DIR="$RESULTATS_OVERRIDE"
export MESURE_RESULTATS_DIR="$RESULTATS_DIR"
MTPLX_OVERRIDE="$(printenv MTPLX_URL 2>/dev/null || true)"
MTPLX_URL="http://127.0.0.1:8000"
[ -n "$MTPLX_OVERRIDE" ] && MTPLX_URL="$MTPLX_OVERRIDE"
export MTPLX_URL
# shellcheck disable=SC2034 # lu par verrou-campagne.sh
LOCK_FILE="$REPO/bench/noyau-agents-md/resultats/.verrou-campagne"
LOCK_OVERRIDE="$(printenv BANC_LOCK_FILE 2>/dev/null || true)"
[ -n "$LOCK_OVERRIDE" ] && LOCK_FILE="$LOCK_OVERRIDE"
MAISON_REELLE="$(printenv MESURE_MAISON_SOURCE 2>/dev/null || true)"
[ -n "$MAISON_REELLE" ] || MAISON_REELLE="$HOME"

usage() {
  echo "Usage : campagne.sh [--extension <tâche>]" >&2
  exit 2
}
MODE=base
EXTENSION=""
case "${1:-}" in
  "") ;;
  --extension) MODE=extension; EXTENSION="${2:-}"; [ -n "$EXTENSION" ] || usage ;;
  *) usage ;;
esac

EMPREINTE=""
BIN_RACINE=""
lire_plan() {
  python3 - "$PLAN" <<'PY'
import json
import os
import shlex
import sys

p = json.load(open(sys.argv[1], encoding="utf-8"))
print(f"TACHES={shlex.quote(' '.join(p['taches']))}")
print(f"PAIRES={p['paires']}")
print(f"PAIRES_EXTENSION={p['paires_extension']}")
print(f"BIN_RACINE={shlex.quote(os.path.expanduser(p['binaire']['racine']))}")
print(f"EMPREINTE={shlex.quote(p['binaire']['empreinte_dist'])}")
PY
}
VALEURS="$(lire_plan)" || usage
eval "$VALEURS"
o="$(printenv MESURE_BIN_RACINE 2>/dev/null || true)"; [ -n "$o" ] && BIN_RACINE="$o"
if [ "$MODE" = extension ]; then
  case " $TACHES " in *" $EXTENSION "*) ;; *) usage ;; esac
fi

SHA="$(git -C "$REPO" rev-parse HEAD)"
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=normal)" ] \
  && [ "$(printenv MESURE_ACCEPTER_MODIFIE 2>/dev/null || true)" != 1 ]; then
  echo "Arbre de travail modifié : commiter le runner avant tout essai" >&2
  exit 4
fi
mkdir -p "$RESULTATS_DIR" "$(dirname "$LOCK_FILE")" || exit 1
source "$REPO/bench/noyau-agents-md/verrou-campagne.sh" || { echo "Bibliothèque de verrou absente" >&2; exit 1; }
unset BANC_LOCK_OWNER_PID
# shellcheck disable=SC2034 # lu et écrit par verrou-campagne.sh
LOCK_OWNED=0
LOCK_REASON=""
CAMPAGNE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
JOURNAL="$RESULTATS_DIR/campagne-$CAMPAGNE_ID.log"
journal() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$JOURNAL" >&2; }

TMP_BASE="$(printenv TMPDIR 2>/dev/null || true)"
[ -n "$TMP_BASE" ] || TMP_BASE="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
[ -n "$TMP_BASE" ] || TMP_BASE=/tmp
RACINE_TMP="$(mktemp -d "${TMP_BASE%/}/mesure29-$CAMPAGNE_ID.XXXXXX")" || exit 1
export MESURE_TMP="$RACINE_TMP"
ENFANT_PID=""
fin_campagne() {
  liberer_verrou
  chmod -R u+w "$RACINE_TMP" 2>/dev/null
  rm -rf "$RACINE_TMP"
}
interrompre_campagne() {
  [ -n "$ENFANT_PID" ] && kill -TERM "$ENFANT_PID" 2>/dev/null && wait "$ENFANT_PID" 2>/dev/null
  journal "campagne interrompue"
  fin_campagne
  exit 130
}
trap interrompre_campagne HUP INT TERM
trap fin_campagne EXIT

# Noyau et configuration figés pour toute la campagne : chaque essai en copie
# ces fichiers dans son dossier personnel jetable ; le vrai ~ n'est que lu.
MAISON_SOURCE="$RESULTATS_DIR/campagne-$CAMPAGNE_ID-maison"
mkdir -p "$MAISON_SOURCE/.smolcoder" \
  && cp "$MAISON_REELLE/.smolcoder/AGENTS.md" "$MAISON_SOURCE/.smolcoder/AGENTS.md" \
  && cp "$MAISON_REELLE/.smolcoder.json" "$MAISON_SOURCE/.smolcoder.json" \
  || { echo "Noyau ou configuration illisible dans $MAISON_REELLE" >&2; exit 4; }
export MESURE_MAISON_SOURCE="$MAISON_SOURCE"
journal "campagne $CAMPAGNE_ID ($MODE${EXTENSION:+ $EXTENSION}) sur $SHA ; noyau $(shasum -a 256 "$MAISON_SOURCE/.smolcoder/AGENTS.md" | cut -d' ' -f1) ; configuration $(shasum -a 256 "$MAISON_SOURCE/.smolcoder.json" | cut -d' ' -f1)"

OBTENUE="$( (cd "$BIN_RACINE" && find dist -type f | LC_ALL=C sort | xargs shasum -a 256) 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
if [ "$OBTENUE" != "$EMPREINTE" ]; then
  journal "ARRÊT : empreinte de dist/ $OBTENUE au lieu de $EMPREINTE (chaîne de construction dérivée)"
  exit 5
fi
journal "empreinte de dist/ conforme : $EMPREINTE"

# « tâche paire bras valides essais » pour ce SHA.
etat_cellule() {
  python3 "$B/mesure.py" cellules "$RESULTATS_DIR" "$SHA" | awk -v c="$1 $2 $3" '
    index($0, c " ") == 1 { print $(NF-1), $NF; trouve=1 } END { if (!trouve) print 0, 0 }'
}
ordre_bras() { if [ $(( $1 % 2 )) -eq 1 ]; then echo "sans avec"; else echo "avec sans"; fi; }

ARRET=0
jouer_cellule() {
  local tache="$1" paire="$2" bras="$3" valides essais rc
  while true; do
    read -r valides essais < <(etat_cellule "$tache" "$paire" "$bras")
    if [ "$valides" -ge 1 ]; then
      journal "déjà comptée : $tache paire $paire $bras"
      return 0
    fi
    if [ "$essais" -ge 2 ]; then
      journal "invalide deux fois : $tache paire $paire $bras (paire écartée)"
      return 0
    fi
    journal "essai : $tache paire $paire $bras, tentative $((essais + 1))"
    BANC_LOCK_OWNER_PID="$$" BANC_LOCK_FILE="$LOCK_FILE" BANC_CAMPAIGN_ID="$CAMPAGNE_ID" \
      "$B/essai.sh" "$bras" "$tache" "$paire" "$((essais + 1))" < /dev/null &
    ENFANT_PID=$!
    wait "$ENFANT_PID"
    rc=$?
    ENFANT_PID=""
    journal "fin : $tache paire $paire $bras, code $rc"
    if [ "$rc" -eq 5 ]; then
      journal "ARRÊT : empreinte de binaire différente"
      ARRET=1
      return 1
    fi
  done
}

# Déroulé du protocole : tâche après tâche, puis répétition, puis bras.
jouer() {
  local debut="$1" fin="$2" tache paire bras
  shift 2
  for tache in "$@"; do
    paire="$debut"
    while [ "$paire" -le "$fin" ]; do
      for bras in $(ordre_bras "$paire"); do
        jouer_cellule "$tache" "$paire" "$bras" || return 1
      done
      paire=$((paire + 1))
    done
  done
}

# Règle, point 6 : une extension à dix paires, pour une tâche dont les
# réussites diffèrent d'exactement une sur les paires de base, décidée sur ces
# seules réussites (analyse.py, étape « reussites »), avant toute autre mesure.
etendre() {
  local tache="$1" decision
  decision="$(python3 "$B/analyse.py" "$RESULTATS_DIR" --sha "$SHA" --plan "$PLAN" --etape reussites --extension-de "$tache")"
  if [ $? -ne 0 ]; then
    journal "pas d'extension pour $tache : $(printf '%s\n' "$decision" | grep "^$tache :")"
    return 2
  fi
  journal "extension décidée pour $tache : $(printf '%s\n' "$decision" | grep "^$tache :")"
  jouer "$((PAIRES + 1))" "$PAIRES_EXTENSION" "$tache"
}

prendre_verrou || { journal "verrou refusé : $LOCK_REASON"; exit 4; }
journal "verrou du banc pris : $LOCK_FILE"
RC=0
case "$MODE" in
  base)
    # shellcheck disable=SC2086 # liste de tâches du plan
    if jouer 1 "$PAIRES" $TACHES; then
      for tache in $TACHES; do
        etendre "$tache"
        [ $? -eq 1 ] && { RC=1; break; }
      done
    else
      RC=1
    fi
    ;;
  extension)
    etendre "$EXTENSION"
    case $? in 0) ;; 2) RC=6 ;; *) RC=1 ;; esac
    ;;
esac
liberer_verrou
journal "verrou du banc libéré"
if [ "$RC" -ne 0 ]; then
  [ "$ARRET" -eq 1 ] && RC=5
  journal "campagne $CAMPAGNE_ID arrêtée (code $RC)"
  exit "$RC"
fi
journal "campagne $CAMPAGNE_ID terminée"
exit 0
