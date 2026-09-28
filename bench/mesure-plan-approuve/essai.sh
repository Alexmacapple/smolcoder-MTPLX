#!/bin/bash
# Mesure appariée de #29 (docs/protocole-mesure-plan-approuve.md) : un essai
# d'une tâche avec un bras. Le déroulé est celui de l'essai.sh figé du
# protocole (workspace, préparation ou proposition, travail, contrôle
# indépendant, mesures), appelé tel quel ; ce runner y ajoute ce que le
# protocole laisse à la campagne : verrou, pièces figées, empreinte du binaire,
# préconditions MTPLX, dossier personnel jetable, sonde de concurrence,
# validité (règle, point 1), manifeste. smol tourne sur le binaire figé,
# jamais sur le smol installé ; le vrai ~/.smolcoder n'est que lu.
# Usage : essai.sh <sans|avec> <alertes-stock|renommage|option-separateur> <paire> [tentative]
set -u

export PATH="/opt/homebrew/bin:$PATH"
B="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO="$(git -C "$B" rev-parse --show-toplevel)" || exit 1
D="$REPO/docs/protocole-mesure-plan-approuve"
M19="$REPO/bench/mesure-retours-outils/mesure.py"
PLAN="$B/plan.json"
PLAN_OVERRIDE="$(printenv MESURE_PLAN 2>/dev/null || true)"
[ -n "$PLAN_OVERRIDE" ] && PLAN="$PLAN_OVERRIDE"
export MESURE_PLAN="$PLAN"
RESULTATS_DIR="$B/resultats"
RESULTATS_OVERRIDE="$(printenv MESURE_RESULTATS_DIR 2>/dev/null || true)"
[ -n "$RESULTATS_OVERRIDE" ] && RESULTATS_DIR="$RESULTATS_OVERRIDE"
MTPLX_OVERRIDE="$(printenv MTPLX_URL 2>/dev/null || true)"
MTPLX_URL="http://127.0.0.1:8000"
[ -n "$MTPLX_OVERRIDE" ] && MTPLX_URL="$MTPLX_OVERRIDE"
MAISON_SOURCE="$(printenv MESURE_MAISON_SOURCE 2>/dev/null || true)"
[ -n "$MAISON_SOURCE" ] || MAISON_SOURCE="$HOME"
TMP_RACINE="$(printenv MESURE_TMP 2>/dev/null || true)"
[ -n "$TMP_RACINE" ] || TMP_RACINE="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
[ -n "$TMP_RACINE" ] || TMP_RACINE=/tmp
TMP_RACINE="${TMP_RACINE%/}"

usage() {
  echo "Usage : essai.sh <sans|avec> <alertes-stock|renommage|option-separateur> <paire> [tentative]" >&2
  exit 2
}
[ $# -ge 3 ] && [ $# -le 4 ] || usage
BRAS="$1"
TACHE="$2"
PAIRE="$3"
TENTATIVE="${4:-1}"
case "$BRAS" in sans|avec) ;; *) usage ;; esac
case "$TACHE" in alertes-stock|renommage|option-separateur) ;; *) usage ;; esac
case "$PAIRE" in ''|*[!0-9]*) usage ;; esac
case "$TENTATIVE" in ''|*[!0-9]*) usage ;; esac
command -v python3 >/dev/null || { echo "python3 est requis" >&2; exit 4; }
[ -f "$PLAN" ] || { echo "Plan absent : $PLAN" >&2; exit 2; }

