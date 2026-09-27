#!/bin/bash
# Étude #33 : un essai isolé d'une tâche de transfert, fiches A (main) ou B
# (main plus le correctif d'une leçon), servies par le chemin de production :
# installées dans un dossier personnel de test jetable, lues par
# read_file {"path": "fiche:<nom>"}. Le vrai ~/.smolcoder n'est que lu
# (noyau et configuration copiés), jamais écrit.
# Usage : essai.sh <leçon> <tâche> <A|A2|B> [répétition]
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
PROTOCOLE="$B/protocole.json"
PROTOCOLE_OVERRIDE="$(printenv ETUDE_PROTOCOLE 2>/dev/null || true)"
[ -n "$PROTOCOLE_OVERRIDE" ] && PROTOCOLE="$PROTOCOLE_OVERRIDE"
export ETUDE_PROTOCOLE="$PROTOCOLE"
RESULTATS_DIR="$B/resultats"
RESULTATS_OVERRIDE="$(printenv ETUDE_RESULTATS_DIR 2>/dev/null || true)"
[ -n "$RESULTATS_OVERRIDE" ] && RESULTATS_DIR="$RESULTATS_OVERRIDE"
# L'override se lit avant d'assigner le défaut : une variable exportée
# réassignée dans ce shell changerait aussi ce que printenv renvoie.
MTPLX_OVERRIDE="$(printenv MTPLX_URL 2>/dev/null || true)"
MTPLX_URL="http://127.0.0.1:8000"
[ -n "$MTPLX_OVERRIDE" ] && MTPLX_URL="$MTPLX_OVERRIDE"
SMOL_FAUX="$(printenv ETUDE_SMOL_BIN 2>/dev/null || true)"
DIST_OVERRIDE="$(printenv ETUDE_DIST 2>/dev/null || true)"
BINAIRE_DIR="$B/resultats/binaire"
BINAIRE_OVERRIDE="$(printenv ETUDE_BINAIRE_DIR 2>/dev/null || true)"
[ -n "$BINAIRE_OVERRIDE" ] && BINAIRE_DIR="$BINAIRE_OVERRIDE"
ATTENTE_ESSAIS="$(printenv ETUDE_ATTENTE_ESSAIS 2>/dev/null || true)"
case "$ATTENTE_ESSAIS" in ''|*[!0-9]*) ATTENTE_ESSAIS=120 ;; esac

usage() {
  echo "Usage : essai.sh <leçon> <tâche> <A|A2|B> [répétition]" >&2
  exit 2
}

[ $# -ge 3 ] && [ $# -le 4 ] || usage
LECON="$1"
TACHE="$2"
SERIE="$3"
REPETITION="${4:-}"
case "$SERIE" in A|A2|B) ;; *) usage ;; esac
case "$REPETITION" in ''|*[!0-9]*) [ -z "$REPETITION" ] || usage ;; esac
command -v python3 >/dev/null || { echo "python3 est requis" >&2; exit 4; }
[ -f "$PROTOCOLE" ] || { echo "Protocole absent : $PROTOCOLE" >&2; exit 2; }

