#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --help ]]; then
  echo 'Usage: window.sh [--check | fittings | craft | furnished | fresh | resume | ladder | landmarks | lighting | boat | home] ...'
  echo 'The default runs fittings, door crafting, a furnished house, ladder travel, landmark placement, lighting, a boat crossing and home/respawn.'
  exit 0
fi
scripts=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$scripts/../.." && pwd)
export TESTCOPY=${JEV_REVIEW_DIR:-"$HOME/jevcraft-paper-review"}
export JEV_REVIEW_BASE
JEV_REVIEW_BASE=$(realpath "$TESTCOPY")
TESTCOPY=$JEV_REVIEW_BASE
paper=${JEV_LIVE_PAPER:-"$HOME/minecraft"}
guard="$paper/tools/testcopy"
node=${JEV_NODE:-"$HOME/.local/bin/node"}
envfile=${JEV_REVIEW_ENV:-"$HOME/jevcraft/.env"}
export JEV_REVIEW_RUN="$TESTCOPY/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$"
check=0
if [[ ${1:-} == --check ]]; then check=1; shift; fi
if (($#==0)); then set -- fittings craft furnished ladder landmarks lighting boat home; fi
for scene in "$@"; do
  case "$scene" in fittings|craft|furnished|fresh|resume|ladder|landmarks|lighting|boat|home) ;; *) echo "Unknown scene $scene" >&2; exit 2;; esac
done
regular=()
separate=()
for scene in "$@"; do
  case "$scene" in home|resume) separate+=("$scene");; *) regular+=("$scene");; esac
done
if [[ " ${separate[*]} " == *' resume '* && " ${regular[*]} " == *' fresh '* ]]; then echo 'Choose fresh or resume in one run.'; exit 2; fi
mode=regular
if [[ " ${regular[*]} " == *' fresh '* ]]; then mode=fresh; fi
if [[ " ${separate[*]} " == *' resume '* ]]; then mode=resume; fi
if (( !check && $# > 1 )) && [[ $mode != regular ]]; then
  others=()
  for scene in "$@"; do [[ $scene == "$mode" ]] || others+=("$scene"); done
  if (( ${#others[@]} )); then "$scripts/window.sh" "${others[@]}"; fi
  exec "$scripts/window.sh" "$mode"
fi
for f in "$guard/nw.sh" "$guard/window.sh" "$guard/doorknock.py" "$TESTCOPY/newworld/paper.jar" "$envfile"; do test -r "$f" || { echo "Missing $f" >&2; exit 2; }; done
[[ "$(realpath "$TESTCOPY/newworld")" != "$(realpath "$paper")" && "$(realpath "$TESTCOPY/newworld/world")" != "$(realpath "$paper/world")" ]]
if ((check)); then export JEV_REVIEW_VALIDATE_ONLY=1; fi
"$node" "$scripts/fixture.cjs"
if ((check)); then echo "Private fixture and reviewer ready at $TESTCOPY"; exit 0; fi
# All fixture directories and worktrees operate the same system services.
exec 9>>/tmp/jevcraft-minecraft-paper-window.lock
flock -n 9 || { echo 'Another private window is active.' >&2; exit 2; }
TESTCOPY=$(JEV_REVIEW_PREPARE="$mode" "$node" "$scripts/fixture.cjs")
"$node" "$scripts/fixture.cjs"
cd "$TESTCOPY"
exec > >(tee -a "$JEV_REVIEW_RUN/window.log") 2>&1
minutes=${JEV_REVIEW_MINUTES:-15}
[[ $minutes =~ ^([1-9]|1[0-9]|20)$ ]]
echo "Results in $JEV_REVIEW_RUN"
live_empty() {
  "$node" -e 'require(require("node:module").createRequire(process.argv[1]).resolve("minecraft-protocol")).ping({host:"127.0.0.1",port:25565,closeTimeout:4000},(err,r)=>{const n=r?.players?.online;console.log("Live users online:",n);process.exit(err||!Number.isInteger(n)?2:n?3:0)})' "$repo/package.json"
}
live_empty
watcher=0
stopped=0
guardian=
restore() {
  local result=$?
  trap - EXIT INT TERM
  if [[ -n "$guardian" ]]; then touch "$TESTCOPY/window.end"; wait "$guardian" || true; fi
  if ((stopped)) && ! systemctl is-active --quiet minecraft; then
    "$guard/nw.sh" stop || true
    sudo -n systemctl start minecraft
  fi
  if ((watcher)); then sudo -n systemctl start mc-companion-watch; fi
  exit "$result"
}
trap restore EXIT
trap 'exit 130' INT TERM
sudo -n systemctl stop mc-companion-watch
watcher=1
live_empty
if systemctl is-active --quiet jevcraft; then echo 'The live bot is active. Ending the review.'; exit 3; fi
stopped=1
sudo -n systemctl stop minecraft
: > doorknock.log
"$guard/window.sh" "$minutes" >"$JEV_REVIEW_RUN/guard.log" 2>&1 &
guardian=$!
for _ in {1..50}; do if grep -q '^listening on' doorknock.log; then break; fi; sleep .1; done
grep -q '^listening on' doorknock.log
"$guard/nw.sh" start 9>&-
"$guard/nw.sh" wait 150
run_client() {
  kill -0 "$guardian"
  [[ ! -e "$TESTCOPY/window.end" ]]
  env MC_PORT=25575 MC_HOST=127.0.0.1 MC_WORLD_ID=private-paper-review JEV_IDLE=wait JEV_NO_QUIET_RESTART=1 JEV_FLIGHT=0 "$node" --env-file="$envfile" "$@"
}
if [[ " ${separate[*]} " == *' resume '* ]]; then run_client "$scripts/resume.cjs" >"$JEV_REVIEW_RUN/resume-console.log" 2>&1; fi
if ((${#regular[@]})); then run_client "$scripts/scenes.cjs" "${regular[@]}" >"$JEV_REVIEW_RUN/scenes.log" 2>&1; fi
if [[ " ${regular[*]} " == *' lighting '* ]]; then run_client "$scripts/lighting.cjs" >"$JEV_REVIEW_RUN/lighting.log" 2>&1; fi
if [[ " ${separate[*]} " == *' home '* ]]; then run_client "$scripts/home.cjs" >"$JEV_REVIEW_RUN/home-console.log" 2>&1; fi
echo 'Requested private Paper checks passed.'
