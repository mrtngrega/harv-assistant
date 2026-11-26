#!/usr/bin/env bash
# Start, stop or restart Harv (the server and the dashboard) on Linux, safely.
# The Linux twin of scripts/harv.ps1.
#
#   scripts/harv.sh start       # or: stop, restart
#   scripts/harv.sh restart --delay 2
#
#   start    Starts Harv in the background if it isn't running (no auto-restart, so Harv can edit
#            its own code). It opens the dashboard in the browser only with --browser (the user
#            uses the app); --no-browser is still accepted.
#   stop     Asks Harv to shut down cleanly (saves terminals, closes the database),
#            then ends whatever is left on its ports. Never touches other programs.
#   restart  stop, then start.
#
# Logs go to ~/.harv/logs/harv.log.

set -u
action="${1:-start}"
shift || true
delay=0
browser=0
while [ $# -gt 0 ]; do
  case "$1" in
    --delay) delay="${2:-0}"; shift ;;
    --browser) browser=1 ;;
    --no-browser) browser=0 ;;
  esac
  shift
done

repo="$(cd "$(dirname "$0")/.." && pwd)"
harv_home="${HARV_HOME:-$HOME/.harv}"
logs="$harv_home/logs"
pid_file="$harv_home/harv.pid"
dashboard='http://127.0.0.1:4316'
server='http://127.0.0.1:4317'
mkdir -p "$logs"
# Node and Claude Code installed per user (~/.local) aren't on the PATH of a desktop shortcut.
export PATH="$HOME/.local/opt/node/bin:$HOME/.local/bin:$PATH"

log() { echo "$(date +%Y-%m-%dT%H:%M:%S) [$$] $*" >> "$logs/harv-script.log"; }

# PIDs listening on the given ports (ss is part of iproute, on every Fedora).
port_pids() {
  local filter=""
  for port in "$@"; do filter="$filter${filter:+ or }sport = :$port"; done
  ss -ltnpH "( $filter )" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

up() { curl -fsS -m 2 -H "Origin: $dashboard" -o /dev/null "$1" 2>/dev/null; }

# Harv's own processes only (the full review, D21): an old harv.pid can name another program by
# now, and another project's dev server can sit on a port while Harv is down. Harv's are npm running
# "harv" and anything working in, or started from, this repo.
is_harv() {
  local pid="$1" cmd cwd
  [ -r "/proc/$pid/cmdline" ] || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
  case "$cmd" in *"npm run harv"*|*"$repo/"*) return 0 ;; esac
  case "$cwd/" in "$repo/"*) return 0 ;; esac
  return 1
}

# A process and everything it started (Harv's only).
stop_tree() {
  local pid="$1" child
  if ! is_harv "$pid"; then
    [ -d "/proc/$pid" ] && log "left process $pid ($(cat "/proc/$pid/comm" 2>/dev/null)) alone: it isn't Harv's"
    return
  fi
  for child in $(pgrep -P "$pid" 2>/dev/null); do stop_tree "$child"; done
  kill "$pid" 2>/dev/null
}

stop_harv() {
  # A clean shutdown first: Harv saves terminals and layout and closes its database.
  if [ -n "$(port_pids 4317)" ]; then
    curl -fsS -m 5 -X POST -H "Origin: $dashboard" -H 'Content-Type: application/json' -d '{}' "$server/api/shutdown" >/dev/null 2>&1
    for _ in $(seq 24); do [ -z "$(port_pids 4317)" ] && break; sleep 0.25; done
  fi
  # Then whatever is left: the process tree this script started, and anything still on Harv's ports.
  if [ -f "$pid_file" ]; then
    old="$(cat "$pid_file")"
    [ -n "$old" ] && stop_tree "$old"
    rm -f "$pid_file"
  fi
  for p in $(port_pids 4317 4316); do stop_tree "$p"; done
  for _ in $(seq 20); do [ -z "$(port_pids 4317 4316)" ] && break; sleep 0.25; done
}

open_dashboard() { [ "$browser" = 1 ] && (xdg-open "$dashboard" >/dev/null 2>&1 &); }

start_harv() {
  if up "$server/api/health" && up "$dashboard"; then
    open_dashboard
    echo 'Harv is already running.'
    return 0
  fi
  # Half running (or a stuck old process on the ports): clear it first.
  [ -n "$(port_pids 4317 4316)" ] && stop_harv

  local out="$logs/harv.log"
  [ -f "$out" ] && mv -f "$out" "$logs/harv.previous.log"
  # The whole group is redirected and becomes npm (exec), so nothing keeps this terminal's
  # (or an SSH session's) output open, and the pid file holds npm itself.
  (cd "$repo" && exec setsid npm run harv) > "$out" 2>&1 < /dev/null &
  echo $! > "$pid_file"

  for _ in $(seq 180); do
    if up "$server/api/health" && up "$dashboard"; then
      open_dashboard
      echo 'Harv is running.'
      return 0
    fi
    kill -0 "$(cat "$pid_file")" 2>/dev/null || break
    sleep 0.5
  done
  echo "Harv didn't start. See $out"
  return 1
}

log "$action (delay $delay)"
[ "$delay" -gt 0 ] && sleep "$delay"
case "$action" in
  start) start_harv || { log 'start failed'; exit 1; } ;;
  stop) stop_harv; echo 'Harv is stopped.' ;;
  restart) stop_harv; log 'stopped, starting'; start_harv || { log 'start failed'; exit 1; } ;;
  *) echo "Usage: $0 start|stop|restart [--delay N] [--browser]"; exit 2 ;;
esac
log "$action done"