# Tout ce que l'essai lit du protocole, validé avant de créer quoi que ce soit.
lire_protocole() {
  python3 - "$PROTOCOLE" "$LECON" "$TACHE" <<'PY'
import json
import shlex
import sys

protocole = json.load(open(sys.argv[1], encoding="utf-8"))
lecon, tache = sys.argv[2], sys.argv[3]
if lecon not in protocole["lecons"] or tache not in protocole["lecons"][lecon]["taches"]:
    raise SystemExit(2)
l = protocole["lecons"][lecon]
valeurs = {
    "FICHE": l["fiche"],
    "FICHIER_B": l["fichier_b"],
    "SHA_B": l["sha256_b"],
    "MODELE_ATTENDU": protocole["modele_attendu"],
    "EMPREINTE_BINAIRE_ATTENDUE": protocole["binaire"]["empreinte_arbre"],
    "INDEX_ATTENDU": protocole["index_prompt_sha256"],
    "DELAI_PROTOCOLE": str(protocole["delai_essai_s"]),
    "CLE": protocole["cle_factice"],
    "PATH_OUTILS": protocole["path_outils"],
    "VERROUS_EXTERNES": " ".join(protocole.get("verrous_externes", [])),
}
for nom, valeur in valeurs.items():
    print(f"{nom}={shlex.quote(valeur)}")
PY
}
VALEURS="$(lire_protocole)" || usage
eval "$VALEURS"
MODELE_OVERRIDE="$(printenv ETUDE_MODELE_ATTENDU 2>/dev/null || true)"
[ -n "$MODELE_OVERRIDE" ] && MODELE_ATTENDU="$MODELE_OVERRIDE"
VERROUS_OVERRIDE="$(printenv ETUDE_VERROUS_EXTERNES 2>/dev/null || true)"
[ -n "${ETUDE_VERROUS_EXTERNES+x}" ] && VERROUS_EXTERNES="$VERROUS_OVERRIDE"
DELAI="$DELAI_PROTOCOLE"
DELAI_OVERRIDE="$(printenv ETUDE_DELAI_SECONDES 2>/dev/null || true)"
case "$DELAI_OVERRIDE" in ''|*[!0-9]*) ;; *) [ "$DELAI_OVERRIDE" -gt 0 ] && DELAI="$DELAI_OVERRIDE" ;; esac
TACHE_DIR="$B/taches/$TACHE"
PROMPT_FILE="$TACHE_DIR/consigne.txt"

horodatage() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
mkdir -p "$RESULTATS_DIR" || exit 1
OUT="$(mktemp -d "$RESULTATS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$LECON-$TACHE-$SERIE.XXXXXX")" || exit 1
# shellcheck disable=SC2034 # lu par verrou-campagne.sh
LOCK_FILE="$RESULTATS_DIR/.verrou-campagne"
LOCK_OVERRIDE="$(printenv BANC_LOCK_FILE 2>/dev/null || true)"
# shellcheck disable=SC2034 # lu par verrou-campagne.sh
[ -n "$LOCK_OVERRIDE" ] && LOCK_FILE="$LOCK_OVERRIDE"

