#!/usr/bin/env bash
# Runs a test prompt headless from the repository root, three times, and
# writes the reports to results/<prompt name>/:
#   baseline        no mod
#   with-mod-allow  the mod with its default verdict (allow)
#   with-mod-ask    a temporary copy of the mod whose default verdict is ask
# Headless, a prompt that would reach you becomes a denial with Claude Code's
# message, so the reports show which commands prompt. The repo's own copy of
# the mod is never edited.
#
# Usage: tests/run-tests.sh [--push] [prompt file, default tests/test-prompt.txt]
#   --push  commit results/<prompt name>/ and push it to the current branch
set -euo pipefail

PUSH=0
PROMPT_FILE=tests/test-prompt.txt
for arg in "$@"; do
  if [[ "$arg" == "--push" ]]; then PUSH=1; else PROMPT_FILE="$arg"; fi
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "no such prompt file: $PROMPT_FILE" >&2
  exit 1
fi

# An installed copy of the mod loads in every run and shadows the copies
# under test, so the baseline would not be a baseline.
# Set in the shell, it is dropped for these runs; set in the settings file,
# only you can take it out.
unset CLAUDE_CODE_PLUGIN_DIRS
SETTINGS="$HOME/.claude/settings.json"
if grep -q CLAUDE_CODE_PLUGIN_DIRS "$SETTINGS" 2>/dev/null; then
  echo "CLAUDE_CODE_PLUGIN_DIRS appears in $SETTINGS:" >&2
  grep -n CLAUDE_CODE_PLUGIN_DIRS "$SETTINGS" >&2
  echo "Remove it while testing so no installed copy of the mod loads, then restore it." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain -- sandboxed-read-block "$PROMPT_FILE")" ]]; then
  echo "sandboxed-read-block/ or $PROMPT_FILE has local changes; commit or revert them first." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ $PUSH -eq 1 ]]; then
  git pull --ff-only origin "$BRANCH"
fi

# Plugin hooks modules are early access; some installs only load them with
# this set. The baseline loads no plugin, so it is unaffected.
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1

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
  echo "Results are in results/$NAME/."
  exit 0
fi

# results/ is gitignored; --push adds this run's reports on purpose.
git add -f "results/$NAME"
git commit -m "Test results ($NAME) $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push origin "$BRANCH"
echo "Pushed results/$NAME/ to $BRANCH."
