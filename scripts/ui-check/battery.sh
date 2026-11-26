#!/bin/bash
# Average CPU of the Harv app, its web process and the server, and the GPU busy %, over the same 10 s.
# Usage (on the Linux laptop, Harv app open): bash scripts/ui-check/battery.sh <label>
export PATH=$HOME/.local/opt/node/bin:$PATH
app=$(pgrep -f "release/harv$" | head -1)
web=$(pgrep -f WebKitWebProcess | head -1)
srv=$(pgrep -f "tsx.*src/index.ts|node.*src/index.ts" | tail -1)
samples=$(mktemp)
# One GPU reading a second while top measures the CPU.
(for i in $(seq 1 10); do cat /sys/class/drm/card*/device/gpu_busy_percent 2>/dev/null | head -1; sleep 1; done >"$samples") &
GP=$!
cpu=$(top -b -n 2 -d 10 -p "$(echo "$app,$web,$srv" | sed 's/,,*/,/g; s/^,//; s/,$//')" | awk '/^top -/{n++} n==2 && $1 ~ /^[0-9]+$/ {printf "%s=%s ", $12, $9}')
wait $GP
n=$(grep -c . "$samples")
gpu=$(( n ? ($(paste -sd+ "$samples")) / n : 0 ))
rm -f "$samples"
echo "$1: $cpu gpu~${gpu}%"
