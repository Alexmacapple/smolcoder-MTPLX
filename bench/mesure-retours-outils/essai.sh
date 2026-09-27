#!/bin/bash
# Mesure appariée de #19 (docs/protocole-mesure-retours-outils.md) : un essai
# d'une tâche avec un bras, selon le déroulé du protocole. smol tourne sur le
# binaire construit du bras (empreinte de dist/ vérifiée avant l'essai),
# jamais sur le smol installé ; le vrai ~/.smolcoder n'est que lu (noyau et
# configuration copiés dans un dossier personnel de test jetable).
# Usage : essai.sh <avant|apres> <deux-produits|journal-long|modif-humaine> <paire> [tentative]
set -u

export PATH="/opt/homebrew/bin:$PATH"
B="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO="$(git -C "$B" rev-parse --show-toplevel)" || exit 1
D="$REPO/docs/protocole-mesure-retours-outils"
PLAN="$B/plan.json"
PLAN_OVERRIDE="$(printenv MESURE_PLAN 2>/dev/null || true)"
[ -n "$PLAN_OVERRIDE" ] && PLAN="$PLAN_OVERRIDE"
export MESURE_PLAN="$PLAN"
RESULTATS_DIR="$B/resultats"
RESULTATS_OVERRIDE="$(printenv MESURE_RESULTATS_DIR 2>/dev/null || true)"
[ -n "$RESULTATS_OVERRIDE" ] && RESULTATS_DIR="$RESULTATS_OVERRIDE"
# L'override se lit avant d'assigner le défaut (variable peut-être exportée).
MTPLX_OVERRIDE="$(printenv MTPLX_URL 2>/dev/null || true)"
MTPLX_URL="http://127.0.0.1:8000"
[ -n "$MTPLX_OVERRIDE" ] && MTPLX_URL="$MTPLX_OVERRIDE"
MAISON_SOURCE="$(printenv MESURE_MAISON_SOURCE 2>/dev/null || true)"
[ -n "$MAISON_SOURCE" ] || MAISON_SOURCE="$HOME"
TMP_RACINE="$(printenv MESURE_TMP 2>/dev/null || true)"
[ -n "$TMP_RACINE" ] || TMP_RACINE="$(printenv TMPDIR 2>/dev/null || true)"
[ -n "$TMP_RACINE" ] || TMP_RACINE="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
[ -n "$TMP_RACINE" ] || TMP_RACINE=/tmp
TMP_RACINE="${TMP_RACINE%/}"

usage() {
  echo "Usage : essai.sh <avant|apres> <deux-produits|journal-long|modif-humaine> <paire> [tentative]" >&2
  exit 2
}
[ $# -ge 3 ] && [ $# -le 4 ] || usage
BRAS="$1"
TACHE="$2"
PAIRE="$3"
TENTATIVE="${4:-1}"
case "$BRAS" in avant|apres) ;; *) usage ;; esac
case "$TACHE" in deux-produits|journal-long|modif-humaine) ;; *) usage ;; esac
case "$PAIRE" in ''|*[!0-9]*) usage ;; esac
case "$TENTATIVE" in ''|*[!0-9]*) usage ;; esac
command -v python3 >/dev/null || { echo "python3 est requis" >&2; exit 4; }
[ -f "$PLAN" ] || { echo "Plan absent : $PLAN" >&2; exit 2; }