lire_plan() {
  python3 - "$PLAN" <<'PY'
import json
import os
import shlex
import sys

plan = json.load(open(sys.argv[1], encoding="utf-8"))
valeurs = {
    "BIN_RACINE": os.path.expanduser(plan["binaire"]["racine"]),
    "BIN_SHA": plan["binaire"]["sha"],
    "EMPREINTE_ATTENDUE": plan["binaire"]["empreinte_dist"],
    "MODELE_ATTENDU": plan["modele_attendu"],
    "DELAI": str(plan["delai_run_s"]),
    "ATTENTE": str(plan["attente_mtplx_boucles"]),
    "VERROUS_EXTERNES": " ".join(plan.get("verrous_externes", [])),
}
for nom, valeur in valeurs.items():
    print(f"{nom}={shlex.quote(valeur)}")
PY
}
VALEURS="$(lire_plan)" || usage
eval "$VALEURS"
o="$(printenv MESURE_BIN_RACINE 2>/dev/null || true)"; [ -n "$o" ] && BIN_RACINE="$o"
o="$(printenv MESURE_MODELE_ATTENDU 2>/dev/null || true)"; [ -n "$o" ] && MODELE_ATTENDU="$o"
o="$(printenv MESURE_DELAI_SECONDES 2>/dev/null || true)"
case "$o" in ''|*[!0-9]*) ;; *) [ "$o" -gt 0 ] && DELAI="$o" ;; esac
o="$(printenv MESURE_ATTENTE 2>/dev/null || true)"
case "$o" in ''|*[!0-9]*) ;; *) [ "$o" -gt 0 ] && ATTENTE="$o" ;; esac
[ -n "${MESURE_VERROUS_EXTERNES+x}" ] && VERROUS_EXTERNES="$(printenv MESURE_VERROUS_EXTERNES 2>/dev/null || true)"

horodatage() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
maintenant() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
mkdir -p "$RESULTATS_DIR" || exit 1
OUT="$(mktemp -d "$RESULTATS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$TACHE-p$PAIRE-$BRAS.XXXXXX")" || exit 1
# Le dossier de sortie de l'essai.sh du protocole, qu'il crée lui-même.
PROTO_OUT="$OUT/essai"
# Le verrou du banc (protocole, « Conditions communes ») ; hérité sous campagne.sh.
# shellcheck disable=SC2034 # lu par verrou-campagne.sh
LOCK_FILE="$REPO/bench/noyau-agents-md/resultats/.verrou-campagne"
LOCK_OVERRIDE="$(printenv BANC_LOCK_FILE 2>/dev/null || true)"
# shellcheck disable=SC2034 # lu par verrou-campagne.sh
[ -n "$LOCK_OVERRIDE" ] && LOCK_FILE="$LOCK_OVERRIDE"
mkdir -p "$(dirname "$LOCK_FILE")" || exit 1

SHA_HARNAIS="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo inconnu)"
HARNAIS_MODIFIE=true
if git -C "$REPO" diff --quiet && git -C "$REPO" diff --cached --quiet \
  && [ -z "$(git -C "$REPO" status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
  HARNAIS_MODIFIE=false
fi
ESSAI_CAMPAGNE="$(printenv BANC_CAMPAIGN_ID 2>/dev/null || true)"
export ESSAI_CAMPAGNE
export ESSAI_TACHE="$TACHE" ESSAI_BRAS="$BRAS" ESSAI_PAIRE="$PAIRE" ESSAI_TENTATIVE="$TENTATIVE"
ESSAI_DEBUT="$(horodatage)"
export ESSAI_DEBUT ESSAI_FIN="" ESSAI_STATUT=blocage_harnais ESSAI_INVALIDITE=""
export ESSAI_RAISON="Essai initialisé, en attente des préconditions"
export ESSAI_SHA_HARNAIS="$SHA_HARNAIS" ESSAI_HARNAIS_MODIFIE="$HARNAIS_MODIFIE"
export ESSAI_MTPLX_URL="$MTPLX_URL" ESSAI_SMOL_LANCE=0 ESSAI_PROTO_RC="" ESSAI_DUREE="" ESSAI_DELAI="$DELAI"
export ESSAI_BIN_SHA="$BIN_SHA" ESSAI_BIN_EMPREINTE="" ESSAI_BIN_CMD="" ESSAI_NODE=""
export ESSAI_NOYAU_SHA="" ESSAI_CONFIG_SHA=""

ecrire_manifeste() { python3 "$B/mesure.py" manifeste "$OUT"; }

MAISON=""
TMP_ESSAI=""
RUNNER_PID=""
ENFANT=""
SONDE_PID=""
arreter_sonde() {
  [ -n "$SONDE_PID" ] && kill -TERM "$SONDE_PID" 2>/dev/null && wait "$SONDE_PID" 2>/dev/null
  SONDE_PID=""
}
# Archive le workspace final et le dossier personnel de test (stockage hôte
# compris), puis supprime tout ce que l'essai a créé hors de son dossier.
nettoyer() {
  local w
  arreter_sonde
  w="$(cat "$PROTO_OUT/workspace.txt" 2>/dev/null || true)"
  if [ -n "$w" ] && [ -d "$w" ]; then
    tar -C "$w" -czf "$OUT/espace-final.tar.gz" . 2>/dev/null
  fi
  if [ -n "$MAISON" ] && [ -d "$MAISON" ]; then
    (cd "$MAISON" && find . -type f -not -path './Library/*' | LC_ALL=C sort) > "$OUT/maison-fichiers.txt" 2>/dev/null
    [ -d "$MAISON/.smolcoder" ] && tar -C "$MAISON" -czf "$OUT/maison-smolcoder.tar.gz" .smolcoder 2>/dev/null
    chmod -R u+w "$MAISON" 2>/dev/null
    rm -rf "$MAISON"
  fi
  if [ -n "$TMP_ESSAI" ] && [ -d "$TMP_ESSAI" ]; then
    chmod -R u+w "$TMP_ESSAI" 2>/dev/null
    rm -rf "$TMP_ESSAI"
  fi
  MAISON=""
  TMP_ESSAI=""
}

# statut, raison, code de sortie ; un statut autre que succes ou echec_test
# rend l'essai invalide (règle, point 1), avec la raison pour motif.
terminer() {
  ESSAI_FIN="$(horodatage)"
  export ESSAI_STATUT="$1" ESSAI_RAISON="$2" ESSAI_FIN
  case "$1" in succes|echec_test) ;; *) export ESSAI_INVALIDITE="$2" ;; esac
  nettoyer
  ecrire_manifeste || { echo "Échec d'écriture du manifeste : $OUT" >&2; exit 1; }
  echo "Essai enregistré : $OUT" >&2
  echo "Statut : $ESSAI_STATUT — $ESSAI_RAISON" >&2
  exit "$3"
}

