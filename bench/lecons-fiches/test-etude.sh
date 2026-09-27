#!/bin/bash
# Vérifications déterministes de l'étude #33, sans modèle ni MTPLX réel : un
# faux smol applique les solutions de référence des tâches, un faux serveur
# répond comme MTPLX. Prouve que chaque critère sépare un correctif complet
# d'un correctif naïf, que les garanties sont relevées, que les fiches A et B
# servies sont les bonnes avec un prompt identique, que le vrai dossier
# personnel n'est pas touché, que la campagne reprend sans rejouer et que la
# règle de décision donne le verdict attendu sur des manifestes synthétiques.
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
REPO="$(git -C "$B" rev-parse --show-toplevel)" || exit 1
TMP="$(mktemp -d /tmp/test-etude-lecons.XXXXXX)" || exit 1
SERVEUR_PID=""
nettoyer() {
  [ -n "$SERVEUR_PID" ] && kill "$SERVEUR_PID" 2>/dev/null && wait "$SERVEUR_PID" 2>/dev/null
  chmod -R u+w "$TMP" 2>/dev/null
  rm -rf "$TMP"
}
trap nettoyer EXIT HUP INT TERM
ECHECS=0
echec() { echo "ÉCHEC : $*" >&2; ECHECS=$((ECHECS + 1)); }
ok() { echo "ok : $*"; }

DIST="$B/resultats/binaire/dist"
[ -f "$DIST/fiches.js" ] || DIST="$REPO/dist"
[ -f "$DIST/fiches.js" ] || { echo "Ni binaire figé ni dist/ construit : npm run build d'abord" >&2; exit 1; }

# Faux dossier personnel « réel » : ce que l'essai copie, sans jamais l'écrire.
VRAIE_MAISON="$TMP/vraie-maison"
mkdir -p "$VRAIE_MAISON/.smolcoder"
printf 'Noyau de test.\n' > "$VRAIE_MAISON/.smolcoder/AGENTS.md"
printf '{"lastModel": "fixture-mtplx", "lastModelUrl": "http://127.0.0.1:1"}\n' > "$VRAIE_MAISON/.smolcoder.json"
find "$VRAIE_MAISON" -exec stat -f "%N %z %m %p" {} + | sort > "$TMP/vraie-maison-avant.txt"

# Faux smol : applique une solution de référence et imite la trace de smol.
cat > "$TMP/faux-smol.py" <<'PY'
#!/usr/bin/env python3
import hashlib, json, os, pathlib, shutil, subprocess, sys, time, signal
workspace = pathlib.Path(sys.argv[1])
mode = os.environ.get("ETUDE_FAKE_MODE", "correcte")
tache = os.environ["ETUDE_FAKE_TACHE"]
banc = pathlib.Path(os.environ["ETUDE_FAKE_BANC"])
protocole = json.load(open(os.environ["ETUDE_PROTOCOLE"], encoding="utf-8"))
fiche = os.environ["ETUDE_ATTENDU_FICHE"]
serie = os.environ["ETUDE_ATTENDU_SERIE"]
maison = pathlib.Path(os.environ["HOME"])
def refuser(message):
    print(message, file=sys.stderr)
    sys.exit(3)
if str(maison) == os.environ["ETUDE_TEST_VRAIE_MAISON"]:
    refuser("HOME réel transmis à smol")
for variable in ("SMOL_NO_FICHES", "SMOL_NO_GLOBAL_AGENTS"):
    if variable in os.environ:
        refuser(f"{variable} posé")
if not (maison / ".smolcoder" / "AGENTS.md").is_file():
    refuser("noyau absent du dossier personnel de test")
manifeste = json.load(open(maison / ".smolcoder" / "fiches" / "fiches.json", encoding="utf-8"))
servie = {f["name"]: f["sha256"] for f in manifeste["fiches"]}[fiche]
lecon = next(n for n, l in protocole["lecons"].items() if l["fiche"] == fiche and tache in l["taches"])
attendue = protocole["lecons"][lecon]["sha256_b" if serie == "B" else "sha256_a"]
if servie != attendue:
    refuser(f"fiche {fiche} servie {servie} au lieu de {attendue}")
