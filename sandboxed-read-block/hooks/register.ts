import type { Register } from 'claude-code'

// Every reason core gives when permissions.blockReadsOutsideWorkingDirectories
// turns a Bash command into an ask names the setting.
const READ_BLOCK = 'permissions.blockReadsOutsideWorkingDirectories'

type SandboxSettings = {
  enabled?: boolean
  allowUnsandboxedCommands?: boolean
  excludedCommands?: readonly string[]
}

type BashInput = { command?: string; dangerouslyDisableSandbox?: boolean }

// The leading word of each excludedCommands pattern (`docker:*` -> `docker`).
// Matched loosely anywhere in the command, so a compound command that may
// reach an excluded (unsandboxed) program keeps its prompt.
const mentionsExcluded = (command: string, excluded: readonly string[]) =>
  excluded.some(pattern => {
    const word = pattern.split(/[:\s*]/)[0]
    return word !== '' && new RegExp(`(^|[^\\w./-])${word.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w.-])`).test(command)
  })

const STATUS = 'read-block mod on'

export const register: Register = (on, options) => {
  const verdict = options.verdict === 'ask' ? 'ask' : 'allow'
  // Counts this load's skipped prompts; a reload starts over.
  let skipped = 0

  on('session.start', async ($, e, next) => {
    $.ui.status(STATUS)
    return next(e)
  })

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)

    if (result.decision !== 'ask' || !result.reason?.includes(READ_BLOCK)) return result

    // Only the read block's own ask: not an ask rule, not a settings hook.
    if (result.rule !== undefined || result.hook !== undefined) {
      if (e.tool_use_id !== undefined) {
        $.ui.toast(`Kept a read-block prompt: decided by ${result.rule ?? `a ${result.hook} hook`}`)
      }
      return result
    }

    const sandbox = ((await $.settings.read()).sandbox ?? {}) as SandboxSettings
    const input = e.input as BashInput
    const kept =
      sandbox.enabled !== true
        ? 'the sandbox is off'
        : input.dangerouslyDisableSandbox && sandbox.allowUnsandboxedCommands !== false
          ? 'the command may run unsandboxed'
          : mentionsExcluded(input.command ?? '', sandbox.excludedCommands ?? [])
            ? 'the command mentions an excluded command'
            : undefined

    if (kept !== undefined) {
      if (e.tool_use_id !== undefined) $.ui.toast(`Kept a read-block prompt: ${kept}`)
      return result
    }

    // Real calls only: a query (no tool_use_id) skips no prompt.
    if (verdict === 'allow' && e.tool_use_id !== undefined) {
      skipped += 1
      $.ui.status(`${STATUS} · ${skipped} prompt${skipped === 1 ? '' : 's'} skipped`)
      $.ui.toast(`Skipped a read-block prompt: ${(input.command ?? '').split('\n')[0].slice(0, 60)}`)
    }

    return {
      decision: verdict,
      reason: `${$.plugin.name}: the sandbox enforces the read block for this command`,
    }
  })
}