source "$B/../noyau-agents-md/verrou-campagne.sh" || { echo "Bibliothèque de verrou absente" >&2; exit 1; }
# shellcheck disable=SC2034 # lu et écrit par verrou-campagne.sh
LOCK_OWNED=0
arreter_runner() {
  [ -n "$RUNNER_PID" ] || return 0
  kill -TERM "$RUNNER_PID" 2>/dev/null
  wait "$RUNNER_PID" 2>/dev/null
  RUNNER_PID=""
}
EN_SOUS_SHELL=0
interrompre() {
  if [ "$EN_SOUS_SHELL" = 1 ]; then
    arreter_runner
    exit 143
  fi
  [ -n "$ENFANT" ] && kill -TERM "$ENFANT" 2>/dev/null && wait "$ENFANT" 2>/dev/null
  ESSAI_FIN="$(horodatage)"
  export ESSAI_STATUT=blocage_harnais ESSAI_RAISON="Essai interrompu avant un verdict vérifiable" ESSAI_FIN
  export ESSAI_INVALIDITE="$ESSAI_RAISON"
  nettoyer
  ecrire_manifeste || true
  liberer_verrou
  exit 130
}
trap interrompre HUP INT TERM
trap liberer_verrou EXIT
ecrire_manifeste || { echo "Échec d'écriture du manifeste initial : $OUT" >&2; exit 1; }
prendre_verrou || terminer blocage_harnais "$LOCK_REASON" 4

python3 "$B/mesure.py" controler "$REPO" > "$OUT/protocole-controle.txt" 2>&1 \
  || terminer blocage_harnais "Pièces du protocole différentes du plan figé (voir protocole-controle.txt)" 4
for outil in curl git node perl tar; do
  command -v "$outil" >/dev/null || terminer blocage_harnais "$outil est introuvable" 4
done
[ -x /usr/bin/python3 ] || terminer blocage_harnais "/usr/bin/python3 est introuvable (contrôles de l'hôte dans le bac)" 4
ESSAI_NODE="$(node --version)"
export ESSAI_NODE

# Le binaire figé : empreinte de dist/ calculée comme dans le protocole.
BIN="$BIN_RACINE/dist/index.js"
[ -f "$BIN" ] || terminer blocage_harnais "Binaire absent : $BIN" 4
EMPREINTE="$( (cd "$BIN_RACINE" && find dist -type f | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256 | cut -d' ' -f1)"
export ESSAI_BIN_EMPREINTE="$EMPREINTE" ESSAI_BIN_CMD="$BIN"
# Code 5 : chaîne de construction dérivée, la campagne s'arrête (protocole).
[ "$EMPREINTE" = "$EMPREINTE_ATTENDUE" ] \
  || terminer blocage_harnais "Empreinte de dist/ $EMPREINTE au lieu de $EMPREINTE_ATTENDUE : campagne à arrêter" 5