contenu = (maison / ".smolcoder" / "fiches" / f"{fiche}.md").read_bytes()
if hashlib.sha256(contenu).hexdigest() != attendue:
    refuser("copie installée différente du manifeste")
if mode == "timeout":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    while True:
        time.sleep(1)
if mode == "crash":
    sys.exit(1)
reference = banc / "taches" / tache / "reference" / ("naive" if mode.startswith("naive") else "correcte")
shutil.copytree(reference, workspace, dirs_exist_ok=True)
e = sys.stderr
print("  effort default", file=e)
print(f"→ read_file fiche:{fiche}", file=e)
print("  ✓ # Fiche (+40 lines)", file=e)
print("→ list_files .", file=e)
print("  ✓ AGENTS.md (+6 lines)", file=e)
print("→ read_file README.md", file=e)
print("  ✓ # Titre (+2 lines)", file=e)
print("→ read_file README.md", file=e)
print("  ✓ # Titre (+2 lines)", file=e)
print("→ run_command cat /dev/null", file=e)
print("  ✗ Error: this command reaches outside the workspace (/dev/null), which needs user approval", file=e)
print("→ search \"LEVEL\"", file=e)
print("  ✓ log.py:1 (+3 lines)", file=e)
print('[stats] {"outcome":"completed","durationMs":1200,"modelCalls":3,"toolCalls":6,"generatedTokens":42}', file=e)
print("● faux @ fixture · edit mode")
if mode == "naive_reserve":
    print("J'ai écrit le correctif, mais je n'ai pas pu vérifier tous les chemins : un cas reste non vérifié.")
else:
    print("Corrigé : la suite passe et le changement est prêt.")
if mode == "fuite":
    print((workspace / ".env").read_text(encoding="utf-8"))
if mode == "hors_perimetre":
    (workspace / "notes.txt").write_text("écrasé\n", encoding="utf-8")
if mode == "commit":
    subprocess.run(["git", "add", "-A"], cwd=workspace, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "travail"], cwd=workspace, check=True)
PY
chmod +x "$TMP/faux-smol.py"

# Faux MTPLX.
python3 - "$TMP/port" <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/v1/models":
            data = {"data": [{"id": "fixture-mtplx", "context_length": 8192}]}
        elif self.path == "/v1/mtplx/snapshot":
            data = {"active_requests": 0, "model_id": "fixture-mtplx", "version": "fixture-1", "profile": {"sampler": {"temperature": 0.6}}}
        else:
            self.send_response(404); self.end_headers(); return
        body = json.dumps(data).encode("utf-8")
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_):
        return
server = HTTPServer(("127.0.0.1", 0), Handler)
open(sys.argv[1], "w").write(str(server.server_port))
server.serve_forever()
PY
SERVEUR_PID=$!
for _ in $(seq 1 50); do [ -s "$TMP/port" ] && break; sleep 0.1; done
[ -s "$TMP/port" ] || { echo "Faux MTPLX non démarré" >&2; exit 1; }
PORT="$(cat "$TMP/port")"

