# Handoff: sandboxed-read-block mod

Start a local Claude Code session in this repo and tell it:
"Read HANDOFF.md and continue from Next steps."

## Goal

My setup runs the sandbox (`sandbox.enabled: true`,
`allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: false`) together
with `permissions.blockReadsOutsideWorkingDirectories: true` in auto mode.
The read block is meant to stop Claude's own file tools from reading outside
the working directory. For Bash it causes many permission prompts: whenever
the static check can't tell where a command reads (`cd dir && cat file`, a
path computed at run time), or a path is outside the working directory, it
asks me instead of letting the auto classifier decide. The sandbox already
confines Bash, so those prompts are redundant.

The mod's job: when the read block is the only reason a sandboxed Bash command
would prompt, take that reason away.

## What was established

- **The sandbox does enforce the read block (Claude Code 2.1.289).** With the
  sandbox on, the setting also denies the home directory to sandboxed
  commands. The binary says: "Sandboxed commands lose your home directory (SSH
  keys, home-installed tools) until you re-open paths with
  sandbox.filesystem.allowRead." Limits:
  - Only the home directory and the external-drive mounts (`/Volumes/`,
    `/run/media/`) are denied, so `/etc` stays readable.
  - The sandbox side doesn't apply if its filesystem policy is relaxed, if a
    managed read-path lock is on, or if the working directory's name contains
    glob characters.
- **Every reason the engine gives for this block contains
  `permissions.blockReadsOutsideWorkingDirectories`.** The mod matches on that
  string. If a later release rewords it, the mod stops matching and the
  prompts come back; it never allows anything by mistake.
- **A hook that throws is skipped, and the engine keeps its own verdict.**
- **The engine resolves simple cases itself.** `F=path; cat "$F"` and globs
  inside the project didn't prompt even in the baseline run. Only `cd` plus a
  relative path, and paths outside the folder, triggered the block.

## The mod (`sandboxed-read-block/`)

`hooks/register.ts` hooks `tool.check` for Bash. It only steps in when the
engine's verdict is `ask`, the reason names the read block, and no ask rule or
settings hook decided. It also leaves the prompt alone when:

- `sandbox.enabled` is off;
- the command could run unsandboxed (`dangerouslyDisableSandbox` set while
  `allowUnsandboxedCommands` isn't `false`);
- the command mentions anything in `sandbox.excludedCommands`.

Otherwise it returns the `verdict` option. The option is set in
`.claude-plugin/plugin.json` and defaults to `ask`:

- `ask` (default) returns a plain ask without the read-block reason, meant to
  route the command to the auto classifier, which still judges what the
  command does.
- `allow` runs the command with no further check. It's simpler, but it skips
  the classifier for exactly the commands it couldn't analyse.

Checks: `claude plugin validate sandboxed-read-block` passes (one warning: the
manifest has no author). `claude plugin test sandboxed-read-block` passes 9 of
9, in `hooks/register.test.ts`; the engine verdicts there are mocked with
reason strings copied from the binary.

## Test runs so far (headless `claude -p` with `test-prompt.txt`)

The test commands: T1 `cd` + `cat`, T2 a variable, T3 a glob, T4
`cat ~/.zshrc`, T5 `cat /etc/hosts`, T6 `git status`, T7 the Read tool on
`~/.zshrc`.

| File | Result |
|---|---|
| `baseline.txt` | T1, T4, T5 and T7 denied with the engine's read-block message; T2, T3, T6 ran |
| `with-mod.txt` | T1, T4, T5 denied with the **mod's** reason, so the mod matched exactly the right commands; T7 still blocked by the built-in check, as intended |
| `with-mod-allow.txt` | Identical to `with-mod.txt`. The `allow` option passed via `--settings '{"pluginConfigs":…}'` never reached the mod, so the run is inconclusive |

Note: in `-p` mode an `ask` with nobody to answer becomes a denial. So "denied
with the mod's reason" means the mod returned `ask`, not that it blocked.

## Open questions

1. **Does the sandbox actually stop T4?** This is the safety check. With
   `verdict: allow`, `cat ~/.zshrc` should run and fail with "Operation not
   permitted". If it prints the file, the sandbox isn't enforcing the block
   and the mod must not be used.
2. **Does a hook's plain `ask` reach the auto classifier, or a dialog?** If no
   classifier review appeared, either the `-p` runs weren't in auto mode or a
   hook's ask skips the classifier. If it skips it, `allow` is the only
   setting that removes the prompts.
3. **How should options be passed to a `--plugin-dir` plugin?** The docs say
   `pluginConfigs` keyed by `<name>` or `<name>@inline`; passing them via a
   `--settings` JSON string didn't work. Try `~/.claude/settings.json` or
   `/config`.

## Next steps

1. Run `./run-tests.sh`. It runs the baseline, the mod with `ask`, and a
   temporary copy of the mod with its default switched to `allow`, so no
   settings are needed. Results go to `results/`, which it commits and pushes.
   Use `--no-push` to keep them local.
2. Check T4 in `results/with-mod-allow.txt`: it must fail with "Operation not
   permitted" (question 1).
3. For question 2, start `claude --plugin-dir ./sandboxed-read-block`
   interactively, paste `test-prompt.txt`, and answer **Yes** to any dialog
   (answering No stops the turn). If T1, T4 and T5 run with no dialog, the
   classifier approved them and `ask` works.
4. Choose `ask` or `allow` based on that, then install the mod for everyday
   use, e.g. via `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
   `~/.claude/settings.json`, or as a local marketplace plugin.

## Files

- `sandboxed-read-block/`: the mod (manifest, hooks module, tests)
- `test-prompt.txt`: the prompt for the test runs
- `run-tests.sh`: runs the three test runs and pushes `results/`
- `baseline.txt`, `with-mod.txt`, `with-mod-allow.txt`: earlier results
- Branch: `claude/focused-feynman-t9yicz`