lire_plan() {
  python3 - "$PLAN" "$BRAS" <<'PY'
import json
import os
import shlex
import sys

plan = json.load(open(sys.argv[1], encoding="utf-8"))
bras = plan["bras"][sys.argv[2]]
valeurs = {
    "BIN_RACINE": os.path.expanduser(plan["binaires_racine"]),
    "BIN_SHA": bras["sha"],
    "EMPREINTE_ATTENDUE": bras["empreinte_dist"],
    "MODELE_ATTENDU": plan["modele_attendu"],
    "DELAI": str(plan["delai_essai_s"]),
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
cp "$D/consignes/$TACHE.txt" "$OUT/consigne.txt" 2>/dev/null || true
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
export ESSAI_MTPLX_URL="$MTPLX_URL" ESSAI_SMOL_LANCE=0 ESSAI_SMOL_RC="" ESSAI_DUREE="" ESSAI_DELAI="$DELAI"
export ESSAI_BIN_SHA="$BIN_SHA" ESSAI_BIN_EMPREINTE="" ESSAI_BIN_CMD="" ESSAI_NODE=""
export ESSAI_NOYAU_SHA="" ESSAI_CONFIG_SHA="" ESSAI_REF=""

ecrire_manifeste() { python3 "$B/mesure.py" manifeste "$OUT"; }

W=""
MAISON=""
TMP_ESSAI=""
RUNNER_PID=""
SMOL=""
SONDE_PID=""
INJ_PID=""
OBS_PID=""
arreter_aides() {
  local pid
  for pid in "$SONDE_PID" "$INJ_PID" "$OBS_PID"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null && wait "$pid" 2>/dev/null
  done
  SONDE_PID=""
  INJ_PID=""
  OBS_PID=""
}
nettoyer() {
  arreter_aides
  if [ -n "$W" ] && [ -d "$W" ]; then
    tar -C "$W" -czf "$OUT/espace-final.tar.gz" . 2>/dev/null
    rm -rf "$W"
  fi
  if [ -n "$MAISON" ] && [ -d "$MAISON" ]; then
    (cd "$MAISON" && find . -type f -not -path './Library/*' | LC_ALL=C sort) > "$OUT/maison-fichiers.txt" 2>/dev/null
    [ -d "$MAISON/.smolcoder/sessions" ] && cp -R "$MAISON/.smolcoder/sessions" "$OUT/maison-sessions" 2>/dev/null
    rm -rf "$MAISON"
  fi
  [ -n "$TMP_ESSAI" ] && rm -rf "$TMP_ESSAI"
  W=""
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
# Appelée aussi dans le sous-shell d'avec_timeout (lancé en arrière-plan,
# comme dans le déroulé du protocole) : là, seulement arrêter smol. Le
# marqueur EN_SOUS_SHELL remplace BASHPID, absent du bash 3.2 de macOS.
EN_SOUS_SHELL=0
interrompre_run() {
  if [ "$EN_SOUS_SHELL" = 1 ]; then
    arreter_runner
    exit 143
  fi
  [ -n "$SMOL" ] && kill -TERM "$SMOL" 2>/dev/null && wait "$SMOL" 2>/dev/null
  ESSAI_FIN="$(horodatage)"
  export ESSAI_STATUT=blocage_harnais ESSAI_RAISON="Essai interrompu avant un verdict vérifiable" ESSAI_FIN
  export ESSAI_INVALIDITE="$ESSAI_RAISON"
  nettoyer
  ecrire_manifeste || true
  liberer_verrou
  exit 130
}
trap interrompre_run HUP INT TERM
trap liberer_verrou EXIT
ecrire_manifeste || { echo "Échec d'écriture du manifeste initial : $OUT" >&2; exit 1; }
prendre_verrou || terminer blocage_harnais "$LOCK_REASON" 4

python3 "$B/mesure.py" controler "$REPO" > "$OUT/protocole-controle.txt" 2>&1 \
  || terminer blocage_harnais "Pièces du protocole différentes du plan figé (voir protocole-controle.txt)" 4
command -v curl >/dev/null || terminer blocage_harnais "curl est introuvable" 4
command -v git >/dev/null || terminer blocage_harnais "git est introuvable" 4
command -v node >/dev/null || terminer blocage_harnais "node est introuvable" 4
ESSAI_NODE="$(node --version)"
export ESSAI_NODE

# Le binaire du bras : empreinte de dist/ calculée comme dans le protocole.
BIN_DIR="$BIN_RACINE/$BRAS"
BIN="$BIN_DIR/dist/index.js"
[ -x "$BIN" ] || terminer blocage_harnais "Binaire absent ou non exécutable : $BIN" 4
EMPREINTE="$( (cd "$BIN_DIR" && find dist -type f | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256 | cut -d' ' -f1)"
export ESSAI_BIN_EMPREINTE="$EMPREINTE" ESSAI_BIN_CMD="$BIN"
# Code 5 : chaîne de construction dérivée, la campagne s'arrête (protocole).
[ "$EMPREINTE" = "$EMPREINTE_ATTENDUE" ] \
  || terminer blocage_harnais "Empreinte de dist/ $EMPREINTE au lieu de $EMPREINTE_ATTENDUE : campagne à arrêter" 5

# Une autre campagne du banc tient son verrou (autre worktree) : attendre.
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

recuperer_modeles || terminer mtplx_indisponible "La liste des modèles MTPLX est indisponible" 3
PRET=0
ACTIVES=inconnu
for _ in $(seq 1 "$ATTENTE"); do
  if recuperer_snapshot "$OUT/snapshot-avant.json"; then
    ACTIVES="$(champ_snapshot "$OUT/snapshot-avant.json" active_requests)"
    [ "$ACTIVES" = "0" ] && { PRET=1; break; }
  fi
  sleep 5
done
[ "$PRET" -eq 1 ] || terminer mtplx_indisponible "MTPLX occupé ou muet avant l'essai (active_requests=$ACTIVES)" 3
MODELE="$(champ_snapshot "$OUT/snapshot-avant.json" model_id)"
[ "$MODELE" = "$MODELE_ATTENDU" ] || terminer mtplx_indisponible "Modèle servi $MODELE au lieu de $MODELE_ATTENDU" 3

# Dossier personnel de test : copies du noyau et de la configuration MTPLX.
[ -s "$MAISON_SOURCE/.smolcoder/AGENTS.md" ] || terminer blocage_harnais "Noyau absent : $MAISON_SOURCE/.smolcoder/AGENTS.md" 4
[ -s "$MAISON_SOURCE/.smolcoder.json" ] || terminer blocage_harnais "Configuration absente : $MAISON_SOURCE/.smolcoder.json" 4
mkdir -p "$TMP_RACINE" || terminer blocage_harnais "Dossier temporaire impossible : $TMP_RACINE" 4
MAISON="$(mktemp -d "$TMP_RACINE/mesure-maison.XXXXXX")" || terminer blocage_harnais "Dossier personnel de test impossible" 4
mkdir -p "$MAISON/.smolcoder" \
  && cp "$MAISON_SOURCE/.smolcoder/AGENTS.md" "$MAISON/.smolcoder/AGENTS.md" \
  && cp "$MAISON_SOURCE/.smolcoder.json" "$MAISON/.smolcoder.json" \
  || terminer blocage_harnais "Copie du noyau ou de la configuration impossible" 4
ESSAI_NOYAU_SHA="$(shasum -a 256 "$MAISON/.smolcoder/AGENTS.md" | cut -d' ' -f1)"
export ESSAI_NOYAU_SHA
ESSAI_CONFIG_SHA="$(shasum -a 256 "$MAISON/.smolcoder.json" | cut -d' ' -f1)"
export ESSAI_CONFIG_SHA
TMP_ESSAI="$(mktemp -d "$TMP_RACINE/mesure-tmp.XXXXXX")" || terminer blocage_harnais "TMPDIR de l'essai impossible" 4

# Déroulé du protocole. Écart déclaré : `git diff reference` exige une
# référence de ce nom ; le commit de référence reçoit donc l'étiquette
# `reference`.
W="$(mktemp -d "$TMP_RACINE/mesure-ws-$TACHE.XXXXXX")" && cp -R "$D/fixtures/$TACHE/." "$W/" \
  || terminer blocage_harnais "Copie de la fixture impossible" 4
git -C "$W" init -q && git -C "$W" add -A \
  && git -C "$W" -c user.name=banc -c user.email=banc@local commit -qm reference \
  && git -C "$W" tag reference \
  || terminer blocage_harnais "Dépôt de référence impossible" 4
ESSAI_REF="$(git -C "$W" rev-parse HEAD)"
export ESSAI_REF
curl -s "$MTPLX_URL/v1/models" > "$OUT/modeles.json"
curl -s "$MTPLX_URL/v1/mtplx/snapshot" > "$OUT/snapshot-avant.json"

# Timeout qui termine proprement tout le groupe de processus : TERM d'abord.
# Repris tel quel de bench/noyau-agents-md/banc.sh (protocole).
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
  trap interrompre_run HUP INT TERM
  wait "$RUNNER_PID"
  rc=$?
  RUNNER_PID=""
  return "$rc"
}

case "$TACHE" in
  deux-produits) SURVEILLES=(stats.py) ;;
  journal-long) SURVEILLES=(calc.py) ;;
  modif-humaine) SURVEILLES=(config.py app.py) ;;
