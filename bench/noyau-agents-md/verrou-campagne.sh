#!/bin/bash
# Fonctions partagées par un essai isolé et par une campagne complète.
RECUPERATION_DIR=""

lire_pid_verrou() {
  sed -n '1p' "$LOCK_FILE" 2>/dev/null || true
}

pid_verrou_vivant() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$1" 2>/dev/null
}

prendre_verrou() {
  local pid
  local proprietaire_herite
  local recuperation
  local pid_recuperation
  proprietaire_herite="$(printenv BANC_LOCK_OWNER_PID 2>/dev/null || true)"
  if [ -n "$proprietaire_herite" ]; then
    pid="$(lire_pid_verrou)"
    if [ "$pid" = "$proprietaire_herite" ] && [ "$PPID" = "$proprietaire_herite" ] && pid_verrou_vivant "$pid"; then
      return 0
    fi
    LOCK_REASON="Verrou de campagne hérité invalide (PID attendu : $proprietaire_herite)"
    return 1
  fi

  if [ -e "$LOCK_FILE" ]; then
    pid="$(lire_pid_verrou)"
    if pid_verrou_vivant "$pid"; then
      LOCK_REASON="Une campagne est déjà active (PID $pid)"
      return 1
    fi
    recuperation="$LOCK_FILE.recuperation"
    if ! mkdir "$recuperation" 2>/dev/null; then
      pid_recuperation="$(sed -n '1p' "$recuperation/pid" 2>/dev/null || true)"
      if ! pid_verrou_vivant "$pid_recuperation"; then
        rm -f "$recuperation/pid" 2>/dev/null
        if rmdir "$recuperation" 2>/dev/null; then
          prendre_verrou
          return $?
        fi
      fi
      LOCK_REASON="Récupération d’un verrou périmé déjà en cours"
      return 1
    fi
    RECUPERATION_DIR="$recuperation"
    printf '%s\n' "$$" > "$recuperation/pid" || {
      rmdir "$recuperation"
      RECUPERATION_DIR=""
      LOCK_REASON="PID de récupération impossible à écrire"
      return 1
    }
    pid="$(lire_pid_verrou)"
    if pid_verrou_vivant "$pid"; then
      rm -f "$recuperation/pid"
      rmdir "$recuperation"
      RECUPERATION_DIR=""
      LOCK_REASON="Une campagne est déjà active (PID $pid)"
      return 1
    fi
    rm -f "$LOCK_FILE" || {
      rm -f "$recuperation/pid"
      rmdir "$recuperation"
      RECUPERATION_DIR=""
      LOCK_REASON="Verrou obsolète impossible à libérer : $LOCK_FILE"
      return 1
    }
    rm -f "$recuperation/pid"
    rmdir "$recuperation" || {
      RECUPERATION_DIR=""
      LOCK_REASON="Récupération du verrou impossible à terminer"
      return 1
    }
    RECUPERATION_DIR=""
  fi

  if (set -C; printf '%s\n' "$$" > "$LOCK_FILE") 2>/dev/null; then
    LOCK_OWNED=1
    return 0
  fi
  pid="$(lire_pid_verrou)"
  [ -n "$pid" ] || pid=inconnu
  LOCK_REASON="Verrou de campagne pris pendant le démarrage (PID $pid)"
  return 1
}

liberer_verrou() {
  local pid
  if [ -n "$RECUPERATION_DIR" ]; then
    rm -f "$RECUPERATION_DIR/pid" 2>/dev/null
    rmdir "$RECUPERATION_DIR" 2>/dev/null
    RECUPERATION_DIR=""
  fi
  [ "$LOCK_OWNED" -eq 1 ] || return 0
  pid="$(lire_pid_verrou)"
  [ "$pid" = "$$" ] && rm -f "$LOCK_FILE"
  LOCK_OWNED=0
}
