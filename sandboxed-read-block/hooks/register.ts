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

// Core's verdict on a compound command names the parts that need approval,
// not why: "This Bash command contains multiple operations. The following
// parts require approval: …".
const COMPOUND = 'contains multiple operations'

// Splits a command into its parts at top-level `;`, `&&`, `||`, `|`, `&` and
// line breaks, respecting quotes. Answers undefined for anything it can't
// split with certainty (command substitution, subshells, groups, heredocs,
// process substitution, unbalanced quotes): the caller then keeps the prompt.
const splitCommand = (command: string): string[] | undefined => {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const pair = command.slice(i, i + 2)
    if (quote === "'") {
      current += c
      if (c === "'") quote = undefined
      continue
    }
    if (c === '\\') {
      current += pair
      i++
      continue
    }
    if (pair === '$(' || c === '`') return undefined
    if (quote === '"') {
      current += c
      if (c === '"') quote = undefined
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    if ('(){}'.includes(c) || pair === '<<' || pair === '|&') return undefined
    if (pair === '&&' || pair === '||') {
      parts.push(current)
      current = ''
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      // `>&2`, `2>&1`, `&>`: a redirection, not a separator.
      if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
        current += c
        continue
      }
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  if (quote !== undefined) return undefined
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

const isReadBlockAsk = (result: ToolCheckResult) =>
  result.decision === 'ask' &&
  result.rule === undefined &&
  result.hook === undefined &&
  result.reason?.includes(READ_BLOCK) === true

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
  // Parts of a compound command the mod is asking core about: their queries
  // get core's own verdict, not the mod's.
  const probing = new Set<string>()

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
    const command = input.command ?? ''
    // Real calls only: a query (no tool_use_id) shows nothing and isn't logged.
    const isCall = e.tool_use_id !== undefined
    if (!isCall && probing.has(command)) return core

    // For a compound ask, asks core about each part on its own. Answers
    // undefined when every part is either fine or held up only by the read
    // block, and at least one is; otherwise why the prompt stays.
    const keptCompound = async (): Promise<string | undefined> => {
      const parts = splitCommand(command)
      if (parts === undefined || parts.length < 2) return "couldn't split the command into parts"
      let readBlocked = 0
      for (const part of parts) {
        probing.add(part)
        let result: ToolCheckResult
        try {
          result = await $.tool.check({ tool: 'Bash', input: { command: part } })
        } finally {
          probing.delete(part)
        }
        if (isReadBlockAsk(result)) readBlocked += 1
        else if (result.decision !== 'allow') {
          return `part "${firstLine(part, 60)}" needs approval: ${result.reason ?? result.decision}`
        }
      }
      return readBlocked === 0 ? 'no part is held up by the read block' : undefined
    }

    const decide = async (): Promise<[ToolCheckResult, string]> => {
      if (core.decision !== 'ask') return [core, 'left alone (not an ask)']

      // Only the read block's own ask: not an ask rule, not a settings hook.
      if (core.rule !== undefined || core.hook !== undefined) {
        if (!core.reason?.includes(READ_BLOCK)) return [core, 'left alone (not a read-block ask)']
        const kept = `decided by ${core.rule ?? `a ${core.hook} hook`}`
        if (isCall) $.ui.toast(`Kept a read-block prompt: ${kept}`)
        return [core, `kept: ${kept}`]
      }

      let viaParts = false
      if (!core.reason?.includes(READ_BLOCK)) {
        if (!isCall || !core.reason?.includes(COMPOUND)) {
          if (options.debug === true && isCall) {
            $.ui.toast(`Not a read-block prompt: ${(core.reason ?? '(no reason)').slice(0, 200)}`, { timeoutMs: 15000 })
          }
          return [core, 'left alone (not a read-block ask)']
        }
        const kept = await keptCompound()
        if (kept !== undefined) {
          if (options.debug === true) $.ui.toast(`Kept a compound prompt: ${kept}`, { timeoutMs: 15000 })
          return [core, `left alone (compound: ${kept})`]
        }
        viaParts = true
      }

      const sandbox = ((await $.settings.read()).sandbox ?? {}) as SandboxSettings
      const kept =
        sandbox.enabled !== true
          ? 'the sandbox is off'
          : input.dangerouslyDisableSandbox && sandbox.allowUnsandboxedCommands !== false
            ? 'the command may run unsandboxed'
            : mentionsExcluded(command, sandbox.excludedCommands ?? [])
              ? 'the command mentions an excluded command'
              : undefined

      if (kept !== undefined) {
        if (isCall) $.ui.toast(`Kept a read-block prompt: ${kept}`)
        return [core, `kept: ${kept}`]
      }

      if (verdict === 'allow' && isCall) {
        skipped += 1
        $.ui.status(`${STATUS} · ${skipped} prompt${skipped === 1 ? '' : 's'} skipped`)
        $.ui.toast(`Skipped a read-block prompt: ${firstLine(command, 60)}`)
      }

      const parts = viaParts ? ' (every part needing approval is held up only by the read block)' : ''
      return [
        { decision: verdict, reason: `${$.plugin.name}: the sandbox enforces the read block for this command` },
        (verdict === 'allow' ? 'skipped the prompt (allow)' : 'answered ask without the read-block reason') + parts,
      ]
    }

    const [result, action] = await decide()
    if (isCall) {
      log.push({ command: firstLine(command, 120), core, action })
      if (log.length > LOG_SIZE) log.shift()
    }
    return result
  })
}