esac
python3 "$B/mesure.py" sonde "$MTPLX_URL" "$OUT/sonde.jsonl" &
SONDE_PID=$!
T0="$(maintenant)"
t0="$(date +%s)"
export ESSAI_SMOL_LANCE=1
{
  EN_SOUS_SHELL=1
  avec_timeout "$DELAI" env -u SMOL_NO_GLOBAL_AGENTS -u SMOLCODER_CONFIG -u OLLAMA_HOST -u FORCE_COLOR \
    SMOL_NO_FICHES=1 HOME="$MAISON" TMPDIR="$TMP_ESSAI/" \
    "$BIN" "$W" -m edit -p "$(cat "$D/consignes/$TACHE.txt")" \
    > "$OUT/sortie.txt" 2> "$OUT/erreurs.txt" < /dev/null
} &
SMOL=$!
if [ "$TACHE" = modif-humaine ]; then
  "$D/injecter.sh" "$W" "$OUT" "$SMOL" "$DELAI" &
  INJ_PID=$!
fi
python3 "$B/mesure.py" observer "$W" "$OUT" "$SMOL" "${SURVEILLES[@]}" &
OBS_PID=$!
wait "$SMOL"
SMOL_RC=$?
echo "$SMOL_RC" > "$OUT/rc.txt"
SMOL=""
[ -n "$INJ_PID" ] && wait "$INJ_PID" 2>/dev/null
INJ_PID=""
wait "$OBS_PID" 2>/dev/null
OBS_PID=""
T1="$(maintenant)"
export ESSAI_SMOL_RC="$SMOL_RC" ESSAI_DUREE="$(( $(date +%s) - t0 ))"
curl -s "$MTPLX_URL/v1/mtplx/snapshot" > "$OUT/snapshot-apres.json"
kill -TERM "$SONDE_PID" 2>/dev/null
wait "$SONDE_PID" 2>/dev/null
SONDE_PID=""
git -C "$W" diff reference > "$OUT/diff.txt"
git -C "$W" status --porcelain --untracked-files=all > "$OUT/statut-git.txt"
python3 "$D/mesures.py" "$OUT/erreurs.txt" > "$OUT/mesures.json" 2> "$OUT/mesures.erreurs.txt"
python3 "$B/mesure.py" concurrence "$OUT" "$D/consignes/$TACHE.txt" "$T0" "$T1" "$MTPLX_URL" \
  > "$OUT/concurrence-resume.txt" 2>&1
