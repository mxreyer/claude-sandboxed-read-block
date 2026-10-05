# sandboxed-read-block

A Claude Code mod for setups that run the **sandbox** together with
`permissions.blockReadsOutsideWorkingDirectories`.

The read block prompts on any Bash command whose read targets it can't verify
from the command text (`cd dir && cat file`, paths outside the project). With
the sandbox on, the same setting also denies sandboxed commands your home
directory, so for Bash these prompts are redundant. The mod removes them;
Claude's own file tools (Read, Edit, …) stay blocked as before.

## How it works

`hooks/register.ts` hooks `tool.check` for Bash. It changes the engine's
verdict only when all of these hold:

- the verdict is `ask` and its reason names
  `permissions.blockReadsOutsideWorkingDirectories`;
- no ask rule or settings hook made that decision;
- `sandbox.enabled` is on;
- the command can't run unsandboxed (no `dangerouslyDisableSandbox`, or
  `allowUnsandboxedCommands: false`);
- the command doesn't mention anything in `sandbox.excludedCommands`.

In every other case, including a hook error, the engine's own verdict
stands.

The `verdict` option sets what the mod answers:

| Value | Effect |
|---|---|
| `allow` (default) | The command runs; the sandbox confines it. |
| `ask` | Drops the read-block reason but still asks. In 2.1.289 that ask shows a permission dialog rather than going to the auto-mode classifier, so it doesn't remove prompts. |

## Install

Add the folder to `~/.claude/settings.json` and restart Claude Code:

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/sandboxed-read-block"
}
```

For a single session: `claude --plugin-dir ./sandboxed-read-block`.

## Limits

- **Commands it lets through get no further review.** Neither you nor the
  classifier checks them; only the sandbox's read and write limits apply.
  Commands with literal paths and no `cd` don't trigger the read block, so
  they keep the normal checks.
- **Only the home directory is protected for Bash.** The sandbox
  doesn't block paths such as `/etc`. Add anything private outside your home
  to `sandbox.filesystem.denyRead`.
- **The sandbox side of the read block may be off** if the sandbox's
  filesystem policy is relaxed, a managed read-path lock is on, or the
  working directory's name contains glob characters.
- **The mod depends on the wording of the engine's reason.** If a release
  rewords it, the mod stops matching and the prompts return; it never allows
  more.
- **The hook API is early access** and may change between releases.

## Testing

- Unit tests: `claude plugin test sandboxed-read-block` (engine verdicts
  mocked with the reason strings from Claude Code 2.1.289).
- End to end: `./run-tests.sh` runs `test-prompt.txt` headless without the
  mod, with it (`allow`) and with a temporary `ask` copy, then commits and
  pushes `results/` (`--no-push` keeps them local).

Results on macOS with 2.1.289:

| Test | Without the mod | With the mod (`allow`) |
|---|---|---|
| `cd sandboxed-read-block && cat hooks/hooks.json` | prompt | runs |
| `cat ~/.zshrc` | prompt | runs; the sandbox refuses it: `Operation not permitted` |
| `cat /etc/hosts` | prompt | runs (outside what the sandbox denies) |
| Read tool on `~/.zshrc` | blocked | blocked |