# Une autre campagne du banc tient son verrou (clone principal ou autre
# worktree, motifs du plan, lus sans être pris) : attendre. Le verrou de
# cette campagne est exclu.
chemin_reel() { printf '%s/%s\n' "$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" "$(basename "$1")"; }
PROPRE="$(chemin_reel "$LOCK_FILE")"
verrou_externe_actif() {
  local fichier pid
  # shellcheck disable=SC2086 # motifs du plan, développés exprès
  for fichier in $VERROUS_EXTERNES; do
    [ -f "$fichier" ] || continue
    [ "$(chemin_reel "$fichier")" = "$PROPRE" ] && continue
    pid="$(sed -n '1p' "$fichier" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null && { echo "$fichier (PID $pid)"; return 0; }
  done
  return 1
}
ACTIF=""
for _ in $(seq 1 "$ATTENTE"); do
  ACTIF="$(verrou_externe_actif)" || { ACTIF=""; break; }
  sleep 5
done
[ -z "$ACTIF" ] || terminer mtplx_indisponible "Une autre campagne tient son verrou : $ACTIF" 3

recuperer_modeles() {
  curl --fail --silent --show-error --max-time 5 "$MTPLX_URL/v1/models" > "$OUT/modeles.json" 2> "$OUT/modeles.erreurs.txt" || return 1
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert any(isinstance(r,dict) and isinstance(r.get("id"),str) for r in d["data"])' "$OUT/modeles.json" 2>/dev/null
}
recuperer_snapshot() {
  curl --fail --silent --show-error --max-time 5 "$MTPLX_URL/v1/mtplx/snapshot" > "$1.tmp" 2>> "$OUT/snapshot.erreurs.txt" || return 1
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1.tmp" 2>/dev/null || return 1
  mv "$1.tmp" "$1"
}
champ_snapshot() {
  python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2" 2>/dev/null
}

# MTPLX répond, n'a aucune requête en cours (active_requests à zéro, dix
# minutes d'attente au plus) et sert le modèle nommé par le protocole.
recuperer_modeles || terminer mtplx_indisponible "La liste des modèles MTPLX est indisponible" 3
PRET=0
ACTIVES=inconnu
for _ in $(seq 1 "$ATTENTE"); do
  if recuperer_snapshot "$OUT/snapshot-precondition.json"; then
    ACTIVES="$(champ_snapshot "$OUT/snapshot-precondition.json" active_requests)"
    [ "$ACTIVES" = "0" ] && { PRET=1; break; }
  fi
  sleep 5
done
[ "$PRET" -eq 1 ] || terminer mtplx_indisponible "MTPLX occupé ou muet avant l'essai (active_requests=$ACTIVES)" 3
MODELE="$(champ_snapshot "$OUT/snapshot-precondition.json" model_id)"
[ "$MODELE" = "$MODELE_ATTENDU" ] || terminer mtplx_indisponible "Modèle servi $MODELE au lieu de $MODELE_ATTENDU" 3

# Dossier personnel de test jetable : copies du noyau et de la configuration
# MTPLX ; le stockage hôte de l'essai y atterrit et il est archivé avec lui.
[ -s "$MAISON_SOURCE/.smolcoder/AGENTS.md" ] || terminer blocage_harnais "Noyau absent : $MAISON_SOURCE/.smolcoder/AGENTS.md" 4
[ -s "$MAISON_SOURCE/.smolcoder.json" ] || terminer blocage_harnais "Configuration absente : $MAISON_SOURCE/.smolcoder.json" 4
mkdir -p "$TMP_RACINE" || terminer blocage_harnais "Dossier temporaire impossible : $TMP_RACINE" 4
MAISON="$(mktemp -d "$TMP_RACINE/mesure29-maison.XXXXXX")" || terminer blocage_harnais "Dossier personnel de test impossible" 4
mkdir -p "$MAISON/.smolcoder" \
  && cp "$MAISON_SOURCE/.smolcoder/AGENTS.md" "$MAISON/.smolcoder/AGENTS.md" \
  && cp "$MAISON_SOURCE/.smolcoder.json" "$MAISON/.smolcoder.json" \
  || terminer blocage_harnais "Copie du noyau ou de la configuration impossible" 4
