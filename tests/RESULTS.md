# Test results

Detailed results of the end-to-end tests (`tests/run-tests.sh`). Each test
prompt was run without anyone at the keyboard, so a command that would have
shown a permission prompt shows up as **denied** here. "Without the mod"
means Claude Code's normal behaviour; "with the mod" means the default
`verdict: allow`.

## Basic checks (`test-prompt.txt`, macOS, Claude Code 2.1.289)

| Command | Without the mod | With the mod |
|---|---|---|
| `cd sandboxed-read-block && cat hooks/hooks.json` | prompt | runs |
| `cat ~/.zshrc` | prompt | runs, but the sandbox refuses the read: `Operation not permitted` |
| `cat /etc/hosts` | prompt | runs (the sandbox only hides the home directory) |
| Read tool on `~/.zshrc` | blocked | blocked |

The second row is the key safety check: removing the prompt doesn't expose
the home directory, because the sandbox still refuses the read.

The same prompt also checks what the sandbox exposes beyond files
(T8–T11). Each should fail inside the sandbox:

| Test | Should | If it succeeds instead |
|---|---|---|
| T8 `docker ps` | fail to reach the Docker daemon | Docker could read any file on the sandbox's behalf: keep its socket out of `sandbox.network.allowUnixSockets` and `docker` out of `sandbox.excludedCommands` |
| T9 `ls /run/user` (Linux) | fail | add `/run/user` to `sandbox.filesystem.denyRead` |
| T10 `secret-tool search --all service x` (Linux) | fail | the keyring is reachable: deny `/run/user` and check that Unix sockets are blocked |
| T11 `ls /proc` (Linux) | list only a few processes | other processes and their environment variables are visible |

## Command shapes (`test-prompt-compound.txt`)

Which kinds of commands trigger the read block, and whether the mod removes
the prompt. Same results on macOS (2.1.292), Fedora 44 (2.1.286) and Ubuntu
(2.1.285):

| Test | Command shape | Without the mod | With the mod |
|---|---|---|---|
| C1 | one-line `python3 -c "…"` | prompt (read block) | runs |
| C2 | multi-line `python3 -c "…"` | runs | runs |
| C3 | chained plain reads (`grep … && awk …`) | runs | runs |
| C4 | `cd dir && cat file` | prompt (read block) | runs |
| C5 | plain read `;` one-line `python3 -c` | prompt (read block) | runs |
| C6 | two one-line `python3 -c` chained | prompt ("parts require approval") | runs, after checking each part |
| C7 | two `cd`s with relative reads | runs | runs |
| C8 | plain read `&&` multi-line `python3 -c` | runs | runs |

C2, C3, C7 and C8 never prompted, so the mod leaves them alone.

## What the sandbox hides on Linux (`test-prompt-linux.txt`)

Run on Fedora 44 (2.1.286) and Ubuntu (2.1.285) with these entries in
`sandbox.filesystem.denyRead`: `/media`, `/mnt`, `/run/user`, `/tmp/ssh-*`,
`/tmp/.X11-unix`, `**/.env`, `**/.env.*` (plus macOS-only ones such as
`/Network`, which caused no problems on Linux), and `Read(**/.env)` in
`permissions.deny`. Results with the mod, the same on both machines:

| Test | Result | Meaning |
|---|---|---|
| L1 `cat ~/.bashrc` | `No such file or directory` | the home directory is hidden |
| L2 `ls ~` | only the folder leading to the project | same |
| L3 `cat /etc/hostname` | printed | expected: only the home directory is hidden |
| L4 `ls /run/user` | empty | hidden |
| L5 `ls /media /mnt` | empty | hidden (or empty) |
| L6 `ssh-add -l` | `Error connecting to agent: Operation not permitted` | SSH agent unreachable (tested on Ubuntu with an agent running) |
| L7 `ls /tmp/.X11-unix` | empty | X server hidden (or none running) |
| L8 `dbus-send … ListNames` | `Failed to open socket: Operation not permitted` | the sandbox can't open Unix sockets at all, so D-Bus is unreachable |
| L9 `secret-tool search …` | socket blocked, or refused by the classifier | keyring unreachable |
| L10 `ls /proc` | 3 processes | the sandbox has its own process list |
| L11 `cat /proc/1/cmdline` | the sandbox's own shell | your other processes are invisible |
| L12 `docker ps` | `permission denied … /var/run/docker.sock` | Docker daemon unreachable; `docker ps` works in a normal terminal on that machine, so the sandbox is what blocks it |
| L13 write `tests/.env` | `Permission denied` | the `**/.env` rule works; side effect: sandboxed commands can't create `.env` files |
| L14 `cat tests/.env` | denied by a permission rule | `Read(**/.env)` also covers `cat` |
| L15 Read tool on `tests/.env` | denied | `Read(**/.env)` works |
| L16 `rm tests/.env` | `Device or resource busy` | the sandbox mounts a placeholder over the denied path |

## SSH agent

**Linux.** With an agent started in a terminal (`eval "$(ssh-agent -s)"`; there
`ssh-add -l` answers "The agent has no identities.") and Claude Code started
from that terminal, `ssh-add -l` inside the sandbox fails with
`Error connecting to agent: Operation not permitted`, whether or not
`SSH_AUTH_SOCK` is set explicitly. As with D-Bus, the sandbox refuses to
create the socket at all, so the agent is unreachable wherever its socket
lives.

**macOS** (2.1.293). macOS always runs an agent, with its socket at
`/var/run/com.apple.launchd.*/Listeners`. In auto mode the classifier
refuses `ssh-add -l` as credential exploration, so a temporary
`Bash(ssh-add -l)` allow rule was used to get the command into the sandbox.
There it failed with `Error connecting to agent: Operation not permitted`.
The sandbox can see the socket but not connect to it, so no `denyRead` entry
is needed.

## Setup issues found along the way

- **Ubuntu 24.04:** the sandbox didn't start until bubblewrap was allowed by
  an AppArmor profile (see the README's Install section).
- **Ubuntu, Claude Code 2.1.285:** the mod only loaded with
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set; 2.1.274 didn't load it at all.
- **macOS and Fedora** loaded the mod without that variable.
