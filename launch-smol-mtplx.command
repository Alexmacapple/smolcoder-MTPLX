#!/bin/zsh
# Smolcoder avec Qwen 3.8 27B servi localement par MTPLX.
#
# Smolcoder (npm, binaire smol) est un agent de code local qui détecte les
# serveurs de modèles. MTPLX sert une API compatible OpenAI sur
# 127.0.0.1:8000/v1 : smolcoder le reconnaît comme un backend du type
# LM Studio (fallback compatible OpenAI). La config ~/.smolcoder.json
# déclare le host "mtplx" ; sans elle, smolcoder ne le trouve pas.
#
# Branchement nécessaire : un patch lu dans /v1/models permet à
# smolcoder de lire context_length (262 144) au lieu d'estimer 4 096.
# Ce patch vit dans le fork https://github.com/Alexmacapple/smolcoder-MTPLX
# (installé ici par npm link depuis le clone ~/smolcoder).
#
# Usage :
#   launch-smol-mtplx.command                     interface web (défaut ; charge
#                                                 le démon LaunchAgent si besoin)
#   launch-smol-mtplx.command <dossier>           interface web ouverte sur <dossier>
#   launch-smol-mtplx.command --session [dossier] terminal interactif (racine du
#                                                 fork si aucun dossier donné)
#   launch-smol-mtplx.command --test              une requête headless de contrôle
#
# La clé d'accès (?k=...) de l'interface web change à chaque démarrage du
# démon (KeepAlive le relance après un crash) : celle lisible dans
# ~/.smolcoder-web.log peut être périmée (403). On demande donc une URL
# fraîche au démon avec « smol --web », qui s'attache au serveur en marche,
# imprime l'URL et se termine tout seul.
#
# Modes de permissions : shift+tab alterne ro / edit / bypass.
# Effort de raisonnement : /effort (off, low, medium, high, default).
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

FORK_ROOT="$HOME/smolcoder"

usage() {
  echo "Usage : launch-smol-mtplx.command [--session|--test|--web] [dossier]" >&2
  exit 2
}

MODE="web"
case "${1:-}" in
  --web)                shift ;;
  --session|--terminal) MODE="session"; shift ;;
  --test)               MODE="test"; shift ;;
  -*)                   echo "Erreur: option inconnue : $1" >&2; usage ;;