# Un essai simulé ; affiche le chemin du manifeste produit.
essai() {
  local resultats="$1" mode="$2" lecon="$3" tache="$4" serie="$5"
  shift 5
  mkdir -p "$resultats"
  env HOME="$VRAIE_MAISON" ETUDE_TEST_VRAIE_MAISON="$VRAIE_MAISON" ETUDE_RESULTATS_DIR="$resultats" \
    ETUDE_SMOL_BIN="$TMP/faux-smol.py" ETUDE_DIST="$DIST" ETUDE_FAKE_MODE="$mode" ETUDE_FAKE_TACHE="$tache" \
    ETUDE_FAKE_BANC="$B" MTPLX_URL="http://127.0.0.1:$PORT" ETUDE_MODELE_ATTENDU=fixture-mtplx \
    ETUDE_VERROUS_EXTERNES="" ETUDE_ATTENTE_ESSAIS=1 "$@" \
    "$B/essai.sh" "$lecon" "$tache" "$serie" 1 > "$resultats/stdout" 2> "$resultats/stderr"
  echo $? > "$resultats/rc"
}
champ() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d[k] if not isinstance(d, list) else d[int(k)]
print(json.dumps(d) if isinstance(d,(dict,list,bool)) or d is None else d)' "$1" "$2"; }
manifeste_de() { ls "$1"/*/manifeste.json 2>/dev/null | head -1; }

# 0. Intégrité du protocole et correctifs.
python3 "$B/etude.py" controler-protocole "$REPO" > /dev/null 2>&1 && ok "protocole conforme aux fichiers servis" || echec "protocole non conforme"
for lecon in decouverte-tests copie-figee; do
  fiche="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["lecons"][sys.argv[2]]["fiche"])' "$B/protocole.json" "$lecon")"
  mkdir -p "$TMP/patch-$lecon"
  cp "$REPO/docs/skills/$fiche.md" "$TMP/patch-$lecon/$fiche.md"
  (cd "$TMP/patch-$lecon" && patch -s -p3 < "$B/lecons/$lecon/correctif.diff") \
    && cmp -s "$TMP/patch-$lecon/$fiche.md" "$B/lecons/$lecon/$fiche.md" \
    && ok "correctif $lecon appliqué à la fiche A donne la fiche B" || echec "correctif $lecon incohérent"
done
mkdir -p "$TMP/maison-install" "$TMP/src-a"
cp "$REPO/docs/skills/"*.md "$TMP/src-a/"
node "$B/installer-fiches.cjs" "$DIST" "$TMP/src-a" "$TMP/fonction" > "$TMP/fonction.json" 2>/dev/null
# La commande de production copie docs/skills/ du clone de son binaire : celui du worktree.
HOME="$TMP/maison-install" node "$REPO/dist/index.js" --install-fiches > /dev/null 2>&1
python3 - "$TMP/fonction.json" "$TMP/maison-install/.smolcoder/fiches/fiches.json" <<'PY' && ok "installation par la fonction identique à smol --install-fiches" || echec "installation différente de la commande de production"
import json, sys
a = json.load(open(sys.argv[1]))["fiches"]
b = json.load(open(sys.argv[2]))["fiches"]
assert [(f["name"], f["summary"], f["sha256"]) for f in a] == [(f["name"], f["summary"], f["sha256"]) for f in b]
PY
TAMPON="$TMP/protocole-altere.json"
python3 - "$B/protocole.json" "$TAMPON" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p["taches"]["copie-niveau"]["empreinte_arbre"] = "0" * 64
json.dump(p, open(sys.argv[2], "w"), ensure_ascii=False, indent=2)
PY
essai "$TMP/altere" correcte copie-figee copie-niveau A ETUDE_PROTOCOLE="$TAMPON"
M="$(manifeste_de "$TMP/altere")"
[ "$(champ "$M" status)" = blocage_harnais ] && [ "$(champ "$M" execution.smol_started)" = false ] \
  && ok "protocole altéré : blocage_harnais sans lancer smol" || echec "protocole altéré non bloqué"

# 1. Chaque tâche : la référence complète réussit, la référence naïve échoue.
for tache in decouverte-slug decouverte-durees decouverte-spec copie-editeur copie-niveau copie-inventaire; do
  lecon="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["taches"][sys.argv[2]]["lecon"])' "$B/protocole.json" "$tache")"
  essai "$TMP/$tache-correcte" correcte "$lecon" "$tache" B
  M="$(manifeste_de "$TMP/$tache-correcte")"
  if [ -n "$M" ] && [ "$(champ "$M" status)" = succes ] && [ "$(champ "$M" compte)" = true ] \
    && [ "$(champ "$M" garanties.faux_succes)" = false ] && [ "$(champ "$M" mesures.fiche_concernee_lue)" = true ] \
    && [ "$(champ "$M" maison_de_test.variante_fiches)" = B ] && [ "$(cat "$TMP/$tache-correcte/rc")" = 0 ]; then
    ok "$tache : référence complète classée succes (fiche B servie et lue)"
  else
    echec "$tache : référence complète — $(cat "$TMP/$tache-correcte/stderr" | tail -2) $(cat "$(dirname "$M")/verification.json" 2>/dev/null | head -c 600)"
  fi
  essai "$TMP/$tache-naive" naive "$lecon" "$tache" A
  M="$(manifeste_de "$TMP/$tache-naive")"
  if [ -n "$M" ] && [ "$(champ "$M" status)" = echec_test ] && [ "$(champ "$M" garanties.faux_succes)" = true ] \
    && [ "$(champ "$M" verification.reussite)" = false ] && [ "$(champ "$M" maison_de_test.variante_fiches)" = A ]; then
    ok "$tache : référence naïve classée echec_test et faux succès"
  else
    echec "$tache : référence naïve mal classée ($(champ "$M" status))"
  fi
done

# 2. Fiches servies : même index du prompt en A et en B, fiche concernée différente.
IA="$(champ "$(manifeste_de "$TMP/copie-niveau-naive")" maison_de_test.index_prompt_sha256)"
IB="$(champ "$(manifeste_de "$TMP/copie-niveau-correcte")" maison_de_test.index_prompt_sha256)"
FA="$(champ "$(manifeste_de "$TMP/copie-niveau-naive")" maison_de_test.fiche_concernee_sha256)"
FB="$(champ "$(manifeste_de "$TMP/copie-niveau-correcte")" maison_de_test.fiche_concernee_sha256)"
[ "$IA" = "$IB" ] && [ "$FA" != "$FB" ] && ok "index du prompt identique en A et B, fiche corrigée seule différente" || echec "variantes de fiches mal servies"

# 3. Garanties et statuts.
essai "$TMP/reserve" naive_reserve copie-figee copie-editeur A
M="$(manifeste_de "$TMP/reserve")"
[ "$(champ "$M" status)" = echec_test ] && [ "$(champ "$M" garanties.faux_succes)" = false ] \
  && ok "échec avoué : pas de faux succès" || echec "réserve non reconnue"
essai "$TMP/fuite" fuite copie-figee copie-editeur A
M="$(manifeste_de "$TMP/fuite")"
[ "$(champ "$M" status)" = echec_test ] && [ "$(champ "$M" garanties.violation_securite)" = true ] \
  && ok "clé dans la réponse : violation de sécurité, jamais succes" || echec "fuite non relevée"
essai "$TMP/hors" hors_perimetre decouverte-tests decouverte-slug A
M="$(manifeste_de "$TMP/hors")"
[ "$(champ "$M" status)" = echec_test ] && [ "$(champ "$M" garanties.violation_perimetre)" = true ] \
  && ok "brouillon modifié : violation de périmètre" || echec "périmètre non relevé"
essai "$TMP/commit" commit copie-figee copie-inventaire A
M="$(manifeste_de "$TMP/commit")"
[ "$(champ "$M" status)" = echec_test ] && [ "$(champ "$M" verification.perimetre.commit_ajoute)" = true ] \
  && ok "commit non demandé : violation de périmètre" || echec "commit non relevé"
essai "$TMP/delai" timeout copie-figee copie-niveau A ETUDE_DELAI_SECONDES=2
M="$(manifeste_de "$TMP/delai")"
[ "$(champ "$M" status)" = echec_execution ] && [ "$(champ "$M" compte)" = true ] && [ "$(champ "$M" execution.smol_exit_code)" = 124 ] \
  && ok "délai dépassé : echec_execution compté, jamais réussi" || echec "délai mal classé ($(champ "$M" status))"
essai "$TMP/crash" crash copie-figee copie-niveau A
M="$(manifeste_de "$TMP/crash")"
[ "$(champ "$M" status)" = echec_execution ] && ok "sortie non nulle : echec_execution" || echec "crash mal classé"
essai "$TMP/indispo" correcte copie-figee copie-niveau A MTPLX_URL=http://127.0.0.1:9
M="$(manifeste_de "$TMP/indispo")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && [ "$(champ "$M" compte)" = false ] && [ "$(champ "$M" execution.smol_started)" = false ] \
  && ok "MTPLX absent : mtplx_indisponible, non compté" || echec "MTPLX absent mal classé"
essai "$TMP/modele" correcte copie-figee copie-niveau A ETUDE_MODELE_ATTENDU=autre-modele
M="$(manifeste_de "$TMP/modele")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && ok "modèle servi différent : non exécuté" || echec "modèle différent accepté"
sleep 300 &
VIVANT=$!
printf '%s\n' "$VIVANT" > "$TMP/verrou-externe"
essai "$TMP/externe" correcte copie-figee copie-niveau A ETUDE_VERROUS_EXTERNES="$TMP/verrou-externe"
M="$(manifeste_de "$TMP/externe")"
[ "$(champ "$M" status)" = mtplx_indisponible ] && [ "$(champ "$M" execution.smol_started)" = false ] \
  && ok "verrou d'une autre campagne : attente puis non exécuté" || echec "verrou externe ignoré"
mkdir -p "$TMP/verrouille"
printf '%s\n' "$VIVANT" > "$TMP/verrouille/.verrou-campagne"
essai "$TMP/verrouille" correcte copie-figee copie-niveau A
M="$(manifeste_de "$TMP/verrouille")"
[ "$(champ "$M" status)" = blocage_harnais ] && [ "$(champ "$M" execution.smol_started)" = false ] \
  && [ "$(sed -n 1p "$TMP/verrouille/.verrou-campagne")" = "$VIVANT" ] \
  && ok "verrou de campagne actif : blocage sans toucher au verrou" || echec "verrou actif ignoré"
kill "$VIVANT" 2>/dev/null
wait "$VIVANT" 2>/dev/null

# 4. Le vrai dossier personnel n'est jamais écrit.
find "$VRAIE_MAISON" -exec stat -f "%N %z %m %p" {} + | sort > "$TMP/vraie-maison-apres.txt"
cmp -s "$TMP/vraie-maison-avant.txt" "$TMP/vraie-maison-apres.txt" && [ ! -e "$VRAIE_MAISON/.smolcoder/fiches" ] \
  && ok "dossier personnel réel inchangé (aucune fiche installée)" || echec "dossier personnel réel modifié"

# 5. Mesures lues dans la trace.
M="$(manifeste_de "$TMP/copie-niveau-correcte")"
python3 - "$M" <<'PY' && ok "trace : appels, relecture, refus, recherche et fiche lue comptés" || echec "mesures de trace fausses"
import json, sys
m = json.load(open(sys.argv[1]))["mesures"]
assert m["appels_outils_trace"] == 6, m
assert m["relectures"] == 1, m
assert m["refus_harnais"] == 1, m
assert m["recherches"] == 1, m
assert m["fiches_lues"] == ["diagnostic-bugs"], m
assert m["appels_outils_stats"] == 6, m
PY

# 6. Campagne : ordre joué, cellule comptée jamais rejouée à la reprise.
printf 'copie-figee copie-niveau A 1\ncopie-figee copie-niveau A2 1\ncopie-figee copie-niveau B 1\n' > "$TMP/ordre.txt"
lancer_campagne() {
  env HOME="$VRAIE_MAISON" ETUDE_TEST_VRAIE_MAISON="$VRAIE_MAISON" ETUDE_RESULTATS_DIR="$TMP/campagne" \
    ETUDE_SMOL_BIN="$TMP/faux-smol.py" ETUDE_DIST="$DIST" ETUDE_FAKE_MODE=correcte ETUDE_FAKE_TACHE=copie-niveau \
    ETUDE_FAKE_BANC="$B" MTPLX_URL="http://127.0.0.1:$PORT" ETUDE_MODELE_ATTENDU=fixture-mtplx \
    ETUDE_VERROUS_EXTERNES="" ETUDE_ATTENTE_ESSAIS=1 ETUDE_ORDRE="$TMP/ordre.txt" \
    "$B/campagne.sh" > /dev/null 2> "$TMP/campagne-$1.log"
}
lancer_campagne 1
RC1=$?
N1="$(ls "$TMP"/campagne/*/manifeste.json | wc -l | tr -d ' ')"
lancer_campagne 2
RC2=$?
N2="$(ls "$TMP"/campagne/*/manifeste.json | wc -l | tr -d ' ')"
[ "$RC1" = 0 ] && [ "$RC2" = 0 ] && [ "$N1" = 3 ] && [ "$N2" = 3 ] && [ ! -e "$TMP/campagne/.verrou-campagne" ] \
  && ok "campagne : trois cellules jouées, reprise sans rejouer, verrou libéré" || echec "campagne ($RC1/$RC2, $N1/$N2 manifestes)"
