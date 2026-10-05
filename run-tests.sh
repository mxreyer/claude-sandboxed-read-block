#!/usr/bin/env bash
# Runs test-prompt.txt headless three times and pushes the results:
#   baseline        no mod
#   with-mod-ask    the mod with its default verdict (ask)
#   with-mod-allow  a temporary copy of the mod whose default verdict is allow
# The repo's own copy of the mod is never edited.
#
# Usage: ./run-tests.sh [--no-push]
set -euo pipefail

BRANCH=claude/focused-feynman-t9yicz
PUSH=1
[[ "${1:-}" == "--no-push" ]] && PUSH=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

if [[ -n "$(git status --porcelain -- sandboxed-read-block test-prompt.txt)" ]]; then
  echo "sandboxed-read-block/ or test-prompt.txt has local changes; commit or revert them first." >&2
  exit 1
fi

if [[ $PUSH -eq 1 ]]; then
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
fi

PROMPT="$(cat "$REPO/test-prompt.txt")"
OUT="$REPO/results"
mkdir -p "$OUT"

# The allow copy lives outside the repo and is removed on exit.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$REPO/sandboxed-read-block" "$WORK/sandboxed-read-block"
rm -rf "$WORK/sandboxed-read-block/.claude-plugin/types"
MANIFEST="$WORK/sandboxed-read-block/.claude-plugin/plugin.json"
awk '{ sub(/"default": "ask"/, "\"default\": \"allow\"") } 1' "$MANIFEST" > "$MANIFEST.new"
mv "$MANIFEST.new" "$MANIFEST"
if ! grep -q '"default": "allow"' "$MANIFEST"; then
  echo "could not switch the copy's verdict to allow; check $MANIFEST" >&2
  exit 1
fi

{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "claude: $(claude --version)"
  echo "os: $(uname -sr)"
} > "$OUT/env.txt"

run() {
  local name=$1
  shift
  echo "== $name"
  if ! claude -p "$PROMPT" "$@" > "$OUT/$name.txt" 2> "$OUT/$name.stderr.txt"; then
    echo "   claude exited non-zero; see results/$name.stderr.txt"
  fi
}

run baseline
run with-mod-ask --plugin-dir "$REPO/sandboxed-read-block"
run with-mod-allow --plugin-dir "$WORK/sandboxed-read-block"

if [[ $PUSH -eq 0 ]]; then
  echo "Results are in $OUT (not pushed)."
  exit 0
fi

git add results
git commit -m "Test results $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push origin "$BRANCH"
echo "Pushed results to $BRANCH."
