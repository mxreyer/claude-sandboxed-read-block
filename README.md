# sandboxed-read-block

A small plugin ("mod") for [Claude Code](https://claude.com/claude-code) that
removes a class of redundant permission prompts when you run Claude Code with
both its **sandbox** and the **read block** turned on.

## The problem

Claude Code has several independent safety features. Three of them matter
here:

- **The sandbox** (`sandbox.enabled`) runs every shell command Claude
  executes inside an operating-system-level cage (Seatbelt on macOS,
  bubblewrap on Linux). The cage limits which files the command can touch,
  whatever the command is.
- **The read block** (`permissions.blockReadsOutsideWorkingDirectories`)
  stops Claude from reading files outside the project it's working on. With
  the sandbox on, it also takes your home directory away from sandboxed
  commands entirely.
- **Auto mode** (`permissions.defaultMode: "auto"`) lets a classifier, an AI
  reviewer, approve or refuse Claude's actions, so you aren't asked about
  every command.

The read block checks shell commands by reading the command *text*. When it
can't tell from the text which files a command will read, it doesn't let the
classifier decide: it asks you. That happens for everyday commands such as:

```sh
cd resume && latexmk main.tex
python3 -c "import json; print(json.load(open('config.json')))"
```

With the sandbox on, these prompts are redundant. Whatever such a command
actually reads, the sandbox already stops it from reading your home directory
outside the project. You end up approving harmless commands by hand, many
times a day.

## What the mod does

When the read block is the **only** reason Claude Code wants to ask you about
a shell command, and the command will run inside the sandbox, the mod lets
the command run without the prompt. The sandbox still enforces its limits,
so a command that tries to read, say, `~/.ssh` still fails.

Everything else is unchanged:

- Prompts and classifier reviews for any *other* reason stay as they are.
  For a chained command (`a && b; c`), the mod checks each part separately
  and steps in only if every part is fine or held up only by the read block.
- Claude's own file tools (Read, Edit, …) stay blocked outside the project.
- If the sandbox is off, or a command could run outside it, the mod does
  nothing.
- If the mod fails for any reason, Claude Code's normal behaviour applies.

### Is that safe?

Mostly, with one trade-off you should know about. A command the mod lets
through runs **without review**: neither you nor the classifier looks at it.
The sandbox still limits *where* it can read and write, but not *what* it
does inside the project. For example, `cd src && rm -rf build` would run
unreviewed if the read block was the only reason it needed approval.

Commands written plainly, with literal paths, no `cd` and no inline code,
don't trigger the read block at all. They keep the normal classifier review.
If you ask Claude (e.g. in your `CLAUDE.md`) to write commands that way, very
few commands fall into the unreviewed group.

On macOS and Linux, tests confirmed that the sandbox keeps commands away
from your home directory, SSH agent, Docker daemon, keyring and other
processes, with or without the mod. See [Test results](#test-results).

## Requirements

- Claude Code **2.1.285 or later** (2.1.274 didn't load the mod).
- The sandbox and the read block turned on, ideally with auto mode:

  ```json
  "sandbox": { "enabled": true, "allowUnsandboxedCommands": false },
  "permissions": {
    "defaultMode": "auto",
    "blockReadsOutsideWorkingDirectories": true
  }
  ```

  `allowUnsandboxedCommands: false` matters: it stops Claude from retrying a
  blocked command outside the sandbox.

## Install

1. Put the `sandboxed-read-block/` folder somewhere stable, e.g. clone this
   repository into `~/claude-plugins/`.
2. Tell Claude Code to load it, in `~/.claude/settings.json`:

   ```json
   "env": {
     "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-plugins/claude-sandboxed-read-block/sandboxed-read-block"
   }
   ```

3. Restart Claude Code. Under the prompt you should now see
   **`read-block mod on`**.

To try it for one session only: `claude --plugin-dir ./sandboxed-read-block`.

After updating the folder (e.g. `git pull`), restart Claude Code.

### If `read-block mod on` doesn't appear

- **Plugin hooks are an early-access feature.** On some installs they only
  load when the environment variable `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is
  set. Add `export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` to your shell profile
  (e.g. `~/.bashrc` or `~/.zshrc`) and restart. Starting `claude --debug`
  shows `hooks module not loaded: hooks modules are not turned on…` when this
  is the cause.
- **Check your version** with `claude --version` (2.1.285 or later).

### Ubuntu 24.04: the sandbox itself doesn't start

On Ubuntu 24.04 every sandboxed command may fail with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. This is
Ubuntu's AppArmor restricting the kind of isolation bubblewrap needs. Nothing
runs unsandboxed, but nothing works either. Allow it for `bwrap` alone by
saving this as `/etc/apparmor.d/bwrap`:

```
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

and loading it with `sudo apparmor_parser -r /etc/apparmor.d/bwrap`.

## Using it

- **Status line.** `read-block mod on` means the mod is active. After it
  removes a prompt, the line shows a count, e.g.
  `read-block mod on · 3 prompts skipped`, and a short notice names the
  command.
- **When it keeps a prompt** that the read block raised, a notice says why,
  e.g. `Kept a read-block prompt: the sandbox is off`.
- **`/read-block-log`** lists the last 20 shell commands Claude Code checked:
  Claude Code's verdict and reason, and what the mod did. Run it right after
  an unexpected prompt to see why it appeared.

### Options

Change these in `/config`, or in `~/.claude/settings.json` under
`"pluginConfigs": { "sandboxed-read-block": { … } }`.

| Option | Default | What it does |
|---|---|---|
| `verdict` | `allow` | `allow` runs the command. `ask` only removes the read-block reason and still asks; in practice that still shows you a prompt, so it doesn't help. |
| `debug` | off | Shows a notice with Claude Code's reason for every shell command that needs approval for another reason. Noisy; only for troubleshooting. |

## How it decides

The mod hooks Claude Code's permission check for shell commands. It changes
Claude Code's answer from "ask" to "allow" only when all of these hold:

1. Claude Code wants to ask, and its reason is the read block. For a chained
   command, Claude Code only says *"The following parts require approval:
   …"*. The mod then splits the command at `;`, `&&`, `||`, `|`, `&` and line
   breaks (respecting quotes) and asks Claude Code about each part on its
   own. Every part must be either fine or held up only by the read block,
   and at least one must be held up by it. If the command can't be split
   reliably (`$(…)`, backticks, `( )`, `{ }`, heredocs), the prompt stays.
2. None of your own "ask" rules or settings hooks made the decision.
3. The sandbox is on (`sandbox.enabled`).
4. The command can't run outside the sandbox (no `dangerouslyDisableSandbox`,
   or `allowUnsandboxedCommands: false`).
5. The command doesn't mention anything listed in `sandbox.excludedCommands`.
   Those programs run outside the sandbox.

The read block is recognised by the setting name in Claude Code's reason
text. If a future release rewords it, the mod simply stops matching and the
prompts come back; it never lets more through.

The code is in `sandboxed-read-block/hooks/register.ts`.

## Why not just set `autoAllowBashIfSandboxed: true`?

That setting approves **every** sandboxed command without classifier
review, not just the ones the read block was unsure about:

| Command | `autoAllowBashIfSandboxed: true` | This mod |
|---|---|---|
| `rm -rf src` | runs unreviewed | classifier reviews it |
| `git push --force` | runs unreviewed | classifier reviews it |
| `cd src && rm -rf build` | runs unreviewed | runs unreviewed |
| `python3 -c "…open('file')…"` | runs unreviewed | runs unreviewed |

Whether `autoAllowBashIfSandboxed` would even remove the read-block prompts
wasn't tested.

## Limits

- **Commands the mod lets through aren't reviewed** (see "Is that safe?").
- **Only your home directory is hidden from sandboxed commands.** System
  folders such as `/etc` stay readable. Add anything private elsewhere to
  `sandbox.filesystem.denyRead`.
- **The home-directory protection can switch off** if the sandbox's
  filesystem policy is relaxed, a managed read-path lock is on, or the
  project folder's name contains glob characters (`*`, `?`, `[`).
- **Early-access API.** Plugin hooks may change between Claude Code
  releases. If prompts come back after an update, check the status line and
  `/read-block-log`, and re-run the tests.

## Test results

The mod was tested end to end on macOS, Fedora 44 and Ubuntu, with Claude
Code 2.1.285 to 2.1.293. In short:

- **Prompts removed** for single commands the read block couldn't check
  (`cd dir && cat file`, one-line `python3 -c "…"`) and for chained commands
  made of them.
- **Nothing else changed:** commands that didn't prompt before still don't,
  and the Read tool stays blocked outside the project.
- **The sandbox still protects** your home directory, SSH agent, keyring,
  D-Bus, Docker daemon and other processes, with or without the mod. The
  classifier additionally refuses credential probes such as `ssh-add -l`.

Full tables and details are in [tests/RESULTS.md](tests/RESULTS.md).

### Running the tests yourself

- **Unit tests:** `claude plugin test sandboxed-read-block` (25 tests).
- **End to end:** `tests/run-tests.sh [--push] [prompt file]` runs a test
  prompt three times without anyone at the keyboard: without the mod, with
  it, and with a temporary `ask` copy. It writes the reports to
  `results/<prompt name>/`. Without a person to answer, a prompt shows up as
  a denial with Claude Code's message, so the reports show which commands
  would have prompted. `--push` commits and pushes the reports.
  - `tests/test-prompt.txt` (default): basic read-block and sandbox checks.
  - `tests/test-prompt-compound.txt`: single, multi-line and chained
    commands.
  - `tests/test-prompt-linux.txt`: what the sandbox hides on Linux.

  The results were produced with the settings in
  [`tests/settings.example.json`](tests/settings.example.json); the Linux
  checks in particular depend on its `denyRead` entries. Remove
  `CLAUDE_CODE_PLUGIN_DIRS` from `~/.claude/settings.json` while testing
  (the script tells you if it's there): an installed copy of the mod would
  load in every run and spoil the comparison.

---

_Co-authored with [Claude Code](https://claude.com/claude-code)._