ESSAI_NOYAU_SHA="$(shasum -a 256 "$MAISON/.smolcoder/AGENTS.md" | cut -d' ' -f1)"
ESSAI_CONFIG_SHA="$(shasum -a 256 "$MAISON/.smolcoder.json" | cut -d' ' -f1)"
export ESSAI_NOYAU_SHA ESSAI_CONFIG_SHA
# TMPDIR de l'essai : l'essai.sh du protocole y crée le workspace, smol ses
# dossiers de bac ; tout est supprimé à la fin de l'essai.
TMP_ESSAI="$(mktemp -d "$TMP_RACINE/mesure29-tmp.XXXXXX")" || terminer blocage_harnais "TMPDIR de l'essai impossible" 4

# Garde de l'essai entier (deux runs de smol au plus, chacun borné par le
# délai du protocole, plus le contrôle) : même logique que avec_timeout de
# bench/noyau-agents-md/banc.sh, groupe de processus arrêté en entier.
avec_timeout() {
  local rc
  trap '' HUP INT TERM
  perl -e '
    my $t = shift @ARGV;
    my $p = fork // die "fork: $!";
    my $timed_out = 0;
    if (!$p) { setpgrp(0, 0); exec @ARGV or die "exec: $!" }
    sub stop_child {
      kill "TERM", -$p;
      sleep 5;
      kill "KILL", -$p;
      waitpid $p, 0;
      exit 143;
    }
    $SIG{INT} = \&stop_child;
    $SIG{HUP} = \&stop_child;
    $SIG{TERM} = \&stop_child;
    local $SIG{ALRM} = sub {
      $timed_out = 1;
      kill "TERM", -$p;
      sleep 5;
      kill "KILL", -$p;
    };
    alarm $t;
    waitpid $p, 0;
    exit 124 if $timed_out;
    exit(($? >> 8) || (($? & 127) ? 128 + ($? & 127) : 0));
  ' "$@" &
  RUNNER_PID=$!
  trap interrompre HUP INT TERM
  wait "$RUNNER_PID"
  rc=$?
  RUNNER_PID=""
  return "$rc"
}

python3 "$M19" sonde "$MTPLX_URL" "$OUT/sonde.jsonl" &
SONDE_PID=$!
T0="$(maintenant)"
t0="$(date +%s)"
export ESSAI_SMOL_LANCE=1
{
  EN_SOUS_SHELL=1
  avec_timeout "$((2 * DELAI + 300))" env -u SMOL_NO_GLOBAL_AGENTS -u SMOLCODER_CONFIG -u OLLAMA_HOST -u FORCE_COLOR \
    HOME="$MAISON" TMPDIR="$TMP_ESSAI" SMOL_NO_FICHES=1 SMOL_BIN="$BIN" MODELE="$MODELE_ATTENDU" \
    MTPLX_URL="$MTPLX_URL" DELAI="$DELAI" \
    "$D/essai.sh" "$BRAS" "$TACHE" "$PROTO_OUT" > "$OUT/essai.stdout.txt" 2> "$OUT/essai.stderr.txt" < /dev/null
} &
ENFANT=$!
wait "$ENFANT"
PROTO_RC=$?
ENFANT=""
T1="$(maintenant)"
export ESSAI_PROTO_RC="$PROTO_RC" ESSAI_DUREE="$(( $(date +%s) - t0 ))"
arreter_sonde
python3 "$M19" concurrence "$OUT" "$D/consignes/$TACHE.txt" "$T0" "$T1" "$MTPLX_URL" \
  > "$OUT/concurrence-resume.txt" 2>&1
python3 "$B/mesure.py" trace "$PROTO_OUT" > "$OUT/trace-plan.json" 2> "$OUT/trace-plan.erreurs.txt"
CLASSE="$(python3 "$B/mesure.py" classer "$OUT" "$BRAS" "$MODELE_ATTENDU" "$MTPLX_URL" "$PROTO_RC" 2> "$OUT/classer.erreurs.txt")" \
  || terminer blocage_harnais "Classement de l'essai impossible (voir classer.erreurs.txt)" 4
IFS=$'\t' read -r STATUT RAISON CODE <<< "$CLASSE"
[ -n "${CODE:-}" ] || terminer blocage_harnais "Classement de l'essai illisible : $CLASSE" 4
terminer "$STATUT" "$RAISON" "$CODE"
