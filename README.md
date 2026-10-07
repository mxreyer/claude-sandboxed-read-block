# sandboxed-read-block

A Claude Code mod for setups that run the **sandbox** together with
`permissions.blockReadsOutsideWorkingDirectories`.

The read block prompts on any Bash command whose read targets it can't verify
from the command text (`cd dir && cat file`, inline `python3 -c "…"`, paths
outside the project). With the sandbox on, the same setting also denies
sandboxed commands your home directory, so for Bash these prompts are
redundant. The mod removes them; Claude's own file tools (Read, Edit, …) stay
blocked as before.

## Install

Copy the `sandboxed-read-block/` folder somewhere stable, add it to
`~/.claude/settings.json` and restart Claude Code:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-plugins/sandboxed-read-block"
}
```

For a single session: `claude --plugin-dir ./sandboxed-read-block`.

While loaded, the mod pins `read-block mod on` under the prompt. Copy the
folder again after any update and restart.

## How it works

`hooks/register.ts` hooks `tool.check` for Bash. It changes Claude Code's
verdict only when all of these hold:

- the verdict is `ask` and its reason names
  `permissions.blockReadsOutsideWorkingDirectories`, or, for a compound
  command, every part needing approval is held up only by the read block
  (see below);
- no ask rule or settings hook made that decision;
- `sandbox.enabled` is on;
- the command can't run unsandboxed (no `dangerouslyDisableSandbox`, or
  `allowUnsandboxedCommands: false`);
- the command doesn't mention anything in `sandbox.excludedCommands`.

In every other case, including a hook error, Claude Code's own verdict
stands.

**Compound commands.** When two or more parts of a chained command need
approval, Claude Code only says *"This Bash command contains multiple
operations. The following parts require approval: …"*, not why. The mod then
splits the command at `;`, `&&`, `||`, `|`, `&` and line breaks (respecting
quotes) and asks Claude Code about each part on its own. It skips the prompt
only if every part is either allowed or held up only by the read block, and
at least one is held up by it. Any other reason keeps the prompt, and so does
anything it can't split with certainty: `$(…)`, backticks, `( )`, `{ }`,
heredocs, unbalanced quotes.

### Options

Set in `/config`, or in `~/.claude/settings.json` under
`"pluginConfigs": { "sandboxed-read-block": { … } }`.

| Option | Default | Effect |
|---|---|---|
| `verdict` | `allow` | `allow` runs the command; the sandbox confines it. `ask` drops the read-block reason but still asks; tested in 2.1.289, that ask shows a dialog rather than going to the auto-mode classifier, so it doesn't remove prompts. |
| `debug` | off | Shows a notice with Claude Code's reason for every Bash prompt the mod leaves alone. Noisy: in auto mode most commands get a generic ask that the classifier then approves. |

### Seeing what it does

- Each skipped prompt shows a notice with the command and bumps a count on
  the status line (`read-block mod on · 3 prompts skipped`).
- A read-block prompt the mod keeps shows a notice naming the check that kept
  it (e.g. `Kept a read-block prompt: the sandbox is off`).
- `/read-block-log` lists the last 20 Bash permission checks, newest first:
  the command, Claude Code's verdict and reason, and what the mod did. Run it
  right after an unexpected prompt.

## Why not `autoAllowBashIfSandboxed: true`?

That setting approves **every** sandboxed Bash command without classifier
review. The sandbox limits where a command can read and write, but not what
it does there: it doesn't stop deleting files in the project or sending data
to an allowed domain. The classifier does.

The mod skips the classifier only for commands where the read block was the
sole reason to prompt:

| Command | `autoAllowBashIfSandboxed: true` | The mod |
|---|---|---|
| `rm -rf src` (literal path) | runs unreviewed | classifier reviews it |
| `git push --force`, `curl -d @data allowed-domain.com` | run unreviewed | classifier reviews them |
| `cd src && rm -rf build` | runs unreviewed | runs unreviewed |
| `python3 -c "…open('file')…"` | runs unreviewed | runs unreviewed |

The mod doesn't pick commands by risk: a destructive command wrapped in
`cd` or inline code skips review either way. Writing commands with literal
paths, no `cd` and no inline code keeps them out of that group.

Untested: whether `autoAllowBashIfSandboxed: true` removes the read-block
prompts at all. Those prompts bypass the classifier and may bypass the
auto-allow too.

## Limits

- **Commands it lets through get no further review.** Neither you nor the
  classifier checks them; only the sandbox's read and write limits apply.
- **Only the home directory is protected for Bash.** The sandbox doesn't
  block paths such as `/etc`. Add anything private outside your home to
  `sandbox.filesystem.denyRead`.
- **The sandbox side of the read block may be off** if the sandbox's
  filesystem policy is relaxed, a managed read-path lock is on, or the
  working directory's name contains glob characters.
- **The mod depends on the wording of Claude Code's reasons.** If a release
  rewords them, the mod stops matching and the prompts return; it never
  allows more.
- **The hook API is early access** and may change between releases.

## Testing

- **Unit tests:** `claude plugin test sandboxed-read-block` (25 tests;
  Claude Code's verdicts mocked with its real reason strings).
- **End to end:** `tests/run-tests.sh [--push] [prompt file]` runs a test
  prompt headless from the repository root without the mod, with it
  (`allow`) and with a temporary `ask` copy, writing the reports to
  `results/<prompt name>/` (gitignored; `--push` commits and pushes them).
  Headless, a prompt that would reach you becomes a denial with Claude
  Code's message. Remove `CLAUDE_CODE_PLUGIN_DIRS` from your settings while
  testing; the script refuses to run otherwise, since an installed copy
  would load in every run.
  - `tests/test-prompt.txt` (default): the read block, the sandbox, the Read
    tool, and what the sandbox exposes beyond files.
  - `tests/test-prompt-compound.txt`: single, multi-line and chained
    commands.

### Results (macOS)

`tests/test-prompt.txt`, Claude Code 2.1.289:

| Test | Without the mod | With the mod (`allow`) |
|---|---|---|
| `cd sandboxed-read-block && cat hooks/hooks.json` | prompt | runs |
| `cat ~/.zshrc` | prompt | runs; the sandbox refuses it: `Operation not permitted` |
| `cat /etc/hosts` | prompt | runs (outside what the sandbox denies) |
| Read tool on `~/.zshrc` | blocked | blocked |

T8–T11 check what the sandbox exposes beyond files (T9–T11 are Linux only).
With the mod, each should fail inside the sandbox; if one succeeds, close the
gap before relying on the mod:

| Test | Should | If it succeeds |
|---|---|---|
| T8 `docker ps` | fail to reach the daemon | Docker can read any file for the sandbox: keep its socket out of `sandbox.network.allowUnixSockets` and `docker` out of `excludedCommands` |
| T9 `ls /run/user` | fail | add `/run/user` to `sandbox.filesystem.denyRead` |
| T10 `secret-tool search --all service x` | fail | the keyring is reachable over D-Bus: deny `/run/user` and check that Unix sockets are blocked |
| T11 `ls /proc` | list only a few PIDs | other processes' environment variables are readable |

`tests/test-prompt-compound.txt`, Claude Code 2.1.292:

| Test | Command shape | Without the mod | With the mod (`allow`) |
|---|---|---|---|
| C1 | one-line `python3 -c` | prompt (read block) | runs |
| C2 | multi-line `python3 -c` | runs | runs |
| C3 | chained plain reads | runs | runs |
| C4 | `cd dir && cat file` | prompt (read block) | runs |
| C5 | plain read `;` one-line `python3 -c` | prompt (read block) | runs |
| C6 | two one-line `python3 -c` chained | prompt (compound summary) | runs (checked part by part) |
| C7 | two `cd`s with relative reads | runs | runs |
| C8 | plain read `&&` multi-line `python3 -c` | runs | runs |

---

_Co-authored with [Claude Code](https://claude.com/claude-code)._
