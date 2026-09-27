#!/bin/bash
# Mesure appariée de #19 : campagne du protocole. Bloc T1 à T3 sous le verrou
# du banc (paires dans l'ordre, avant puis après aux paires impaires, l'inverse
# aux paires), chaque essai invalide rejoué une fois à la même place ; puis,
# verrou libéré, bloc de sécurité par banc.sh (qui prend le verrou lui-même),
# chaque binaire trois fois par scénario, condition « avec ».
# Reprise : une cellule qui a un essai valide, ou déjà deux essais, n'est pas
# rejouée pour le SHA courant.
# Usage : campagne.sh [--taches | --securite]   (défaut : les deux blocs)
#         campagne.sh --extension <tâche>       (paires suivantes, règle point 4)
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
  echo "Usage : campagne.sh [--taches | --securite] | --extension <tâche>" >&2
  exit 2
}
MODE=tout
EXTENSION=""
case "${1:-}" in
  "") ;;
  --taches) MODE=taches ;;
  --securite) MODE=securite ;;
  --extension) MODE=extension; EXTENSION="${2:-}"; [ -n "$EXTENSION" ] || usage ;;
  *) usage ;;
esac

# Remplies par le plan (eval ci-dessous).
EMPREINTE_avant=""
EMPREINTE_apres=""
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
print(f"SCENARIOS={shlex.quote(' '.join(p['securite']['scenarios']))}")
print(f"REPETITIONS_SECURITE={p['securite']['repetitions']}")
print(f"CONDITION_SECURITE={shlex.quote(p['securite']['condition'])}")
print(f"BIN_RACINE={shlex.quote(os.path.expanduser(p['binaires_racine']))}")
print(f"MODELE_ATTENDU={shlex.quote(p['modele_attendu'])}")
print(f"ATTENTE={p['attente_mtplx_boucles']}")
print(f"VERROUS_EXTERNES={shlex.quote(' '.join(p.get('verrous_externes', [])))}")
for bras, v in p["bras"].items():
    print(f"EMPREINTE_{bras}={shlex.quote(v['empreinte_dist'])}")