REPO="$(git -C "$B" rev-parse --show-toplevel 2>/dev/null || true)"
SHA_HARNAIS=inconnu
HARNAIS_MODIFIE=inconnu
if [ -n "$REPO" ]; then
  SHA_HARNAIS="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo inconnu)"
  if git -C "$REPO" diff --quiet && git -C "$REPO" diff --cached --quiet && [ -z "$(git -C "$REPO" status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
    HARNAIS_MODIFIE=false
  else
    HARNAIS_MODIFIE=true
  fi
fi

ESSAI_ID="$(basename "$OUT")"
ESSAI_CAMPAGNE="$(printenv BANC_CAMPAIGN_ID 2>/dev/null || true)"
ESSAI_DEBUT="$(horodatage)"
ESSAI_TACHE_EMPREINTE="$(python3 "$B/etude.py" empreinte-arbre "$TACHE_DIR")"
export ESSAI_ID ESSAI_CAMPAGNE ESSAI_DEBUT ESSAI_TACHE_EMPREINTE
export ESSAI_LECON="$LECON" ESSAI_TACHE="$TACHE" ESSAI_SERIE="$SERIE" ESSAI_REPETITION="$REPETITION"
export ESSAI_FIN="" ESSAI_STATUT=blocage_harnais
export ESSAI_RAISON="Essai initialisé, en attente des préconditions"
export ESSAI_SHA_HARNAIS="$SHA_HARNAIS" ESSAI_HARNAIS_MODIFIE="$HARNAIS_MODIFIE"
export ESSAI_MTPLX_URL="$MTPLX_URL" ESSAI_SMOL_DEMARRE=0 ESSAI_SMOL_RC="" ESSAI_DUREE="" ESSAI_DELAI="$DELAI"
export ESSAI_BINAIRE_FIGE=0 ESSAI_BINAIRE_EMPREINTE="" ESSAI_BINAIRE_INDEX_SHA="" ESSAI_NODE_VERSION=""
export ESSAI_SMOL_COMMANDE="" ESSAI_CONFIG_SHA="" ESSAI_NOYAU_SHA="" ESSAI_REF="" ESSAI_CONCURRENCE_MAX=""

ecrire_manifeste() { python3 "$B/etude.py" manifeste "$OUT"; }

MAISON=""
SOURCE_FICHES=""
W=""
RUNNER_PID=""
SONDE_PID=""
nettoyer() {
  # KILL : sous campagne.sh, TERM est ignoré dès l'entrée du shell (hérité).
  [ -n "$SONDE_PID" ] && kill -KILL "$SONDE_PID" 2>/dev/null && wait "$SONDE_PID" 2>/dev/null
  SONDE_PID=""
  [ -n "$MAISON" ] && rm -rf "$MAISON"
  [ -n "$SOURCE_FICHES" ] && rm -rf "$SOURCE_FICHES"
  if [ -n "$W" ] && [ -d "$W" ]; then
    tar -C "$W" --exclude=.env -czf "$OUT/espace-final.tar.gz" . 2>/dev/null
    rm -rf "$W"
  fi
  MAISON=""
  SOURCE_FICHES=""
  W=""
}

terminer() {
  ESSAI_FIN="$(horodatage)"
  export ESSAI_STATUT="$1" ESSAI_RAISON="$2" ESSAI_FIN
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
interrompre() {
  arreter_runner
  ESSAI_FIN="$(horodatage)"
  export ESSAI_STATUT=blocage_harnais ESSAI_RAISON="Essai interrompu avant un verdict vérifiable" ESSAI_FIN
  nettoyer
  ecrire_manifeste || true
  liberer_verrou
  exit 130
}
trap interrompre HUP INT TERM
trap liberer_verrou EXIT
ecrire_manifeste || { echo "Échec d'écriture du manifeste initial : $OUT" >&2; exit 1; }
prendre_verrou || terminer blocage_harnais "$LOCK_REASON" 4

python3 "$B/etude.py" controler-protocole "$REPO" > "$OUT/protocole-controle.txt" 2>&1 \
  || terminer blocage_harnais "Fichiers servis différents du protocole figé (voir protocole-controle.txt)" 4
command -v curl >/dev/null || terminer blocage_harnais "curl est introuvable" 4
command -v git >/dev/null || terminer blocage_harnais "git est introuvable" 4
command -v node >/dev/null || terminer blocage_harnais "node est introuvable" 4
ESSAI_NODE_VERSION="$(node --version)"
export ESSAI_NODE_VERSION

# Le binaire : la copie figée (empreinte du protocole), sauf smol simulé des tests.
if [ -n "$SMOL_FAUX" ]; then
  SMOL_CMD=("$SMOL_FAUX")
  DIST="$DIST_OVERRIDE"
  [ -n "$DIST" ] || DIST="$BINAIRE_DIR/dist"
  export ESSAI_SMOL_COMMANDE="$SMOL_FAUX"
else
  [ -f "$BINAIRE_DIR/dist/index.js" ] || terminer blocage_harnais "Binaire figé absent : $BINAIRE_DIR (lancer figer-binaire.sh)" 4
  EMPREINTE="$(python3 "$B/etude.py" empreinte-arbre "$BINAIRE_DIR")"
  [ "$EMPREINTE" = "$EMPREINTE_BINAIRE_ATTENDUE" ] || terminer blocage_harnais "Binaire figé modifié : $EMPREINTE au lieu de $EMPREINTE_BINAIRE_ATTENDUE" 4
  export ESSAI_BINAIRE_FIGE=1 ESSAI_BINAIRE_EMPREINTE="$EMPREINTE"
  ESSAI_BINAIRE_INDEX_SHA="$(shasum -a 256 "$BINAIRE_DIR/dist/index.js" | cut -d' ' -f1)"
  export ESSAI_BINAIRE_INDEX_SHA
  SMOL_CMD=(node "$BINAIRE_DIR/dist/index.js")
  DIST="$BINAIRE_DIR/dist"
  export ESSAI_SMOL_COMMANDE="node $BINAIRE_DIR/dist/index.js"
fi
[ -f "$DIST/fiches.js" ] || terminer blocage_harnais "fiches.js absent de $DIST" 4

# Une autre campagne du banc tient son verrou : attendre, sans jamais le prendre.
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
for _ in $(seq 1 "$ATTENTE_ESSAIS"); do
  ACTIF="$(verrou_externe_actif)" || { ACTIF=""; break; }
  sleep 5
done
[ -z "$ACTIF" ] || terminer mtplx_indisponible "Une autre campagne tient son verrou : $ACTIF" 3

recuperer_modeles() {
  curl --fail --silent --show-error --max-time 5 "$MTPLX_URL/v1/models" > "$OUT/serveur-modeles.json" 2> "$OUT/serveur-modeles.erreurs.txt" || return 1
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert any(isinstance(r,dict) and isinstance(r.get("id"),str) for r in d["data"])' "$OUT/serveur-modeles.json" 2>/dev/null
}
recuperer_snapshot() {
  curl --fail --silent --show-error --max-time 5 "$MTPLX_URL/v1/mtplx/snapshot" > "$1.tmp" 2>> "$OUT/serveur-snapshot.erreurs.txt" || return 1
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1.tmp" 2>/dev/null || return 1
  mv "$1.tmp" "$1"
}
lire_snapshot() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
value = data.get(sys.argv[2])
print(value if value is not None else "")
PY
}

recuperer_modeles || terminer mtplx_indisponible "La liste des modèles MTPLX est indisponible" 3
PRET=0
ACTIVES=inconnu
for _ in $(seq 1 "$ATTENTE_ESSAIS"); do
  if recuperer_snapshot "$OUT/serveur-snapshot-avant.json"; then
    ACTIVES="$(lire_snapshot "$OUT/serveur-snapshot-avant.json" active_requests)"
    [ "$ACTIVES" = "0" ] && { PRET=1; break; }
  fi
  sleep 5
done
[ "$PRET" -eq 1 ] || terminer mtplx_indisponible "MTPLX ne se libère pas (active_requests=$ACTIVES)" 3
MODELE="$(lire_snapshot "$OUT/serveur-snapshot-avant.json" model_id)"
[ "$MODELE" = "$MODELE_ATTENDU" ] || terminer mtplx_indisponible "Modèle servi $MODELE au lieu de $MODELE_ATTENDU" 3

# Dossier personnel de test : copies du noyau et de la configuration du serveur.
[ -s "$HOME/.smolcoder/AGENTS.md" ] || terminer blocage_harnais "Noyau absent : \$HOME/.smolcoder/AGENTS.md" 4
[ -s "$HOME/.smolcoder.json" ] || terminer blocage_harnais "Configuration absente : \$HOME/.smolcoder.json" 4
TMP_BASE="$(printenv TMPDIR 2>/dev/null || true)"
[ -n "$TMP_BASE" ] || TMP_BASE=/tmp
MAISON="$(mktemp -d "$TMP_BASE/etude-maison.XXXXXX")" || terminer blocage_harnais "Dossier personnel de test impossible" 4
mkdir -p "$MAISON/.smolcoder" || terminer blocage_harnais "Dossier personnel de test impossible" 4
cp "$HOME/.smolcoder/AGENTS.md" "$MAISON/.smolcoder/AGENTS.md" || terminer blocage_harnais "Copie du noyau impossible" 4
cp "$HOME/.smolcoder.json" "$MAISON/.smolcoder.json" || terminer blocage_harnais "Copie de la configuration impossible" 4
ESSAI_NOYAU_SHA="$(shasum -a 256 "$MAISON/.smolcoder/AGENTS.md" | cut -d' ' -f1)"
ESSAI_CONFIG_SHA="$(shasum -a 256 "$MAISON/.smolcoder.json" | cut -d' ' -f1)"
export ESSAI_NOYAU_SHA ESSAI_CONFIG_SHA

# Variante des fiches : les fiches A du protocole (docs/skills/ au commit de
# pré-enregistrement, fiches-a.sh), plus le correctif figé en série B.
SOURCE_FICHES="$(mktemp -d "$TMP_BASE/etude-fiches.XXXXXX")" || terminer blocage_harnais "Source des fiches impossible" 4
"$B/fiches-a.sh" "$SOURCE_FICHES" || terminer blocage_harnais "Extraction des fiches A impossible" 4
python3 - "$PROTOCOLE" "$SOURCE_FICHES" <<'PY' || terminer blocage_harnais "Les fiches de main ne sont plus celles du protocole" 4
import hashlib
import json
import pathlib
import sys
protocole = json.load(open(sys.argv[1], encoding="utf-8"))
source = pathlib.Path(sys.argv[2])
attendues = protocole["fiches_a"]
presentes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.glob("*.md")}
if presentes != attendues:
    raise SystemExit(1)
