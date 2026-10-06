import type { Register, ToolCheckResult } from 'claude-code'

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
const LOG_SIZE = 20

type LogEntry = { command: string; core: ToolCheckResult; action: string }

const firstLine = (command: string, max: number) => command.split('\n')[0].slice(0, max)

const formatLog = (log: readonly LogEntry[]) =>
  log.length === 0
    ? 'No Bash permission checks yet in this load of the mod.'
    : log
        .map((entry, i) => {
          const { decision, reason, rule, hook } = entry.core
          const by = [rule && `rule ${rule}`, hook && `${hook} hook`].filter(Boolean).join(', ')
          return [
            `${i + 1}. ${entry.command}`,
            `   Claude Code: ${decision}${by ? ` (${by})` : ''}${reason ? `: ${reason}` : ''}`,
            `   mod: ${entry.action}`,
          ].join('\n')
        })
        .join('\n')

export const register: Register = (on, options) => {
  const verdict = options.verdict === 'ask' ? 'ask' : 'allow'
  // This load's skipped prompts and last checks; a reload starts over.
  let skipped = 0
  const log: LogEntry[] = []

  on('session.start', async ($, e, next) => {
    $.ui.status(STATUS)
    await $.command.register({
      name: 'read-block-log',
      description: "Show the mod's last Bash permission checks and what it did with each",
    })
    return next(e)
  })

  on('command.run', { command: 'read-block-log' }, async () => ({
    text: formatLog([...log].reverse()),
  }))

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const core = await next(e)
    const input = e.input as BashInput
    // Real calls only: a query (no tool_use_id) shows nothing and isn't logged.
    const isCall = e.tool_use_id !== undefined

    const decide = async (): Promise<[ToolCheckResult, string]> => {
      if (core.decision !== 'ask') return [core, 'left alone (not an ask)']
      if (!core.reason?.includes(READ_BLOCK)) {
        if (options.debug === true && isCall) {
          $.ui.toast(`Not a read-block prompt: ${(core.reason ?? '(no reason)').slice(0, 200)}`, { timeoutMs: 15000 })
        }
        return [core, 'left alone (not a read-block ask)']
      }

      // Only the read block's own ask: not an ask rule, not a settings hook.
      if (core.rule !== undefined || core.hook !== undefined) {
        const kept = `decided by ${core.rule ?? `a ${core.hook} hook`}`
        if (isCall) $.ui.toast(`Kept a read-block prompt: ${kept}`)
        return [core, `kept: ${kept}`]
      }

      const sandbox = ((await $.settings.read()).sandbox ?? {}) as SandboxSettings
      const kept =
        sandbox.enabled !== true
          ? 'the sandbox is off'
          : input.dangerouslyDisableSandbox && sandbox.allowUnsandboxedCommands !== false
            ? 'the command may run unsandboxed'
            : mentionsExcluded(input.command ?? '', sandbox.excludedCommands ?? [])
              ? 'the command mentions an excluded command'
              : undefined

      if (kept !== undefined) {
        if (isCall) $.ui.toast(`Kept a read-block prompt: ${kept}`)
        return [core, `kept: ${kept}`]
      }

      if (verdict === 'allow' && isCall) {
        skipped += 1
        $.ui.status(`${STATUS} · ${skipped} prompt${skipped === 1 ? '' : 's'} skipped`)
        $.ui.toast(`Skipped a read-block prompt: ${firstLine(input.command ?? '', 60)}`)
      }

      return [
        { decision: verdict, reason: `${$.plugin.name}: the sandbox enforces the read block for this command` },
        verdict === 'allow' ? 'skipped the prompt (allow)' : 'answered ask without the read-block reason',
      ]
    }

    const [result, action] = await decide()
    if (isCall) {
      log.push({ command: firstLine(input.command ?? '', 120), core, action })
      if (log.length > LOG_SIZE) log.shift()
    }
    return result
  })
}
