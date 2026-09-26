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

MODE="web"
case "${1:-}" in
  --web)                shift ;;
  --session|--terminal) MODE="session"; shift ;;
  --test)               MODE="test"; shift ;;
esac
WORKSPACE=""
if [ -n "${1:-}" ] && [ -d "$1" ]; then
  WORKSPACE="$(cd "$1" && pwd)"
  shift
fi

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
  curl -s -m 3 "$MTPLX_URL/v1/models" 2>/dev/null | grep -q "$MODEL"
}

web_ui_up() {
  # Toute réponse HTTP (même 403 sans clé) prouve que le serveur web vit.
  curl -s -m 2 -o /dev/null "$WEB_BASE/"
}

if ! mtplx_ok; then
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

# Host MTPLX déclaré pour smolcoder (idempotent).
if [ ! -f "$HOME/.smolcoder.json" ] || ! grep -q "8000" "$HOME/.smolcoder.json" 2>/dev/null; then
  [ -f "$HOME/.smolcoder.json" ] && cp "$HOME/.smolcoder.json" "$HOME/.smolcoder.json.bak.$(date +%s)"
  cat > "$HOME/.smolcoder.json" <<JSON
{
  "hosts": [
    { "address": "$MTPLX_URL", "name": "mtplx" }
  ]
}
JSON
  echo "Config smolcoder créée : host mtplx -> $MTPLX_URL"
fi

case "$MODE" in
  test)
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/smol-test.XXXXXX")"
    echo "Test headless vers $MODEL (dossier $tmp)..."
    start=$(date +%s)
    set +e
    (cd "$tmp" && "$SMOL" -p "Réponds seulement : ok" </dev/null) | tail -5
    rc=${pipestatus[1]:-1}
    set -e
    echo "Code $rc, durée $(( $(date +%s) - start )) s."
    rm -rf "$tmp"
    [ $rc -eq 0 ]
    ;;
  web)
    if ! web_ui_up && [ -f "$LAUNCH_AGENT" ]; then
      echo "Démon web absent : chargement du LaunchAgent..."
      launchctl load "$LAUNCH_AGENT" 2>/dev/null || true
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
      exec "$SMOL" --web
    fi
    # Raccorde ATTACH_DIR à l'interface en cours et récupère une URL fraîche
    # (celle du log peut dater d'un démon précédent : elle renverrait 403).
    out="$(cd "$ATTACH_DIR" && "$SMOL" --web </dev/null 2>&1 || true)"
    url="$(print -r -- "$out" | grep -o 'http://[^[:space:]]*' | tail -1 || true)"
    if [ -z "$url" ]; then
      echo "Erreur: pas d'URL retournée par smol --web. Sortie :" >&2
      print -r -- "$out" >&2
      exit 1
    fi
    echo "Interface web ($ATTACH_DIR) : $url"
    echo "Arrêt définitif du démon : launchctl unload $LAUNCH_AGENT"
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
    exec "$SMOL" -m edit "$@"
    ;;
esac
