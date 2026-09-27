#!/bin/bash
# Campagne OS du chapeau #12 (ticket #18) : rejoue sur ce Mac `npm test` puis
# `npm run test:os` (backend Seatbelt et vrai binaire de bout en bout), sous
# le verrou de campagne du banc, et archive un dossier horodaté avec son
# manifeste « campagne-os/v1 » : SHA du harnais, version de macOS, présence
# de sandbox-exec, statut par critère du chapeau #12, durées. Aucun modèle
# n'est appelé. Protocole : docs/campagne-os-2026-09-27.md.
# Usage : campagne.sh
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO="$(git -C "$B" rev-parse --show-toplevel 2>/dev/null || (cd "$B/../.." && pwd))"
RESULTATS_DIR="$B/resultats"
RESULTS_OVERRIDE="$(printenv CAMPAGNE_OS_RESULTS_DIR 2>/dev/null || true)"
[ -n "$RESULTS_OVERRIDE" ] && RESULTATS_DIR="$RESULTS_OVERRIDE"
# shellcheck disable=SC2034 # lu par verrou-campagne.sh
LOCK_FILE="$RESULTATS_DIR/.verrou-campagne"
NPM_BIN=npm
NPM_OVERRIDE="$(printenv CAMPAGNE_OS_NPM 2>/dev/null || true)"
[ -n "$NPM_OVERRIDE" ] && NPM_BIN="$NPM_OVERRIDE"
SANDBOX_EXEC=/usr/bin/sandbox-exec
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"

[ $# -eq 0 ] || { echo "Usage : campagne.sh" >&2; exit 2; }
command -v node >/dev/null || { echo "node est requis pour écrire le manifeste de la campagne" >&2; exit 4; }

horodatage() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
compter() { if [ -d "$1" ]; then find "$1" 2>/dev/null | wc -l | tr -d ' '; else echo 0; fi; }

mkdir -p "$RESULTATS_DIR" || exit 1
OUT="$(mktemp -d "$RESULTATS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-campagne-os.XXXXXX")" || exit 1
RUN_ID="$(basename "$OUT")"
MANIFEST="$OUT/manifeste.json"
DEBUTE_LE="$(horodatage)"
TERMINE_LE=""
BLOCAGE="Run initialisé, en attente des préconditions"
UNIT_RC=""; UNIT_DUREE=""; OS_RC=""; OS_DUREE=""
NPM_AVANT=""; NPM_APRES=""; SMOL_AVANT=""; SMOL_APRES=""

SHA_HARNAIS="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo inconnu)"
BRANCHE="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
HARNAIS_MODIFIE=inconnu
if ETAT="$(git -C "$REPO" status --porcelain 2>/dev/null)"; then
  [ -z "$ETAT" ] && HARNAIS_MODIFIE=false || HARNAIS_MODIFIE=true
fi
SYSTEME="$(uname -s)"
ARCH="$(uname -m)"
MACOS_VERSION=""; MACOS_BUILD=""
if [ "$SYSTEME" = Darwin ]; then
  MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || true)"
  MACOS_BUILD="$(sw_vers -buildVersion 2>/dev/null || true)"
fi
SANDBOX_EXEC_PRESENT=0
[ -x "$SANDBOX_EXEC" ] && SANDBOX_EXEC_PRESENT=1
NODE_VERSION="$(node --version 2>/dev/null || true)"
NPM_VERSION="" # demandé à npm une fois le verrou pris : rien ne tourne avant

ecrire_manifeste() {
  RUN_ID="$RUN_ID" DEBUTE_LE="$DEBUTE_LE" TERMINE_LE="$TERMINE_LE" BLOCAGE="$BLOCAGE" \
    SHA_HARNAIS="$SHA_HARNAIS" HARNAIS_MODIFIE="$HARNAIS_MODIFIE" BRANCHE="$BRANCHE" \
    SYSTEME="$SYSTEME" MACOS_VERSION="$MACOS_VERSION" MACOS_BUILD="$MACOS_BUILD" ARCH="$ARCH" \
    NODE_VERSION="$NODE_VERSION" NPM_VERSION="$NPM_VERSION" \
    SANDBOX_EXEC="$SANDBOX_EXEC" SANDBOX_EXEC_PRESENT="$SANDBOX_EXEC_PRESENT" \
    UNIT_RC="$UNIT_RC" UNIT_DUREE="$UNIT_DUREE" OS_RC="$OS_RC" OS_DUREE="$OS_DUREE" \
    NPM_AVANT="$NPM_AVANT" NPM_APRES="$NPM_APRES" SMOL_AVANT="$SMOL_AVANT" SMOL_APRES="$SMOL_APRES" \
    node "$B/manifeste.cjs" "$OUT"
}

