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
  test('is handed back as a plain ask by default', async ($, on) => {
    engine(on, UNANALYZABLE, SANDBOX_ON)
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'cat "$F"' } })
    expect(r.decision).toBe('ask')
    expect(r.reason).not.toContain('blockReadsOutsideWorkingDirectories')
  })

  test('is allowed when the verdict option is allow', { options: { verdict: 'allow' } }, async ($, on) => {
    engine(on, OUTSIDE, SANDBOX_ON)
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'cat ../x' } })
    expect(r.decision).toBe('allow')
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