esac
WORKSPACE=""
if [ $# -gt 0 ]; then
  if [ -d "$1" ]; then
    WORKSPACE="$(cd "$1" && pwd)"
    shift
  else
    echo "Erreur: dossier introuvable : $1" >&2
    usage
  fi
fi
if [ $# -gt 0 ]; then
  echo "Erreur: argument non reconnu : $1" >&2
  usage
fi

# Timeout qui termine proprement tout le groupe de processus : TERM d'abord
# (node exécute son nettoyage), KILL cinq secondes plus tard si besoin.
avec_timeout() {
  perl -e '
    my $t = shift @ARGV;
    my $p = fork // die "fork: $!";
    if (!$p) { setpgrp(0, 0); exec @ARGV or die "exec: $!" }
    local $SIG{ALRM} = sub { kill "TERM", -$p; sleep 5; kill "KILL", -$p };
    alarm $t;
    waitpid $p, 0;
    exit(($? >> 8) || (($? & 127) ? 128 + ($? & 127) : 0));
  ' "$@"
}

SMOL="$(command -v smol || true)"
if [ -z "$SMOL" ] || [ ! -x "$SMOL" ]; then
  echo "Erreur: smol introuvable. Installe-le avec :" >&2
  echo "  npm install -g git+https://github.com/Alexmacapple/smolcoder-MTPLX.git" >&2
  exit 1
fi
MTPLX_URL="${MTPLX_URL:-http://127.0.0.1:8000}"
MODEL="${MTPLX_MODEL:-mtplx-qwen38-27b-optimized-speed-fp16}"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.alex.smolcoder-web.plist"
WEB_BASE="http://127.0.0.1:${SMOL_WEB_PORT:-7433}"

mtplx_ok() {
  # Réponse capturée (pas de pipe sous pipefail) et identifiant JSON exact.
  local rep
  rep="$(curl -s -m 3 "$MTPLX_URL/v1/models" 2>/dev/null)" || return 1
  print -r -- "$rep" | grep -qF "\"$MODEL\""
}

web_ui_up() {
  # Toute réponse HTTP (même 403 sans clé) prouve que le serveur web vit.
  curl -s -m 2 -o /dev/null "$WEB_BASE/"
}

if ! mtplx_ok; then
  if [ ! -d /Applications/MTPLX.app ]; then
    echo "Erreur: $MODEL non servi sur $MTPLX_URL et /Applications/MTPLX.app introuvable." >&2
    exit 1
  fi
  echo "Serveur MTPLX absent : ouverture de l'application MTPLX, qui le démarre..."
  open -a /Applications/MTPLX.app 2>/dev/null || true
  deadline=$(( SECONDS + 180 ))
  while [ $SECONDS -lt $deadline ]; do
    mtplx_ok && break
    sleep 2
  done
  if ! mtplx_ok; then
    echo "Erreur: MTPLX ne sert pas $MODEL sur $MTPLX_URL après 3 minutes." >&2
    exit 1
  fi
fi

# Host MTPLX déclaré pour smolcoder : fusion dans la config existante,
# sans perdre lastModel, lastMode, effort ni les autres hôtes (idempotent).
python3 - "$HOME/.smolcoder.json" "$MTPLX_URL" <<'PY'
import json, os, sys
cfg_path, url = sys.argv[1], sys.argv[2]
cfg = {}
if os.path.exists(cfg_path):
    try:
        with open(cfg_path) as f:
            cfg = json.load(f)
    except Exception:
        os.replace(cfg_path, cfg_path + ".bak.invalide")
        print(f"Config illisible sauvegardée : {cfg_path}.bak.invalide")
        cfg = {}
hosts = [h for h in cfg.get("hosts", []) if isinstance(h, dict)]
if not any(h.get("address") == url for h in hosts):
    hosts.append({"address": url, "name": "mtplx"})
    cfg["hosts"] = hosts
    with open(cfg_path, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"Config smolcoder : host mtplx -> {url} (fusionné)")
PY

case "$MODE" in
  test)
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/smol-test.XXXXXX")"
    trap 'rm -rf "$tmp"' EXIT
    echo "Test headless vers $MODEL (dossier $tmp, limite 300 s)..."
    start=$(date +%s)
    set +e
    (cd "$tmp" && avec_timeout 300 "$SMOL" -p "Réponds seulement : ok" </dev/null) | tail -5
    rc=${pipestatus[1]:-1}
    set -e
    echo "Code $rc, durée $(( $(date +%s) - start )) s."
    [ $rc -eq 0 ]
    ;;
  web)
    if ! web_ui_up && [ -f "$LAUNCH_AGENT" ]; then
      echo "Démon web absent : chargement du LaunchAgent..."
      # bootstrap (moderne) ; kickstart si déjà chargé mais arrêté ; load en dernier recours.
      launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT" 2>/dev/null \
        || launchctl kickstart "gui/$(id -u)/com.alex.smolcoder-web" 2>/dev/null \
        || launchctl load "$LAUNCH_AGENT" 2>/dev/null || true
      deadline=$(( SECONDS + 30 ))
      while [ $SECONDS -lt $deadline ]; do
        web_ui_up && break
        sleep 1
      done
    fi
    ATTACH_DIR="${WORKSPACE:-$PWD}"
    # Double-clic Finder : cwd = $HOME ; ne pas enrôler tout le home dans l'UI.
    if [ -z "$WORKSPACE" ] && [ "$ATTACH_DIR" = "$HOME" ]; then
      ATTACH_DIR="$FORK_ROOT"
    fi
    if ! web_ui_up; then
      echo "Pas de démon web ($LAUNCH_AGENT absent ou muet) :"
      echo "serveur lancé dans ce terminal — le fermer arrête l'interface."
      cd "$ATTACH_DIR"
      exec "$SMOL" --web ${SMOL_WEB_PORT:+"$SMOL_WEB_PORT"}
    fi
    # Raccorde ATTACH_DIR à l'interface en cours et récupère une URL fraîche
    # (celle du log peut dater d'un démon précédent : elle renverrait 403).
    out="$(cd "$ATTACH_DIR" && avec_timeout 30 "$SMOL" --web </dev/null 2>&1 || true)"
    url="$(print -r -- "$out" | grep -Eo 'http://127\.0\.0\.1:[0-9]+/\?k=[^[:space:]]*' | tail -1 || true)"
    if [ -z "$url" ]; then
      echo "Erreur: pas d'URL d'interface (?k=) retournée par smol --web. Sortie :" >&2
      print -r -- "$out" >&2
      exit 1
    fi
    echo "Interface web ($ATTACH_DIR) : $url"
    if [ -f "$LAUNCH_AGENT" ]; then
      echo "Arrêt définitif du démon : launchctl bootout gui/$(id -u) $LAUNCH_AGENT"
    fi
    open "$url"
    ;;
  session)
    WORKSPACE="${WORKSPACE:-$FORK_ROOT}"
    cd "$WORKSPACE"
    clear || true
    echo "Smolcoder avec Qwen 3.8 27B (MTPLX local)"
    echo "Dossier : $WORKSPACE"
    echo "Modèle : $MODEL ; effort par défaut ; alterner le mode avec shift+tab."
    echo "Quitter : ctrl+c deux fois."
    echo
    exec "$SMOL" -m edit
    ;;
esac
