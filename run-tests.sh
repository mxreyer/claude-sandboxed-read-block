#!/usr/bin/env bash
# Runs a test prompt headless three times and pushes the results to
# results/<prompt name>/:
#   baseline        no mod
#   with-mod-allow  the mod with its default verdict (allow)
#   with-mod-ask    a temporary copy of the mod whose default verdict is ask
# The repo's own copy of the mod is never edited.
#
# Usage: ./run-tests.sh [--no-push] [prompt file, default test-prompt.txt]
set -euo pipefail

BRANCH=claude/focused-feynman-t9yicz
PUSH=1
PROMPT_FILE=test-prompt.txt
for arg in "$@"; do
  if [[ "$arg" == "--no-push" ]]; then PUSH=0; else PROMPT_FILE="$arg"; fi
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "no such prompt file: $PROMPT_FILE" >&2
  exit 1
fi

# An installed copy of the mod loads in every run and shadows the copies
# under test, so the baseline would not be a baseline.
if [[ -n "${CLAUDE_CODE_PLUGIN_DIRS:-}" ]] || grep -q CLAUDE_CODE_PLUGIN_DIRS "$HOME/.claude/settings.json" 2>/dev/null; then
  echo "CLAUDE_CODE_PLUGIN_DIRS is set (environment or ~/.claude/settings.json)." >&2
  echo "Remove it while testing so no installed copy of the mod loads, then restore it." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain -- sandboxed-read-block "$PROMPT_FILE")" ]]; then
  echo "sandboxed-read-block/ or $PROMPT_FILE has local changes; commit or revert them first." >&2
  exit 1
fi

if [[ $PUSH -eq 1 ]]; then
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
fi

PROMPT="$(cat "$PROMPT_FILE")"
NAME="$(basename "$PROMPT_FILE" .txt)"
OUT="$REPO/results/$NAME"
mkdir -p "$OUT"

# The ask copy lives outside the repo and is removed on exit.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$REPO/sandboxed-read-block" "$WORK/sandboxed-read-block"
rm -rf "$WORK/sandboxed-read-block/.claude-plugin/types"
MANIFEST="$WORK/sandboxed-read-block/.claude-plugin/plugin.json"
awk '{ sub(/"default": "allow"/, "\"default\": \"ask\"") } 1' "$MANIFEST" > "$MANIFEST.new"
mv "$MANIFEST.new" "$MANIFEST"
if ! grep -q '"default": "ask"' "$MANIFEST"; then
  echo "could not switch the copy's verdict to ask; check $MANIFEST" >&2
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
    echo "   claude exited non-zero; see results/$NAME/$name.stderr.txt"
  fi
}

run baseline
run with-mod-allow --plugin-dir "$REPO/sandboxed-read-block"
run with-mod-ask --plugin-dir "$WORK/sandboxed-read-block"

if [[ $PUSH -eq 0 ]]; then
  echo "Results are in $OUT (not pushed)."
  exit 0
fi

git add results
git commit -m "Test results ($NAME) $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push origin "$BRANCH"
echo "Pushed results to $BRANCH."