PY
}
VALEURS="$(lire_plan)" || usage
eval "$VALEURS"
o="$(printenv MESURE_BIN_RACINE 2>/dev/null || true)"; [ -n "$o" ] && BIN_RACINE="$o"
o="$(printenv MESURE_MODELE_ATTENDU 2>/dev/null || true)"; [ -n "$o" ] && MODELE_ATTENDU="$o"
o="$(printenv MESURE_ATTENTE 2>/dev/null || true)"
case "$o" in ''|*[!0-9]*) ;; *) [ "$o" -gt 0 ] && ATTENTE="$o" ;; esac
[ -n "${MESURE_VERROUS_EXTERNES+x}" ] && VERROUS_EXTERNES="$(printenv MESURE_VERROUS_EXTERNES 2>/dev/null || true)"
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
RACINE_TMP="$(mktemp -d "${TMP_BASE%/}/mesure19-$CAMPAGNE_ID.XXXXXX")" || exit 1
export MESURE_TMP="$RACINE_TMP"
ENFANT_PID=""
SONDE_PID=""
fin_campagne() {
  [ -n "$SONDE_PID" ] && kill -KILL "$SONDE_PID" 2>/dev/null
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
journal "campagne $CAMPAGNE_ID ($MODE${EXTENSION:+ $EXTENSION}) sur $SHA ; noyau $(shasum -a 256 "$MAISON_SOURCE/.smolcoder/AGENTS.md" | cut -d' ' -f1)"

empreinte() { (cd "$BIN_RACINE/$1" && find dist -type f | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256 | cut -d' ' -f1; }
controler_binaires() {
  local bras attendue obtenue
  for bras in avant apres; do
    attendue="EMPREINTE_$bras"
    obtenue="$(empreinte "$bras" 2>/dev/null)"
    if [ "$obtenue" != "${!attendue}" ]; then
      journal "ARRÊT : empreinte de $bras $obtenue au lieu de ${!attendue} (chaîne de construction dérivée)"
      return 1
    fi
  done
}
controler_binaires || exit 5
journal "empreintes conformes : avant $EMPREINTE_avant, après $EMPREINTE_apres"

# « tâche paire bras valides essais » pour ce SHA.
etat_cellule() {
  python3 "$B/mesure.py" cellules "$RESULTATS_DIR" "$SHA" | awk -v c="$1 $2 $3" '
    index($0, c " ") == 1 { print $(NF-1), $NF; trouve=1 } END { if (!trouve) print 0, 0 }'
}
ordre_bras() { if [ $(( $1 % 2 )) -eq 1 ]; then echo "avant apres"; else echo "apres avant"; fi; }

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

jouer_paires() {
  local debut="$1" fin="$2" paire tache bras
  shift 2
  paire="$debut"
  while [ "$paire" -le "$fin" ]; do
    for tache in "$@"; do
      for bras in $(ordre_bras "$paire"); do
        jouer_cellule "$tache" "$paire" "$bras" || return 1
      done
    done
    paire=$((paire + 1))
  done
}

verrou_externe_actif() {
  local fichier pid
  for fichier in $VERROUS_EXTERNES; do
    [ -f "$fichier" ] || continue
    pid="$(sed -n '1p' "$fichier" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null && { echo "$fichier (PID $pid)"; return 0; }
  done
  return 1
}

maintenant() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
jouer_securite() {
  local scenario="$1" repetition="$2" bras="$3" valides essais dossier maison actif t0 t1 rc avant_banc attendue
  local cle="securite-$scenario"
  while true; do
    read -r valides essais < <(etat_cellule "$cle" "$repetition" "$bras")
    if [ "$valides" -ge 1 ]; then
      journal "déjà comptée : sécurité $scenario répétition $repetition $bras"
      return 0
    fi
    if [ "$essais" -ge 2 ]; then
      journal "invalide deux fois : sécurité $scenario répétition $repetition $bras (déclaré)"
      return 0
    fi
    attendue="EMPREINTE_$bras"
    if [ "$(empreinte "$bras" 2>/dev/null)" != "${!attendue}" ]; then
      journal "ARRÊT : empreinte de $bras différente"
      ARRET=1
      return 1
    fi
    dossier="$(mktemp -d "$RESULTATS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-securite-$scenario-r$repetition-$bras.XXXXXX")" || return 1
    avant_banc=ok
    actif=""
    for _ in $(seq 1 "$ATTENTE"); do
      actif="$(verrou_externe_actif)" || { actif=""; break; }
      sleep 5
    done
    [ -z "$actif" ] || avant_banc="Une autre campagne tient son verrou : $actif"
    maison="$(mktemp -d "$RACINE_TMP/securite-maison.XXXXXX")" || return 1
    mkdir -p "$maison/.smolcoder" "$RACINE_TMP/securite-tmp"
    cp "$MAISON_SOURCE/.smolcoder/AGENTS.md" "$maison/.smolcoder/AGENTS.md"
    cp "$MAISON_SOURCE/.smolcoder.json" "$maison/.smolcoder.json"
    journal "sécurité : $scenario répétition $repetition $bras, tentative $((essais + 1))"
    rc=""
    if [ "$avant_banc" = ok ]; then
      python3 "$B/mesure.py" sonde "$MTPLX_URL" "$dossier/sonde.jsonl" &
      SONDE_PID=$!
      t0="$(maintenant)"
      env -u BANC_LOCK_OWNER_PID HOME="$maison" TMPDIR="$RACINE_TMP/securite-tmp/" \
        BANC_SMOL_BIN="$BIN_RACINE/$bras/dist/index.js" BANC_RESULTS_DIR="$dossier" \
        BANC_LOCK_FILE="$LOCK_FILE" BANC_CAMPAIGN_ID="$CAMPAGNE_ID" BANC_REPEAT_INDEX="$repetition" \
        MTPLX_URL="$MTPLX_URL" "$REPO/bench/noyau-agents-md/banc.sh" "$scenario" "$CONDITION_SECURITE" \
        > "$dossier/banc-stdout.txt" 2> "$dossier/banc-stderr.txt" < /dev/null &
      ENFANT_PID=$!
      wait "$ENFANT_PID"
      rc=$?
      ENFANT_PID=""
      t1="$(maintenant)"
      kill -TERM "$SONDE_PID" 2>/dev/null
      wait "$SONDE_PID" 2>/dev/null
      SONDE_PID=""
      python3 "$B/mesure.py" concurrence "$dossier" "$REPO/bench/noyau-agents-md/consignes/$scenario.txt" \
        "$t0" "$t1" "$MTPLX_URL" > "$dossier/concurrence-resume.txt" 2>&1
    fi
    rm -rf "$maison"
    ENV_CAMPAGNE="$CAMPAGNE_ID" ENV_SCENARIO="$scenario" ENV_CONDITION="$CONDITION_SECURITE" \
      ENV_BRAS="$bras" ENV_REPETITION="$repetition" ENV_TENTATIVE="$((essais + 1))" ENV_BANC_RC="$rc" \
      ENV_SHA_HARNAIS="$SHA" ENV_HARNAIS_MODIFIE="$([ -z "$(git -C "$REPO" status --porcelain --untracked-files=normal)" ] && echo false || echo true)" \
      ENV_BIN_EMPREINTE="$(empreinte "$bras")" ENV_BIN_CMD="$BIN_RACINE/$bras/dist/index.js" \
      ENV_MODELE_ATTENDU="$MODELE_ATTENDU" ENV_AVANT_BANC="$avant_banc" \
      python3 "$B/mesure.py" enveloppe "$dossier" | tee -a "$JOURNAL" >&2
  done
}

bloc_taches() {
  prendre_verrou || { journal "verrou refusé : $LOCK_REASON"; return 4; }
  journal "verrou du banc pris : $LOCK_FILE"
  # shellcheck disable=SC2086 # liste de tâches du plan
  jouer_paires "$@"
  local rc=$?
  liberer_verrou
  journal "verrou du banc libéré"
  return "$rc"
}

bloc_securite() {
  local repetition scenario bras
  repetition=1
  while [ "$repetition" -le "$REPETITIONS_SECURITE" ]; do
    for scenario in $SCENARIOS; do
      for bras in $(ordre_bras "$repetition"); do
        jouer_securite "$scenario" "$repetition" "$bras" || return 1
      done
    done
    repetition=$((repetition + 1))
  done
}

case "$MODE" in
  tout|taches)
    # shellcheck disable=SC2086 # liste de tâches du plan
    bloc_taches 1 "$PAIRES" $TACHES || { journal "bloc T1 à T3 arrêté"; exit "$([ "$ARRET" -eq 1 ] && echo 5 || echo 1)"; }
    [ "$MODE" = tout ] && { bloc_securite || { journal "bloc de sécurité arrêté"; exit 5; }; }
    ;;
  securite)
    bloc_securite || { journal "bloc de sécurité arrêté"; exit 5; }
    ;;
  extension)
    # Règle, point 4 : l'extension n'est permise que pour une tâche dont les
    # réussites diffèrent d'exactement une sur les paires de base, décidée
    # sur ces seules réussites (analyse.py, étape « reussites »).
    DECISION="$(python3 "$B/analyse.py" "$RESULTATS_DIR" --sha "$SHA" --plan "$PLAN" --etape reussites --extension-de "$EXTENSION")" \
      || { journal "extension refusée pour $EXTENSION : $DECISION"; exit 6; }
    journal "extension décidée pour $EXTENSION : $DECISION"
    bloc_taches "$((PAIRES + 1))" "$PAIRES_EXTENSION" "$EXTENSION" || { journal "extension arrêtée"; exit 1; }
    ;;
esac
journal "campagne $CAMPAGNE_ID terminée"
exit 0