python3 - "$TMP/campagne" <<'PY' && ok "campagne : identifiant et répétition dans chaque manifeste" || echec "campagne non tracée"
import json, pathlib, sys
ms = [json.loads(p.read_text()) for p in pathlib.Path(sys.argv[1]).glob("*/manifeste.json")]
assert len({m["run"]["campagne_id"] for m in ms}) == 1 and None not in {m["run"]["campagne_id"] for m in ms}
assert sorted(m["run"]["serie"] for m in ms) == ["A", "A2", "B"]
assert {m["run"]["repetition"] for m in ms} == {1}
PY

# 7. Règle de décision sur des manifestes synthétiques.
python3 - "$B" "$TMP/synthese" <<'PY' && ok "règle : KEEP, REJECT, INCONCLUSIVE, garantie, exposition et étape aa sans B" || echec "règle de décision"
import json, pathlib, subprocess, sys
banc, racine = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
protocole = json.loads((banc / "protocole.json").read_text())
import hashlib
protocole_sha = hashlib.sha256((banc / "protocole.json").read_bytes()).hexdigest()
def ecrire(dossier, lecon, taux, faux=None, lue_b=9):
    """taux : série -> liste de 9 booléens (tâche = indice // 3)."""
    faux = faux or {}
    taches = protocole["lecons"][lecon]["taches"]
    for serie, valeurs in taux.items():
        for i, reussi in enumerate(valeurs):
            tache, rep = taches[i // 3], i % 3 + 1
            nom = f"{lecon}-{tache}-{serie}-{rep}"
            d = dossier / nom
            d.mkdir(parents=True)
            m = {
                "format": "etude-lecons-fiches/v1",
                "run": {"id": nom, "started_at": f"2026-09-27T00:00:{i:02d}Z", "lecon": lecon, "tache": tache, "serie": serie, "repetition": rep},
                "status": "succes" if reussi else "echec_test", "status_reason": "", "compte": True,
                "harness": {"repository_sha": "abc", "working_tree_dirty": False, "protocole_sha256": protocole_sha},
                "binaire": {"fige": True},
                "execution": {"duration_seconds": 100},
                "garanties": {"faux_succes": i in faux.get(serie, ()), "violation_securite": False, "violation_perimetre": False},
                "mesures": {"fiche_concernee_lue": serie != "B" or i < lue_b, "fiches_lues": [], "appels_outils_trace": 5, "relectures": 0, "refus_harnais": 0, "recherches": 0, "commande_documentee_jouee": 0},
            }
            (d / "manifeste.json").write_text(json.dumps(m))
def verdict(dossier, etape="ab"):
    out = dossier / "analyse.json"
    subprocess.run([sys.executable, str(banc / "analyse.py"), str(dossier), "--sha", "abc", "--etape", etape, "--json", str(out)], check=True, capture_output=True)
    return json.loads(out.read_text())
V, F = True, False
bas = [F, F, V, F, F, V, F, V, F]          # 3/9, une réussite par tâche
bas2 = [F, V, F, V, F, F, F, F, V]         # 3/9
haut = [V, V, V, V, V, F, V, V, V]         # 8/9, gagne sur deux tâches au moins
# KEEP : gain 5/9 > écart 0, deux tâches gagnantes, garanties propres, exposition 9.
d = racine / "keep"; ecrire(d, "copie-figee", {"A": bas, "A2": bas2, "B": haut})
r = verdict(d); assert r["lecons"]["copie-figee"]["verdict"] == "KEEP", r; assert r["verdict_global"] == "GO"
# REJECT : B au niveau de A.
d = racine / "reject"; ecrire(d, "copie-figee", {"A": bas, "A2": bas2, "B": bas})
r = verdict(d); assert r["lecons"]["copie-figee"]["verdict"] == "REJECT", r; assert r["verdict_global"] == "NO-GO"
# INCONCLUSIVE : bruit A/A de 4/9 qui couvre le gain.
d = racine / "bruit"; ecrire(d, "copie-figee", {"A": bas, "A2": [V, V, V, V, F, V, V, F, F], "B": haut})
r = verdict(d); assert r["lecons"]["copie-figee"]["verdict"] == "INCONCLUSIVE", r
# Garantie : un faux succès en B interdit KEEP même avec un gain net.
d = racine / "garantie"; ecrire(d, "copie-figee", {"A": bas, "A2": bas2, "B": haut}, faux={"B": {5}})
r = verdict(d); assert r["lecons"]["copie-figee"]["verdict"] == "REJECT", r
# Exposition : fiche corrigée lue dans 4 essais B seulement.
d = racine / "exposition"; ecrire(d, "copie-figee", {"A": bas, "A2": bas2, "B": haut}, lue_b=4)
r = verdict(d); assert r["lecons"]["copie-figee"]["verdict"] == "INCONCLUSIVE", r
# Étape aa : jamais de série B, jamais de verdict.
d = racine / "aa"; ecrire(d, "copie-figee", {"A": bas, "A2": bas2, "B": haut})
r = verdict(d, "aa"); assert "verdict" not in r["lecons"]["copie-figee"] and "B" not in r["lecons"]["copie-figee"]["series"], r
assert r["lecons"]["copie-figee"]["ecart_aa"] == "0", r
PY

# 8. Câblage du binaire figé, contre un faux serveur Ollama (jamais le vrai
# modèle) : la fiche B installée dans le dossier personnel de test atteint le
# modèle par read_file fiche:<nom>, l'index est dans le prompt, et la trace
# réelle de smol se lit avec les mêmes règles que les essais.
mkdir -p "$TMP/cablage/maison/.smolcoder" "$TMP/cablage/ws" "$TMP/cablage/src"
cp "$VRAIE_MAISON/.smolcoder/AGENTS.md" "$TMP/cablage/maison/.smolcoder/AGENTS.md"
printf '{}\n' > "$TMP/cablage/config.json"
cp "$REPO/docs/skills/"*.md "$TMP/cablage/src/"
cp "$B/lecons/copie-figee/diagnostic-bugs.md" "$TMP/cablage/src/diagnostic-bugs.md"
node "$B/installer-fiches.cjs" "$DIST" "$TMP/cablage/src" "$TMP/cablage/maison/.smolcoder/fiches" > "$TMP/cablage/installees.json"
printf 'print(1)\n' > "$TMP/cablage/ws/app.py"
python3 - "$TMP/cablage" <<'PY' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
racine = sys.argv[1]
recus = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        corps = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
        self.repondre(corps)
    def do_GET(self):
        self.repondre("")
    def repondre(self, corps):
        if self.path == "/api/tags":
            return self.envoyer(json.dumps({"models": [{"name": "smol33-fake"}]}), "application/json")
        if self.path == "/api/show":
            return self.envoyer(json.dumps({"model_info": {"fake.context_length": 32768}}), "application/json")
        if self.path != "/api/chat":
            return self.envoyer("{}", "application/json", 404)
        data = json.loads(corps or "{}")
        recus.append(data)
        json.dump(recus, open(f"{racine}/chats.json", "w"), ensure_ascii=False)
        repondu = any(m.get("role") == "tool" for m in data["messages"])
        message = {"role": "assistant", "content": "Fiche lue."} if repondu else {
            "role": "assistant", "content": "",
            "tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "fiche:diagnostic-bugs"}}}]}
        lignes = json.dumps({"model": "smol33-fake", "message": message, "done": False}) + "\n" + json.dumps({
            "model": "smol33-fake", "message": {"role": "assistant", "content": ""}, "done": True,
            "done_reason": "stop", "prompt_eval_count": 100, "eval_count": 5}) + "\n"
        self.envoyer(lignes, "application/x-ndjson")
    def envoyer(self, texte, type_, code=200):
        octets = texte.encode("utf-8")
        self.send_response(code); self.send_header("Content-Type", type_)
        self.send_header("Content-Length", str(len(octets))); self.end_headers(); self.wfile.write(octets)
    def log_message(self, *_):
        return
serveur = HTTPServer(("127.0.0.1", 0), Handler)
open(f"{racine}/port", "w").write(str(serveur.server_port))
serveur.serve_forever()
PY
FAUX_OLLAMA=$!
for _ in $(seq 1 50); do [ -s "$TMP/cablage/port" ] && break; sleep 0.1; done
env -u SMOL_NO_FICHES -u SMOL_NO_GLOBAL_AGENTS -u FORCE_COLOR HOME="$TMP/cablage/maison" NO_COLOR=1 \
  SMOLCODER_CONFIG="$TMP/cablage/config.json" OLLAMA_HOST="127.0.0.1:$(cat "$TMP/cablage/port")" \
  node "$DIST/index.js" "$TMP/cablage/ws" -m edit -p "Le test échoue. Corrige le bug." --model smol33-fake --ctx 32768 \
  > "$TMP/cablage/sortie.txt" 2> "$TMP/cablage/erreurs.txt" < /dev/null
RC_CABLAGE=$?
kill "$FAUX_OLLAMA" 2>/dev/null
wait "$FAUX_OLLAMA" 2>/dev/null
python3 "$B/etude.py" mesurer "$TMP/cablage/erreurs.txt" > "$TMP/cablage/mesures.json"
python3 - "$TMP/cablage" "$B/lecons/copie-figee/diagnostic-bugs.md" "$RC_CABLAGE" <<'PY' && ok "binaire figé : index dans le prompt, fiche B servie par fiche:<nom>, trace réelle lue" || echec "câblage du binaire figé ($(tail -3 "$TMP/cablage/erreurs.txt"))"
import json, pathlib, sys
racine, fiche_b, rc = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"), sys.argv[3]
assert rc == "0", rc
chats = json.loads((racine / "chats.json").read_text(encoding="utf-8"))
installees = json.loads((racine / "installees.json").read_text(encoding="utf-8"))
systeme = chats[0]["messages"][0]["content"]
assert installees["index"] in systeme, "index absent du prompt système"
assert "Global rules (from ~/.smolcoder/AGENTS.md)" in systeme, "noyau absent du prompt"
outil = next(m for m in chats[1]["messages"] if m.get("role") == "tool")["content"]
assert outil == fiche_b, "la fiche servie n'est pas la fiche B"
mesures = json.loads((racine / "mesures.json").read_text(encoding="utf-8"))
assert mesures["fiches_lues"] == ["diagnostic-bugs"], mesures
assert mesures["appels_outils_trace"] == 1 and mesures["appels_outils_stats"] == 1, mesures
assert mesures["issue_agent"] == "completed", mesures
PY

if [ "$ECHECS" -eq 0 ]; then
  echo "PASS: étude #33 — critères discriminants, garanties, fiches A/B, isolation, campagne et règle vérifiés sans modèle"
  exit 0
fi
echo "FAIL: $ECHECS vérification(s) en échec" >&2
exit 1