PY
if [ "$SERIE" = "B" ]; then
  cp "$B/$FICHIER_B" "$SOURCE_FICHES/$FICHE.md" || terminer blocage_harnais "Copie du correctif impossible" 4
  [ "$(shasum -a 256 "$SOURCE_FICHES/$FICHE.md" | cut -d' ' -f1)" = "$SHA_B" ] || terminer blocage_harnais "Fiche B différente du correctif figé" 4
fi
node "$B/installer-fiches.cjs" "$DIST" "$SOURCE_FICHES" "$MAISON/.smolcoder/fiches" > "$OUT/fiches-installees.json" 2> "$OUT/fiches-installees.erreurs.txt" \
  || terminer blocage_harnais "Installation des fiches refusée" 4
python3 - "$PROTOCOLE" "$OUT/fiches-installees.json" "$SERIE" "$FICHE" "$SHA_B" "$INDEX_ATTENDU" <<'PY' || terminer blocage_harnais "Fiches installées différentes de la variante attendue" 4
import json
import sys
protocole = json.load(open(sys.argv[1], encoding="utf-8"))
installees = json.load(open(sys.argv[2], encoding="utf-8"))
serie, fiche, sha_b, index_attendu = sys.argv[3:]
servies = {f["name"]: f["sha256"] for f in installees["fiches"]}
attendues = {nom[:-3]: sha for nom, sha in protocole["fiches_a"].items() if nom != "index.md"}
if serie == "B":
    attendues[fiche] = sha_b
