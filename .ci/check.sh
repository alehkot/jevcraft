#!/usr/bin/env bash
# The Woodpecker check (.woodpecker/). Offline only: most scripts/*-test.js log in to a
# Minecraft server to try the bot in a world, and a self-hosted worker may run a server of its
# own on the same machine. CI never runs those. Nor the routing and memory suites, which ask the
# live decision model and need a TypeSafe key. It runs the suites named below, which need no
# server, no model and no network, and a syntax check of every script. A connection opened by
# mistake is aimed at a closed local port, and the step has no keys.
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'printf "CI check failed at line %s\n" "$LINENO" >&2' ERR

# Low priority, so a build does not crowd whatever else the worker machine runs.
if command -v ionice >/dev/null 2>&1 && ionice -c 3 true 2>/dev/null; then
  low() { nice -n 19 ionice -c 3 "$@"; }
else
  low() { nice -n 19 "$@"; }
fi

export MC_HOST=127.0.0.1 MC_PORT=1
unset TYPESAFE_API_KEY OPENROUTER_API_KEY JEV_GUIDE_API_KEY OPENAI_API_KEY

printf 'node %s, npm %s, %s\n' "$(node --version)" "$(npm --version)" "$(uname -sm)"
node scripts/check-node.js
low npm ci --ignore-scripts --no-audit --no-fund

echo "== syntax of every tracked script"
bash -n scripts/pi-paper/window.sh
bash -n paper/locations/build.sh
git ls-files -z -- '*.js' '*.cjs' | low xargs -0 -n 1 node --check
echo "$(git ls-files -- '*.js' '*.cjs' | wc -l | tr -d ' ') files parse"

OFFLINE_SUITES=(
  scripts/company-test.js
  scripts/built-test.js
  scripts/world-clock-test.js
  test/pocket-hold.test.js
  test/build-beds.test.js
  test/starter-house.test.js
  test/house-planner.test.js
  test/pi-paper-window.test.js
  test/home-location.test.js
  test/boats-ladders-light.test.js
  test/companion-location.test.js
  test/footing.test.js
  test/shot-epoch.test.js
  test/workstation-ring.test.js
  test/own-buildings.test.js
  test/perception.test.js
  test/voice.test.js
  test/furnishings.test.js
  test/guard.test.js
  test/agenda.test.js
  test/build-around.test.js
  test/night-light.test.js
  test/held-choices.test.js
  test/wait-ground.test.js
  test/stay-close.test.js
  test/keep-armed.test.js
  test/first-tools.test.js
  test/guide-talk.test.js
  test/table-afresh.test.js
  test/craft-clicks.test.js
  test/any-material.test.js
  test/add-room.test.js
  test/player-build.test.js
  test/open-ring.test.js
  test/labels.test.js
  test/kept-walls.test.js
  test/house-refuge.test.js
  test/delivery-recipient.test.js
  test/tree-felling.test.js
  test/chores.test.js
)
for suite in "${OFFLINE_SUITES[@]}"; do
  echo "== $suite"
  low node "$suite"
done
echo "all offline checks passed"