MESURE_PATH_VERIF="$PATH" python3 "$B/mesure.py" verifier "$TACHE" "$W" "$OUT" "$D" \
  > "$OUT/verification-resume.txt" 2> "$OUT/verification-erreurs.txt" \
  || terminer blocage_harnais "Vérification de l'état final impossible (voir verification-erreurs.txt)" 4

# Validité (règle, point 1), puis réussite réelle : état final conforme et
# smol sorti de lui-même avant le délai.
if ! grep -q '^●' "$OUT/sortie.txt" 2>/dev/null; then
  recuperer_modeles || terminer mtplx_indisponible "smol n'a pas démarré (code $SMOL_RC) et MTPLX ne répond plus" 3
  terminer blocage_harnais "smol n'a pas démarré (code $SMOL_RC)" 4
fi
if [ "$SMOL_RC" -ne 0 ]; then
  recuperer_modeles || terminer mtplx_indisponible "smol a terminé avec le code $SMOL_RC et MTPLX ne répond plus" 3
  if grep -qE 'ECONNREFUSED|fetch failed|socket hang up|backend error' "$OUT/erreurs.txt" 2>/dev/null; then
    terminer mtplx_indisponible "smol a terminé avec le code $SMOL_RC sur une erreur du serveur (voir erreurs.txt)" 3
  fi
fi
if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["occupe"] else 1)' "$OUT/concurrence.json" 2>/dev/null; then
  terminer mtplx_indisponible "MTPLX occupé pendant l'essai : $(python3 -c 'import json,sys; print("; ".join(json.load(open(sys.argv[1]))["motifs"]))' "$OUT/concurrence.json")" 3
fi
[ -f "$OUT/concurrence.json" ] || terminer blocage_harnais "Attribution des requêtes MTPLX impossible (voir concurrence-resume.txt)" 4
MODELE_APRES="$(champ_snapshot "$OUT/snapshot-apres.json" model_id)"
[ "$MODELE_APRES" = "$MODELE" ] || terminer mtplx_indisponible "Modèle changé pendant l'essai : $MODELE puis $MODELE_APRES" 3

CONFORME="$(python3 -c 'import json,sys; print(1 if json.load(open(sys.argv[1]))["etat_final_conforme"] else 0)' "$OUT/verification.json")"
case "$SMOL_RC" in
  124) terminer echec_test "Délai de $DELAI s dépassé : jamais une réussite (état final conforme : $CONFORME)" 1 ;;
  137|143) terminer echec_test "smol arrêté de force (code $SMOL_RC) : jamais une réussite" 1 ;;
esac
[ "$CONFORME" = 1 ] && terminer succes "État final conforme et smol sorti de lui-même (code $SMOL_RC)" 0
terminer echec_test "État final non conforme (voir verdict.txt), smol sorti avec le code $SMOL_RC" 1
