#!/usr/bin/env bash
# start_all.sh — Launch all RSS monitors in the background.
# Usage: ./start_all.sh [stop]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOURCES=(nyt bbc wsj guardian npr aljazeera)

if [[ "${1:-}" == "stop" ]]; then
  for src in "${SOURCES[@]}"; do
    pid_file="$SCRIPT_DIR/.cache_${src}/monitor.pid"
    if [[ -f "$pid_file" ]]; then
      pid=$(cat "$pid_file")
      kill "$pid" 2>/dev/null && echo "Stopped $src (PID $pid)" || echo "$src not running"
      rm -f "$pid_file"
    else
      echo "$src: no PID file"
    fi
  done
  exit 0
fi

for src in "${SOURCES[@]}"; do
  conf="$SCRIPT_DIR/sources/${src}.conf"
  cache_dir="$SCRIPT_DIR/.cache_${src}"
  mkdir -p "$cache_dir"

  # Skip if already running
  pid_file="$cache_dir/monitor.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "$src: already running (PID $(cat "$pid_file"))"
    continue
  fi

  nohup bash "$SCRIPT_DIR/monitor.sh" "$conf" "$SCRIPT_DIR/${src}_changes.log" > /dev/null 2>&1 &
  echo "$!" > "$pid_file"
  echo "$src: started (PID $!)"
done

echo ""
echo "All monitors launched. Logs: *_changes.log"
echo "Stop all: $0 stop"
