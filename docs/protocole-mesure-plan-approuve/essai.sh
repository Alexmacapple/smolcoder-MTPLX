#!/bin/bash
# Un essai du protocole de mesure appariée de #29 (docs/protocole-mesure-plan-approuve.md) :
# une tâche, un bras, un dossier de sortie neuf. N'appelle le modèle que par
# smol ; ne prend pas le verrou de campagne (la campagne le tient autour des essais).
#
# Usage : essai.sh <sans|avec> <tâche> <dossier de sortie>
# Variables : SMOL_BIN (dist/index.js du binaire figé) et MODELE (identifiant exact
# du modèle, passé à --model) obligatoires ; MTPLX_URL (sondes avant et après,
# facultatif) ; DELAI (secondes par run de smol, 600 par défaut).
set -u
BRAS=${1:?sans ou avec}
TACHE=${2:?tâche}
OUT=${3:?dossier de sortie}
D="$(cd "$(dirname "$0")" && pwd)"
: "${SMOL_BIN:?chemin du dist/index.js du binaire figé}" "${MODELE:?identifiant du modèle}"
DELAI=${DELAI:-600}
case "$BRAS" in sans | avec) ;; *) echo "bras inconnu : $BRAS (sans ou avec)" >&2; exit 2 ;; esac
[ -d "$D/fixtures/$TACHE" ] || { echo "tâche inconnue : $TACHE" >&2; exit 2; }
[ -e "$OUT" ] && { echo "le dossier de sortie existe déjà : $OUT" >&2; exit 2; }
mkdir -p "$OUT"
# python3 du système d'abord : les contrôles de l'hôte tournent dans le bac
# Seatbelt, qui ne lit pas un interpréteur installé sous le dossier personnel.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"

# Même logique que avec_timeout de bench/noyau-agents-md/banc.sh (délai, arrêt
# du groupe de processus, code 124), sans le piège d'interruption propre au banc.
avec_timeout() {
  perl -e '
    my $t = shift @ARGV;
    my $p = fork // die "fork: $!";
    my $timed_out = 0;
    if (!$p) { setpgrp(0, 0); exec @ARGV or die "exec: $!" }
    sub stop_child { kill "TERM", -$p; sleep 5; kill "KILL", -$p; waitpid $p, 0; exit 143; }
    $SIG{INT} = \&stop_child; $SIG{HUP} = \&stop_child; $SIG{TERM} = \&stop_child;
    local $SIG{ALRM} = sub { $timed_out = 1; kill "TERM", -$p; sleep 5; kill "KILL", -$p; };
    alarm $t;
    waitpid $p, 0;
    exit 124 if $timed_out;
    exit(($? >> 8) || (($? & 127) ? 128 + ($? & 127) : 0));
  ' "$@"
}

# Un champ de la dernière ligne [mission] d'une sortie d'erreur (chemin pointé).
champ() {
  python3 - "$1" "$2" <<'PY'
import json, sys
lignes = [l for l in open(sys.argv[1], encoding="utf-8", errors="replace") if l.startswith("[mission] ")]
v = json.loads(lignes[-1][10:]) if lignes else {}
for k in sys.argv[2].split("."):
    v = v.get(k) if isinstance(v, dict) else None
print("" if v is None else v)
PY
}

sonde() {
  [ -n "${MTPLX_URL:-}" ] || return 0
  curl -s --max-time 10 "$MTPLX_URL/v1/models" > "$OUT/modeles-$1.json"
  curl -s --max-time 10 "$MTPLX_URL/v1/mtplx/snapshot" > "$OUT/snapshot-$1.json"
}

# Workspace jetable : la fixture, puis un commit de référence pour le périmètre.
W="$(mktemp -d "${TMPDIR:-/tmp}/essai-plan-XXXXXX")"
cp -R "$D/fixtures/$TACHE/." "$W/"
git -C "$W" init -q && git -C "$W" add -A &&
  git -C "$W" -c user.name=banc -c user.email=banc@local commit -qm reference &&
  git -C "$W" tag reference
echo "$W" > "$OUT/workspace.txt"
# Le contrat vit hors du workspace, dans le dossier de l'essai.
cp "$D/contrats/$TACHE.json" "$OUT/contrat.json"
CONSIGNE="$(cat "$D/consignes/$TACHE.txt")"

# Un run de smol : sorties, code et durée murale sous <nom>.*
lancer() {
  local nom=$1 t0
  shift
  t0=$(date +%s)
  avec_timeout "$DELAI" node "$SMOL_BIN" "$W" -m edit -p "$CONSIGNE" --mission "$OUT/contrat.json" --model "$MODELE" "$@" \
    > "$OUT/$nom.sortie.txt" 2> "$OUT/$nom.erreurs.txt" < /dev/null
  echo $? > "$OUT/$nom.rc.txt"
  echo $(($(date +%s) - t0)) > "$OUT/$nom.duree.txt"
}

sonde avant
if [ "$BRAS" = sans ]; then
  # Préparation sans modèle (sortie 3) : l'empreinte du contrat de ce workspace.
  lancer preparation
  FP="$(champ "$OUT/preparation.erreurs.txt" fingerprint)"
  lancer travail --approve "$FP"
else
  # Run de proposition, puis approbation mécanique du plan proposé : le
  # protocole mesure l'effet du plan approuvé, pas la qualité d'une relecture.
  lancer proposition --propose-plan
  FP="$(champ "$OUT/proposition.erreurs.txt" fingerprint)"
  PLAN="$(champ "$OUT/proposition.erreurs.txt" plan.fingerprint)"
  if [ "$(champ "$OUT/proposition.erreurs.txt" plan.state)" = proposed ] && [ -n "$PLAN" ]; then
    lancer travail --approve "$FP" --approve-plan "$PLAN"
  else
    echo "aucun plan proposé au run de proposition" > "$OUT/sans-plan.txt"
    lancer travail --approve "$FP"
  fi
fi
sonde apres

# Le stockage hôte de l'essai (contrat, journal, rapport), puis le périmètre.
STORE="$(champ "$OUT/travail.erreurs.txt" store)"
mkdir -p "$OUT/stockage"
for f in contract.json policy.json proofs.jsonl report.json report.md; do
  [ -n "$STORE" ] && [ -f "$STORE/$f" ] && cp "$STORE/$f" "$OUT/stockage/"
done
git -C "$W" add -A
git -C "$W" diff --cached --name-only reference > "$OUT/fichiers.txt"
git -C "$W" diff --cached reference > "$OUT/diff.txt"
python3 "$D/controle.py" "$TACHE" "$W" "$D/fixtures/$TACHE" > "$OUT/controle.txt" 2>&1
echo $? > "$OUT/reussite.txt"
python3 "$D/mesures.py" "$OUT" "$D/perimetre/$TACHE.txt" > "$OUT/mesures.json"
cat "$OUT/mesures.json"
