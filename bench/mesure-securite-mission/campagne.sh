#!/bin/bash
# Mesure #52 : campagne du protocole, sous le verrou du banc tenu du premier au
# dernier essai. Répétition r de 1 à 5 ; pour chaque scénario du plan
# (destructif, injection, secret), les deux conditions appariées, témoin puis
# mission aux répétitions impaires, l'inverse aux paires. Chaque essai invalide
# est rejoué une fois à la même place. Reprise : une cellule qui a un essai
# valide, ou déjà deux essais, n'est pas rejouée pour le SHA courant.
# Usage : campagne.sh
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
PY="$(command -v python3)" || { echo "python3 est requis" >&2; exit 4; }
export PATH="/opt/homebrew/bin:$PATH"
REPO="$(git -C "$B" rev-parse --show-toplevel)" || exit 1
PLAN="${MESURE_PLAN:-$B/plan.json}"
export MESURE_PLAN="$PLAN"
RESULTATS_DIR="${MESURE_RESULTATS_DIR:-$B/resultats}"
case "$RESULTATS_DIR" in /*) ;; *) RESULTATS_DIR="$REPO/$RESULTATS_DIR" ;; esac
export MESURE_RESULTATS_DIR="$RESULTATS_DIR"
MTPLX_URL_DEMANDEE="${MTPLX_URL:-}"
# shellcheck disable=SC2034 # lu par verrou-campagne.sh
LOCK_FILE="${BANC_LOCK_FILE:-$REPO/bench/noyau-agents-md/resultats/.verrou-campagne}"
MAISON_REELLE="${MESURE_MAISON_SOURCE:-$HOME}"

[ $# -eq 0 ] || { echo "Usage : campagne.sh" >&2; exit 2; }

# Remplies par le plan (eval ci-dessous).
BIN_RACINE=""; EMPREINTE_ATTENDUE=""; SCENARIOS=""; REPETITIONS=""; CALME=""; CALME_REJEU=""; MTPLX_URL_ATTENDUE=""
VALEURS="$("$PY" "$B/securite.py" plan)" || exit 2
eval "$VALEURS"
[ -n "${MESURE_BIN_RACINE:-}" ] && BIN_RACINE="$MESURE_BIN_RACINE"
if [ -n "$MTPLX_URL_ATTENDUE" ]; then
  [ -z "$MTPLX_URL_DEMANDEE" ] || [ "$MTPLX_URL_DEMANDEE" = "$MTPLX_URL_ATTENDUE" ] \
    || { echo "MTPLX_URL diffère de la cible figée du plan" >&2; exit 2; }
  MTPLX_URL="$MTPLX_URL_ATTENDUE"
else
  MTPLX_URL="${MTPLX_URL_DEMANDEE:-http://127.0.0.1:8000}"
fi
export MTPLX_URL
case "${MESURE_CALME_S:-}" in ''|*[!0-9]*) ;; *) CALME="$MESURE_CALME_S" ;; esac
case "${MESURE_CALME_REJEU_S:-}" in ''|*[!0-9]*) ;; *) CALME_REJEU="$MESURE_CALME_REJEU_S" ;; esac
PAS_CALME="${MESURE_CALME_PAS:-2}"

SHA="$(git -C "$REPO" rev-parse HEAD)"
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=normal)" ] \
  && [ "${MESURE_ACCEPTER_MODIFIE:-}" != 1 ]; then
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

TMP_BASE="${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp)}"
RACINE_TMP="$(mktemp -d "${TMP_BASE%/}/mesure52-$CAMPAGNE_ID.XXXXXX")" || exit 1
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

prendre_verrou || { journal "verrou refusé : $LOCK_REASON"; exit 4; }
journal "verrou du banc pris : $LOCK_FILE"

# Noyau et configuration figés pour toute la campagne : chaque essai en copie
# ces fichiers dans son dossier personnel jetable ; le vrai ~ n'est que lu.
MAISON_SOURCE="$RESULTATS_DIR/campagne-$CAMPAGNE_ID-maison"
mkdir -p "$MAISON_SOURCE/.smolcoder" \
  && cp "$MAISON_REELLE/.smolcoder/AGENTS.md" "$MAISON_SOURCE/.smolcoder/AGENTS.md" \
  && cp "$MAISON_REELLE/.smolcoder.json" "$MAISON_SOURCE/.smolcoder.json" \
  || { journal "noyau ou configuration illisible dans $MAISON_REELLE"; exit 4; }
export MESURE_MAISON_SOURCE="$MAISON_SOURCE"
journal "campagne $CAMPAGNE_ID sur $SHA ; noyau $(shasum -a 256 "$MAISON_SOURCE/.smolcoder/AGENTS.md" | cut -d' ' -f1)"

EMPREINTE="$( (cd "$BIN_RACINE" && find dist -type f | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256 | cut -d' ' -f1)"
if [ "$EMPREINTE" != "$EMPREINTE_ATTENDUE" ]; then
  journal "ARRÊT : empreinte de dist/ $EMPREINTE au lieu de $EMPREINTE_ATTENDUE (chaîne de construction dérivée)"
  exit 5
fi
journal "empreinte du binaire conforme : $EMPREINTE"

etat_cellule() {
  "$PY" "$B/securite.py" cellules "$RESULTATS_DIR" "$SHA" | awk -v c="$1 $2 $3" '
    index($0, c " ") == 1 { print $(NF-1), $NF; trouve=1 } END { if (!trouve) print 0, 0 }'
}
ordre_conditions() { if [ $(( $1 % 2 )) -eq 1 ]; then echo "temoin mission"; else echo "mission temoin"; fi; }

# Fenêtre calme (écart opérationnel déclaré dans le rapport, sans effet sur
# la règle) : avant chaque essai, et plus longuement avant un rejeu, MTPLX
# sans requête active, en vol ni terminée pendant la fenêtre ; attente sans
# limite, jamais comptée comme une tentative. Alex utilise MTPLX par
# intermittence ; une requête étrangère pendant un essai reste une invalidité.
attendre_calme() {
  local fenetre="$1" rc
  journal "attente d'une fenêtre calme de $fenetre s"
  "$PY" "$B/securite.py" calme "$MTPLX_URL" "$fenetre" "$PAS_CALME" \
    > "$RESULTATS_DIR/.calme.out" 2>> "$JOURNAL" < /dev/null &
  ENFANT_PID=$!
  wait "$ENFANT_PID"
  rc=$?
  ENFANT_PID=""
  [ "$rc" -eq 0 ] || { journal "attente de la fenêtre calme en échec (code $rc)"; return 1; }
  journal "fenêtre calme obtenue : $(cat "$RESULTATS_DIR/.calme.out")"
}

jouer_cellule() {
  local scenario="$1" repetition="$2" condition="$3" valides essais rc
  while true; do
    read -r valides essais < <(etat_cellule "$scenario" "$repetition" "$condition")
    if [ "$valides" -ge 1 ]; then
      journal "déjà comptée : $scenario r$repetition $condition"
      return 0
    fi
    if [ "$essais" -ge 2 ]; then
      journal "invalide deux fois : $scenario r$repetition $condition (cellule déclarée manquante)"
      return 0
    fi
    attendre_calme "$([ "$essais" -ge 1 ] && echo "$CALME_REJEU" || echo "$CALME")" || return 1
    journal "essai : $scenario r$repetition $condition, tentative $((essais + 1))"
    BANC_LOCK_OWNER_PID="$$" BANC_LOCK_FILE="$LOCK_FILE" BANC_CAMPAIGN_ID="$CAMPAGNE_ID" \
      "$B/essai.sh" "$condition" "$scenario" "$repetition" "$((essais + 1))" < /dev/null &
    ENFANT_PID=$!
    wait "$ENFANT_PID"
    rc=$?
    ENFANT_PID=""
    journal "fin : $scenario r$repetition $condition, code $rc"
    if [ "$rc" -eq 5 ]; then
      journal "ARRÊT : empreinte de binaire différente"
      return 1
    fi
  done
}

repetition=1
while [ "$repetition" -le "$REPETITIONS" ]; do
  for scenario in $SCENARIOS; do
    for condition in $(ordre_conditions "$repetition"); do
      jouer_cellule "$scenario" "$repetition" "$condition" || { journal "campagne arrêtée"; exit 5; }
    done
  done
  repetition=$((repetition + 1))
done
journal "campagne $CAMPAGNE_ID terminée"
exit 0
