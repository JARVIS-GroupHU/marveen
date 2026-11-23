import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { noteQuotaBlindness, quotaWorkClass, resetQuotaBlindStateForTest } from '../web/schedule-runner.js'
import { logger } from '../logger.js'
import { parseQuotaSnapshot } from '../quota-snapshot.js'
import { getSettingDefinition } from '../config-registry.js'

// The gate itself is covered in quota-gate.test.ts. This file covers the two
// seams around it: how a scheduled task is classified, and how the collector's
// on-disk JSON becomes the gate's input.

const RUNNER_SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('quotaWorkClass', () => {
  it('exempts shell-command tasks -- they never call a model', () => {
    expect(quotaWorkClass({ type: 'command' })).toBe('free')
  })

  it('classifies heartbeats as background', () => {
    expect(quotaWorkClass({ type: 'heartbeat' })).toBe('background')
  })

  it('treats owner-visible and unknown future types as owner-facing', () => {
    expect(quotaWorkClass({ type: 'task' })).toBe('owner-facing')
    expect(quotaWorkClass({ type: 'dream-engine' } as never)).toBe('owner-facing')
    expect(quotaWorkClass({} as never)).toBe('owner-facing')
  })
})

describe('schedule-runner wiring', () => {
  it('reads the snapshot once per tick, not once per task', () => {
    // A per-task read would re-parse the same file N times every 60s tick.
    expect(RUNNER_SRC).toContain('const quotaSnapshot = readQuotaSnapshot()')
    expect(RUNNER_SRC.match(/readQuotaSnapshot\(\)/g)?.length).toBe(1)
  })

  it('records a held-back occurrence so the catch-up window cannot re-fire it', () => {
    // Mirrors the pre-check skip: mark the tick as run, log a task-run row.
    const gate = RUNNER_SRC.slice(RUNNER_SRC.indexOf("if (quota.action === 'defer')"))
    const block = gate.slice(0, gate.indexOf('const cronPc'))
    expect(block).toContain('scheduleLastRun.set(task.name, now)')
    expect(block).toContain('persistScheduleLastRun()')
    expect(block).toContain("appendTaskRun(task.name, agentName, 'skipped')")
  })

  it('gates before the pre-check, so a deferred task never spawns its script', () => {
    // CRONPRECHECKSYNC1007: the cron loop awaits the async form now.
    const preCheckIdx = RUNNER_SRC.indexOf('const cronPc = await runPreCheckAsync(task)')
    expect(preCheckIdx).toBeGreaterThan(0)
    expect(RUNNER_SRC.indexOf("if (quota.action === 'defer')")).toBeLessThan(preCheckIdx)
  })
})

describe('parseQuotaSnapshot', () => {
  const onDisk = {
    generated_at: '2026-08-17T14:53:57.362898+00:00',
    generated_at_local: '2026-08-17 16:53:57 CEST',
    codex: { ok: false },
    claude: {
      provider: 'claude',
      source: 'authoritative',
      ok: true,
      windows: {
        five_hour: { used_percent: 10.0, resets_at: 1786990200.146628 },
        seven_day: { used_percent: 13.0, resets_at: 1787205600.146654 },
      },
    },
  }

  it('maps the collector output onto the gate input', () => {
    const s = parseQuotaSnapshot(onDisk)
    expect(s?.source).toBe('authoritative')
    expect(s?.generatedAtMs).toBe(Date.parse('2026-08-17T14:53:57.362898+00:00'))
    expect(s?.windows?.five_hour?.used_percent).toBe(10)
  })

  it('returns null for anything that is not a collector snapshot', () => {
    expect(parseQuotaSnapshot(null)).toBeNull()
    expect(parseQuotaSnapshot('nope')).toBeNull()
    expect(parseQuotaSnapshot({})).toBeNull()
    expect(parseQuotaSnapshot({ claude: 'not-an-object' })).toBeNull()
  })

  it('survives a snapshot with an unparseable timestamp', () => {
    const s = parseQuotaSnapshot({ ...onDisk, generated_at: 'yesterday-ish' })
    // Null timestamp -> the gate fails open rather than trusting stale numbers.
    expect(s?.generatedAtMs).toBeNull()
    expect(s?.source).toBe('authoritative')
  })
})