if servies != attendues or installees["index_sha256"] != index_attendu:
    raise SystemExit(1)
PY

# Fixture Git jetable.
W="$(mktemp -d "$TMP_BASE/etude-ws-$TACHE.XXXXXX")" || terminer blocage_harnais "Workspace jetable impossible" 4
REF="$(python3 "$B/etude.py" preparer "$TACHE_DIR" "$W" "$OUT" "$CLE")" || terminer blocage_harnais "Préparation de la fixture impossible" 4
export ESSAI_REF="$REF"

# Timeout qui termine proprement tout le groupe de processus : TERM d'abord.
avec_timeout() {
  local rc
  trap '' HUP INT TERM
  perl -e '
    my $t = shift @ARGV;
    my $p = fork // die "fork: $!";
    my $timed_out = 0;
    if (!$p) { setpgrp(0, 0); exec @ARGV or die "exec: $!" }
    sub stop_child { kill "TERM", -$p; sleep 5; kill "KILL", -$p; waitpid $p, 0; exit 143; }
    $SIG{INT} = \&stop_child;
    $SIG{HUP} = \&stop_child;
    $SIG{TERM} = \&stop_child;
    local $SIG{ALRM} = sub { $timed_out = 1; kill "TERM", -$p; sleep 5; kill "KILL", -$p; };
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

# Sonde de concurrence : le maximum d'active_requests observé pendant l'essai.
sonder() {
  local max=0 valeur
  while true; do
    valeur="$(curl --silent --max-time 3 "$MTPLX_URL/v1/mtplx/snapshot" 2>/dev/null | python3 -c 'import json,sys
try: print(int(json.load(sys.stdin).get("active_requests")))
except Exception: print("")' 2>/dev/null)"
    case "$valeur" in ''|*[!0-9]*) ;; *) [ "$valeur" -gt "$max" ] && max="$valeur" && echo "$max" > "$OUT/concurrence-max.txt" ;; esac
    sleep 10
  done
}
echo 0 > "$OUT/concurrence-max.txt"
sonder &
SONDE_PID=$!

