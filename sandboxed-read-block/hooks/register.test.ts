import { describe, expect, test } from 'claude-code/testing'
import type { On, ToolCheckResult } from 'claude-code'

// Reason texts as Claude Code 2.1.289 produces them for the read block.
const UNANALYZABLE: ToolCheckResult = {
  decision: 'ask',
  reason:
    "This command names a path that is computed at run time, which cannot be checked against the read block (permissions.blockReadsOutsideWorkingDirectories)",
}
const OUTSIDE: ToolCheckResult = {
  decision: 'ask',
  reason:
    "cat names a path outside the working directories, which the read block does not allow without asking (permissions.blockReadsOutsideWorkingDirectories). Add the directory with /add-dir, or remove that setting.",
}

const SANDBOX_ON = { enabled: true, allowUnsandboxedCommands: false }

const engine = (on: On, core: ToolCheckResult, sandbox: object | undefined) => {
  on('tool.check', () => core)
  on('settings.read', () => ({ value: sandbox === undefined ? {} : { sandbox } }))
}

describe('read-block ask on a sandboxed Bash command', () => {
  test('is allowed by default', async ($, on) => {
    engine(on, OUTSIDE, SANDBOX_ON)
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x' } })
    expect(r.decision).toBe('allow')
  })

  test('is handed back as a plain ask when the verdict option is ask', { options: { verdict: 'ask' } }, async ($, on) => {
    engine(on, UNANALYZABLE, SANDBOX_ON)
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'cat "$F"' } })
    expect(r.decision).toBe('ask')
    expect(r.reason).not.toContain('blockReadsOutsideWorkingDirectories')
  })

  test('ignores dangerouslyDisableSandbox when unsandboxed commands are off', { options: { verdict: 'allow' } }, async ($, on) => {
    engine(on, OUTSIDE, SANDBOX_ON)
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x', dangerouslyDisableSandbox: true } })
    expect(r.decision).toBe('allow')
  })
})

describe('left as core decided', () => {
  test('when the sandbox is off', { options: { verdict: 'allow' } }, async ($, on) => {
    engine(on, OUTSIDE, undefined)
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x' } })
    expect(r).toEqual(OUTSIDE)
  })

  test('when the command may run unsandboxed', { options: { verdict: 'allow' } }, async ($, on) => {
    engine(on, OUTSIDE, { enabled: true })
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x', dangerouslyDisableSandbox: true } })
    expect(r).toEqual(OUTSIDE)
  })

  test('when the command reaches an excluded command', { options: { verdict: 'allow' } }, async ($, on) => {
    engine(on, OUTSIDE, { ...SANDBOX_ON, excludedCommands: ['docker:*'] })
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'ls && docker run -v ~/:/h x' } })
    expect(r).toEqual(OUTSIDE)
  })

  test('when the ask has another reason', { options: { verdict: 'allow' } }, async ($, on) => {
    const other: ToolCheckResult = { decision: 'ask', reason: 'writes to .claude/settings.json' }
    engine(on, other, SANDBOX_ON)
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'x' } })).toEqual(other)
  })

  test('when an ask rule decided', { options: { verdict: 'allow' } }, async ($, on) => {
    const rule: ToolCheckResult = { ...OUTSIDE, rule: 'Bash(cat:*)' }
    engine(on, rule, SANDBOX_ON)
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x' } })).toEqual(rule)
  })

  test('when core denied', { options: { verdict: 'allow' } }, async ($, on) => {
    const deny: ToolCheckResult = { decision: 'deny', reason: 'Read(~/.ssh/**) (permissions.blockReadsOutsideWorkingDirectories)' }
    engine(on, deny, SANDBOX_ON)
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'cat ~/.ssh/id' } })).toEqual(deny)
  })
})

describe('indicator', () => {
  const ui = (on: On) => {
    const seen = { status: [] as (string | undefined)[], toasts: [] as string[] }
    on('ui.status', (_$, e) => { seen.status.push(e.text) })
    on('ui.toast', (_$, e) => { seen.toasts.push(e.text) })
    return seen
  }

  test('pins the status line at session start', async ($, on) => {
    const seen = ui(on)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    expect(seen.status).toEqual(['read-block mod on'])
  })

  test('counts and toasts each skipped prompt on a real call', async ($, on) => {
    const seen = ui(on)
    engine(on, OUTSIDE, SANDBOX_ON)
    await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x' }, tool_use_id: 't1' })
    await $.tool.check({ tool: 'Bash', input: { command: 'cat ../y' }, tool_use_id: 't2' })
    expect(seen.status).toEqual(['read-block mod on · 1 prompt skipped', 'read-block mod on · 2 prompts skipped'])
    expect(seen.toasts).toEqual(['Skipped a read-block prompt: cat ../x', 'Skipped a read-block prompt: cat ../y'])
  })

  test('names the check that kept a prompt', async ($, on) => {
    const seen = ui(on)
    engine(on, OUTSIDE, undefined)
    await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x' }, tool_use_id: 't1' })
    expect(seen.toasts).toEqual(['Kept a read-block prompt: the sandbox is off'])
    expect(seen.status).toEqual([])
  })

  test('names the rule that kept a prompt', async ($, on) => {
    const seen = ui(on)
    engine(on, { ...OUTSIDE, rule: 'Bash(cat:*)' }, SANDBOX_ON)
    await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x' }, tool_use_id: 't1' })
    expect(seen.toasts).toEqual(['Kept a read-block prompt: decided by Bash(cat:*)'])
  })

  test('stays quiet on an ask that is not the read block', async ($, on) => {
    const seen = ui(on)
    engine(on, { decision: 'ask', reason: 'something else' }, SANDBOX_ON)
    await $.tool.check({ tool: 'Bash', input: { command: 'x' }, tool_use_id: 't1' })
    expect(seen.toasts).toEqual([])
  })

  test('stays quiet on a query', async ($, on) => {
    const seen = ui(on)
    engine(on, OUTSIDE, SANDBOX_ON)
    await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x' } })
    expect(seen.toasts).toEqual([])
  })
})