terminer() {
  BLOCAGE="$1"
  TERMINE_LE="$(horodatage)"
  ecrire_manifeste || { echo "Échec d’écriture du manifeste : $MANIFEST" >&2; exit 1; }
  echo "Campagne enregistrée : $OUT" >&2
  echo "Statut : blocage_harnais — $1" >&2
  exit "$2"
}

source "$B/../noyau-agents-md/verrou-campagne.sh" || { echo "Bibliothèque de verrou absente" >&2; exit 1; }
unset BANC_LOCK_OWNER_PID
# shellcheck disable=SC2034 # lu et écrit par verrou-campagne.sh
LOCK_OWNED=0
LOCK_REASON=""
interrompre() {
  BLOCAGE="Campagne interrompue avant un verdict vérifiable"
  TERMINE_LE="$(horodatage)"
  ecrire_manifeste || true
  liberer_verrou
  exit 130
}
trap interrompre HUP INT TERM
trap liberer_verrou EXIT
ecrire_manifeste || { echo "Échec d’écriture du manifeste initial : $MANIFEST" >&2; exit 1; }
prendre_verrou || terminer "$LOCK_REASON" 4

[ "$SYSTEME" = Darwin ] || terminer "La campagne OS exige macOS (ce système : $SYSTEME)" 4
[ "$SANDBOX_EXEC_PRESENT" = 1 ] || terminer "$SANDBOX_EXEC est absent ou non exécutable" 4

# npm n'écrit ni journal ni avis de mise à jour dans ~/.npm : ils restent dans
# le dossier du run. Les tests posent leurs propres dossiers personnels ; les
# témoins ci-dessous comptent les entrées du vrai ~/.npm et du vrai
# ~/.smolcoder avant et après.
export npm_config_logs_dir="$OUT/npm-journaux"
export npm_config_update_notifier=false
# Lancée depuis un autre lanceur de tests, la campagne ne lui renvoie rien :
# ses suites écrivent leurs propres rapports.
unset NODE_TEST_CONTEXT
NPM_AVANT="$(compter "$HOME/.npm")"
NPM_VERSION="$("$NPM_BIN" --version 2>/dev/null || true)"
[ -n "$NPM_VERSION" ] || terminer "npm est introuvable ($NPM_BIN)" 4
SMOL_AVANT="$(compter "$HOME/.smolcoder")"
BLOCAGE=""
cd "$REPO" || terminer "Dépôt du harnais introuvable : $REPO" 4

# Sortie lisible (spec) dans le fichier de la suite, une ligne JSON par test
# (rapporteur.mjs) dans son rapport.
RAPPORTEURS=(--test-reporter=spec --test-reporter-destination=stdout "--test-reporter=$B/rapporteur.mjs")

echo "Campagne OS : npm test" >&2
debut=$(date +%s)
"$NPM_BIN" test -- "${RAPPORTEURS[@]}" "--test-reporter-destination=$OUT/tests-unitaires.jsonl" > "$OUT/npm-test.txt" 2>&1
UNIT_RC=$?
UNIT_DUREE=$(( $(date +%s) - debut ))
ecrire_manifeste || true

echo "Campagne OS : npm run test:os" >&2
debut=$(date +%s)
"$NPM_BIN" run test:os -- "${RAPPORTEURS[@]}" "--test-reporter-destination=$OUT/tests-os.jsonl" > "$OUT/test-os.txt" 2>&1
OS_RC=$?
OS_DUREE=$(( $(date +%s) - debut ))

NPM_APRES="$(compter "$HOME/.npm")"
SMOL_APRES="$(compter "$HOME/.smolcoder")"
TERMINE_LE="$(horodatage)"
ecrire_manifeste || { echo "Échec d’écriture du manifeste : $MANIFEST" >&2; exit 1; }
STATUT="$(node -e 'const m = require(process.argv[1]); console.log(m.status + " — " + m.status_reason)' "$MANIFEST")"
echo "Campagne enregistrée : $OUT" >&2
echo "Statut : $STATUT" >&2
case "$STATUT" in succes*) exit 0 ;; *) exit 1 ;; esac