t0="$(date +%s)"
export ESSAI_SMOL_DEMARRE=1
avec_timeout "$DELAI" env -u SMOL_NO_FICHES -u SMOL_NO_GLOBAL_AGENTS -u SMOLCODER_CONFIG -u FORCE_COLOR -u OLLAMA_HOST \
  HOME="$MAISON" PATH="$PATH_OUTILS:$(dirname "$(command -v node)")" NO_COLOR=1 \
  ETUDE_ATTENDU_FICHE="$FICHE" ETUDE_ATTENDU_SERIE="$SERIE" \
  "${SMOL_CMD[@]}" "$W" -m edit -p "$(cat "$PROMPT_FILE")" \
  > "$OUT/sortie.txt" 2> "$OUT/erreurs.txt" < /dev/null
SMOL_RC=$?
ESSAI_DUREE="$(( $(date +%s) - t0 ))"
export ESSAI_SMOL_RC="$SMOL_RC" ESSAI_DUREE
kill -KILL "$SONDE_PID" 2>/dev/null
wait "$SONDE_PID" 2>/dev/null
SONDE_PID=""
ESSAI_CONCURRENCE_MAX="$(cat "$OUT/concurrence-max.txt" 2>/dev/null || echo "")"
export ESSAI_CONCURRENCE_MAX
recuperer_snapshot "$OUT/serveur-snapshot-apres.json" || true

# Vérification de l'état final, indépendante du récit du modèle.
ETUDE_PATH_OUTILS="$PATH_OUTILS" python3 "$B/etude.py" verifier "$TACHE_DIR" "$W" "$OUT" "$CLE" "$REF" > "$OUT/verification-resume.txt" 2> "$OUT/verification-erreurs.txt" \
  || terminer blocage_harnais "Vérification de l'état final impossible" 4
REUSSITE="$(python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1]))["reussite"] else "0")' "$OUT/verification.json")"

if [ "$SMOL_RC" -ne 0 ]; then
  if ! recuperer_modeles; then
    terminer mtplx_indisponible "smol a terminé avec le code $SMOL_RC et MTPLX ne répond plus : essai non compté" 3
  fi
  if [ "$SMOL_RC" -eq 124 ] && [ "${ESSAI_CONCURRENCE_MAX:-0}" -ge 2 ] 2>/dev/null; then
    terminer mtplx_indisponible "Délai dépassé pendant une concurrence observée sur MTPLX (active_requests=$ESSAI_CONCURRENCE_MAX) : essai non compté" 3
  fi
  terminer echec_execution "smol a terminé avec le code $SMOL_RC : essai compté, jamais réussi" 1
fi
[ "$REUSSITE" = "1" ] && terminer succes "État final conforme : acceptation, commande documentée, mutations, périmètre et sécurité" 0
terminer echec_test "État final non conforme (voir verification.json)" 1
