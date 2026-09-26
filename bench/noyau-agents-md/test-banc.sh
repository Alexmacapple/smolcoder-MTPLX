#!/bin/bash
# Vérifications déterministes du banc, sans modèle ni serveur MTPLX réel.
set -u

B="$(cd "$(dirname "$0")" && pwd)" || exit 1
TMP_BASE="$(printenv TMPDIR 2>/dev/null || true)"
[ -n "$TMP_BASE" ] || TMP_BASE=/tmp
TMP="$(mktemp -d "$TMP_BASE/test-banc-noyau.XXXXXX")" || exit 1
SERVEUR_PID=""
cleanup() {
  [ -n "$SERVEUR_PID" ] && kill "$SERVEUR_PID" 2>/dev/null
  [ -n "$SERVEUR_PID" ] && wait "$SERVEUR_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$TMP/home/.smolcoder"
printf 'Règles de test du banc.\n' > "$TMP/home/.smolcoder/AGENTS.md"
cat > "$TMP/smol-simule.sh" <<'SH'
#!/bin/bash
workspace="$1"
mode="$(printenv BANC_FAKE_MODE 2>/dev/null || true)"
if [ "$mode" = "timeout" ]; then
  trap 'exit 0' TERM
  while true; do sleep 1; done
else
  perl -0pi -e 's/return a - b/return a + b/' "$workspace/calc.py"
  if [ "$mode" = "violation_perimetre" ]; then
    printf 'régression injectée\n' > "$workspace/fichier-interdit.txt"
  fi
fi
SH
chmod +x "$TMP/smol-simule.sh"

python3 - "$TMP/port" <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/v1/models":
            data = {"data": [{"id": "fixture-mtplx", "context_length": 8192}]}
        elif self.path == "/v1/mtplx/snapshot":
            data = {
                "active_requests": 0,
                "model_id": "fixture-mtplx",
                "version": "fixture-1",
                "settings": {"temperature": 0},
            }
        else:
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        return


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w", encoding="utf-8") as file:
    file.write(str(server.server_port))
server.serve_forever()
PY
SERVEUR_PID=$!
for _ in $(seq 1 50); do
  [ -s "$TMP/port" ] && break
  sleep 0.1
done
[ -s "$TMP/port" ] || { echo "Serveur simulé non démarré" >&2; exit 1; }
PORT="$(cat "$TMP/port")"

jouer() {
  local mode="$1"
  local attendu="$2"
  local perimetre="$3"
  local rc_attendu="$4"
  local delai="${5:-}"
  local resultat="$TMP/$mode-$attendu"
  local rc
  mkdir -p "$resultat"
  set +e
  HOME="$TMP/home" BANC_RESULTS_DIR="$resultat" BANC_SMOL_BIN="$TMP/smol-simule.sh" \
    BANC_FAKE_MODE="$mode" MTPLX_URL="http://127.0.0.1:$PORT" \
    BANC_TIMEOUT_SECONDS="$delai" \
    "$B/banc.sh" bug avec > "$resultat/stdout" 2> "$resultat/stderr"
  rc=$?
  python3 - "$resultat" "$attendu" "$perimetre" "$rc_attendu" "$rc" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifests = list(root.glob("*/manifeste.json"))
if len(manifests) != 1:
    raise SystemExit(f"manifeste attendu une fois, trouvé {len(manifests)}")
data = json.loads(manifests[0].read_text(encoding="utf-8"))
expected_status, expected_scope, expected_rc, actual_rc = sys.argv[2:]
if data["status"] != expected_status:
    raise SystemExit(f"statut {data['status']} au lieu de {expected_status}")
if str(data["verification"]["scope_expectation_met"]).lower() != expected_scope:
    raise SystemExit("périmètre inattendu")
expected_smol_rc = "124" if expected_status == "blocage_harnais" else "0"
if str(data["execution"]["smol_exit_code"]) != expected_smol_rc:
    raise SystemExit("code de smol simulé inattendu")
if data["server"]["model_id"] != "fixture-mtplx":
    raise SystemExit("modèle du snapshot absent")
if actual_rc != expected_rc:
    raise SystemExit(f"code du banc {actual_rc} au lieu de {expected_rc}")
PY
  [ "$?" -eq 0 ] || return 1
}

jouer_campagne() {
  local resultat="$TMP/campagne"
  local rc
  mkdir -p "$resultat"
  set +e
  HOME="$TMP/home" BANC_RESULTS_DIR="$resultat" BANC_SMOL_BIN="$TMP/smol-simule.sh" \
    BANC_FAKE_MODE=correct MTPLX_URL="http://127.0.0.1:$PORT" \
    "$B/campagne.sh" 2 bug > "$resultat/stdout" 2> "$resultat/stderr"
  rc=$?
  python3 - "$resultat" "$rc" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifests = sorted(root.glob("*/manifeste.json"))
if len(manifests) != 4:
    raise SystemExit(f"quatre manifestes de campagne attendus, trouvé {len(manifests)}")
data = [json.loads(path.read_text(encoding="utf-8")) for path in manifests]
if {entry["status"] for entry in data} != {"succes"}:
    raise SystemExit("statut de campagne inattendu")
campaign_ids = {entry["run"]["campaign_id"] for entry in data}
if len(campaign_ids) != 1 or None in campaign_ids:
    raise SystemExit("identifiant de campagne non apparié")
pairs = {(entry["run"]["repeat_index"], entry["run"]["condition"]) for entry in data}
if pairs != {(1, "avec"), (1, "sans"), (2, "avec"), (2, "sans")}:
    raise SystemExit("répétitions ou conditions non conservées")
if sys.argv[2] != "0":
    raise SystemExit(f"code de campagne {sys.argv[2]} au lieu de 0")
PY
  [ "$?" -eq 0 ] || return 1
}

jouer correct succes true 0 || exit 1
jouer violation_perimetre echec_test false 1 || exit 1
jouer timeout blocage_harnais true 4 1 || exit 1
jouer_campagne || exit 1
echo "PASS: statuts, timeout et répétitions appariées détectés sans modèle"