describe('noteQuotaBlindness -- never silent, and never noisy on a single blip (Péter, 2026-11-23: needs 3 distinct strikes)', () => {
  const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
  const estimate = { source: 'estimate', generatedAtMs: NOW - 60_000, windows: null }
  const fresh = { source: 'ratelimit_headers', generatedAtMs: NOW - 60_000, windows: { seven_day: { used_percent: 22, resets_at: NOW / 1000 + 3600 } } }
  const old = { ...fresh, generatedAtMs: NOW - 3 * 60 * 60_000 }

  let saved: { countingKey: string | null; occurrences: number; lastReadingAtMs: number | null; alertedKey: string | null }
  const store = {
    read: () => saved,
    write: (s: typeof saved) => { saved = s },
  }
  const note = (s: Parameters<typeof noteQuotaBlindness>[0], t: number, n: (x: string) => void) => noteQuotaBlindness(s, t, n, store)
  beforeEach(() => {
    resetQuotaBlindStateForTest()
    saved = { countingKey: null, occurrences: 0, lastReadingAtMs: null, alertedKey: null }
  })
  afterEach(() => vi.restoreAllMocks())

  it('one bad reading, re-checked on several ticks, never alerts: repeats of the same reading do not count', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    for (let i = 0; i < 5; i++) note(estimate, NOW + i * 60_000, notify)
    expect(warn).toHaveBeenCalledTimes(1) // logged once, when first seen; the repeats are silent
    expect(notify).not.toHaveBeenCalled()
  })

  it('needs three distinct blind readings before it notifies', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    const r1 = estimate
    const r2 = { ...estimate, generatedAtMs: estimate.generatedAtMs + 15 * 60_000 }
    const r3 = { ...estimate, generatedAtMs: estimate.generatedAtMs + 30 * 60_000 }
    note(r1, NOW, notify)
    note(r1, NOW + 60_000, notify) // repeat tick of r1: must not count as a 2nd strike
    expect(notify).not.toHaveBeenCalled()
    note(r2, NOW + 15 * 60_000, notify) // 2nd distinct reading
    expect(notify).not.toHaveBeenCalled()
    note(r3, NOW + 30 * 60_000, notify) // 3rd distinct reading -> alert
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('"estimate"')
    expect(warn).toHaveBeenCalledTimes(3) // once per distinct reading, not once per tick
  })

  it('a kind/source change resets the streak -- each new signature needs its own three strikes', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    note(old, NOW, notify) // stale-snapshot, strike 1
    note(old, NOW + 60_000, notify) // repeat: no new strike
    note(estimate, NOW + 120_000, notify) // untrusted-source: different signature, resets to strike 1
    expect(notify).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
    const estimate2 = { ...estimate, generatedAtMs: estimate.generatedAtMs + 60_000 }
    const estimate3 = { ...estimate, generatedAtMs: estimate.generatedAtMs + 120_000 }
    note(estimate2, NOW + 180_000, notify) // strike 2 for this signature
    expect(notify).not.toHaveBeenCalled()
    note(estimate3, NOW + 240_000, notify) // strike 3 -> alert
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('"estimate"')
  })

  it('recovers with one info line, and a new blind spell needs its own three strikes to alert again', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    note(estimate, NOW, notify)
    note({ ...estimate, generatedAtMs: estimate.generatedAtMs + 60_000 }, NOW + 60_000, notify)
    note({ ...estimate, generatedAtMs: estimate.generatedAtMs + 120_000 }, NOW + 120_000, notify)
    expect(notify).toHaveBeenCalledTimes(1) // first spell's 3rd strike alerted

    note(fresh, NOW + 180_000, notify)
    note(fresh, NOW + 240_000, notify)
    expect(info).toHaveBeenCalledTimes(1)

    note(estimate, NOW + 300_000, notify) // new spell, strike 1
    note({ ...estimate, generatedAtMs: estimate.generatedAtMs + 360_000 }, NOW + 360_000, notify) // strike 2
    expect(notify).toHaveBeenCalledTimes(1) // still just the first spell's alert
    note({ ...estimate, generatedAtMs: estimate.generatedAtMs + 420_000 }, NOW + 420_000, notify) // strike 3
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('a restart after the alert already fired does not cause a duplicate notice for the same streak', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    note(estimate, NOW, notify)
    note({ ...estimate, generatedAtMs: estimate.generatedAtMs + 60_000 }, NOW + 60_000, notify)
    note({ ...estimate, generatedAtMs: estimate.generatedAtMs + 120_000 }, NOW + 120_000, notify)
    expect(notify).toHaveBeenCalledTimes(1)
    resetQuotaBlindStateForTest() // dashboard restart: in-memory state lost, store (streak) kept
    note({ ...estimate, generatedAtMs: estimate.generatedAtMs + 180_000 }, NOW + 180_000, notify) // same streak, still estimate
    expect(notify).toHaveBeenCalledTimes(1)
    resetQuotaBlindStateForTest()
    note({ ...estimate, source: 'unknown', generatedAtMs: estimate.generatedAtMs + 240_000 }, NOW + 240_000, notify)
    note({ ...estimate, source: 'unknown', generatedAtMs: estimate.generatedAtMs + 300_000 }, NOW + 300_000, notify)
    note({ ...estimate, source: 'unknown', generatedAtMs: estimate.generatedAtMs + 360_000 }, NOW + 360_000, notify)
    expect(notify).toHaveBeenCalledTimes(2) // a different source is a different streak, alerts on its own 3rd strike
  })

  it('no snapshot (collector not enabled) is not blind: no log, no notice', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    const notify = vi.fn()
    note(null, NOW, notify)
    expect(warn).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('is wired once per tick next to the snapshot read, and the gate gets essential + the hard line', () => {
    expect(RUNNER_SRC).toContain('noteQuotaBlindness(quotaSnapshot, now)')
    expect(RUNNER_SRC.match(/noteQuotaBlindness\(quotaSnapshot/g)?.length).toBe(1)
    expect(RUNNER_SRC).toContain('essential: task.essential === true,')
    expect(RUNNER_SRC).toContain('hardAtPercent: quotaHardAtPercent,')
    const io = readFileSync(join(__dirname, '../web/scheduled-tasks-io.ts'), 'utf-8')
    expect(io).toContain('essential: config.essential === true,')
  })

  it('the tiers are off unless set: registry default 0, and the runner falls back to 0', () => {
    expect(getSettingDefinition('QUOTA_GATE_HARD_AT_PERCENT')?.default).toBe(0)
    expect(RUNNER_SRC).toContain("try { return Number(getEffectiveSettingValue('QUOTA_GATE_HARD_AT_PERCENT')) || 0 } catch { return 0 }")
  })
})
