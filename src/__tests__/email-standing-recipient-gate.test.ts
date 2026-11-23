import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import {
  gateDecision,
  readStandingList,
  standingMatch,
  standingAnchor,
  standingAuthorized,
  standingTrace,
  buildStandingDenyMsg,
  STANDING_CATEGORY,
  // @ts-expect-error -- plain .mjs hook script, no types
} from '../../scripts/email-send-gate.mjs'
import {
  injectEmailSendGate,
  hasStandingRecipientCapability,
  hasThreadReplyCapability,
  emailGateCommandStale,
  EMAIL_STANDING_RECIPIENT_CAPABILITY,
  EMAIL_STANDING_RECIPIENT_FLAG,
  EMAIL_THREAD_REPLY_FLAG,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'email-send-gate.mjs')
const require_ = createRequire(ROOT + '/package.json')
const Database = require_('better-sqlite3')

// Owner decision 2026-11-23 (Peter, Telegram): a standing-recipient capability
// lets a capability-flagged sub-agent send DIRECTLY to an address the owner
// has made a one-time standing decision about, without a per-letter approval
// and without routing through the main agent. Ported from the main agent's
// own email_send level-2 standing-list mechanism (scripts/hooks/
// email-approval-gate.py) so the two can never silently disagree.

function makeApprovalsDb(dbPath: string, rows: Array<{ hash: string; status: string; resolvedAgo?: number }> = []) {
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, agent_id TEXT, category TEXT, action_description TEXT,
    status TEXT, requested_at INTEGER, resolved_at INTEGER, resolved_by TEXT, content_hash TEXT
  )`)
  const now = Math.floor(Date.now() / 1000)
  const ins = db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, resolved_at, content_hash)
    VALUES (?, 'marveen', ?, 'teszt', ?, ?, ?, ?)`)
  let i = 0
  for (const r of rows) {
    i += 1
    const resolvedAt = r.status === 'pending' ? null : now - (r.resolvedAgo ?? 0)
    ins.run(`row${i}`, STANDING_CATEGORY, r.status, now - 10, resolvedAt, r.hash)
  }
  db.close()
}

describe('readStandingList', () => {
  it('a missing file means no standing rights, no note (normal state)', () => {
    const { standing, note } = readStandingList(() => { const e: any = new Error('nope'); e.code = 'ENOENT'; throw e })
    expect(standing.size).toBe(0)
    expect(note).toBeNull()
  })

  it('accepts the bare-array shape and the {recipients:[...]} shape, string and object entries', () => {
    const a = readStandingList(() => JSON.stringify(['Dani@Pelda.hu', { address: 'masik@pelda.hu', note: 'miert' }]))
    expect([...a.standing].sort()).toEqual(['dani@pelda.hu', 'masik@pelda.hu'])
    const b = readStandingList(() => JSON.stringify({ recipients: ['x@y.hu'] }))
    expect([...b.standing]).toEqual(['x@y.hu'])
  })

  it('a corrupt or wrongly-shaped file yields NO rights but a visible note (fail-closed, not silently empty)', () => {
    const corrupt = readStandingList(() => '{not json')
    expect(corrupt.standing.size).toBe(0)
    expect(corrupt.note).toContain('fail-closed')
    const wrongShape = readStandingList(() => JSON.stringify({ recipients: 'x@y.hu' }))
    expect(wrongShape.standing.size).toBe(0)
    expect(wrongShape.note).toContain('fail-closed')
  })

  it('an unreadable file (not ENOENT) also yields no rights, with a note', () => {
    const { standing, note } = readStandingList(() => { throw new Error('EACCES') })
    expect(standing.size).toBe(0)
    expect(note).toContain('nem olvashato')
  })
})

describe('standingMatch', () => {
  const listed = new Set(['dani@pelda.hu'])

  it('matches the sole, listed `to` recipient', () => {
    expect(standingMatch({ to: ['dani@pelda.hu'] }, listed)).toBe('dani@pelda.hu')
    expect(standingMatch({ to: ['Dani <DANI@PELDA.HU>'] }, listed)).toBe('dani@pelda.hu')
  })

  it('refuses when the address is not listed', () => {
    expect(standingMatch({ to: ['idegen@pelda.hu'] }, listed)).toBeNull()
  })

  it('refuses with ANY cc or bcc, even a listed sole `to`', () => {
    expect(standingMatch({ to: ['dani@pelda.hu'], cc: ['x@y.hu'] }, listed)).toBeNull()
    expect(standingMatch({ to: ['dani@pelda.hu'], bcc: ['x@y.hu'] }, listed)).toBeNull()
  })

  it('refuses two addresses in one `to` entry, or two `to` entries', () => {
    expect(standingMatch({ to: ['dani@pelda.hu, masik@pelda.hu'] }, listed)).toBeNull()
    expect(standingMatch({ to: ['dani@pelda.hu', 'masik@pelda.hu'] }, listed)).toBeNull()
  })

  it('never matches an anchor-token `to` (messageId:/reply_to:), even if it parses as the listed address', () => {
    expect(standingMatch({ to: ['messageId:dani@pelda.hu'] }, listed)).toBeNull()
    expect(standingMatch({ to: ['reply_to:dani@pelda.hu'] }, listed)).toBeNull()
  })

  it('never matches when reply_to is present (addressed by the original, not by us)', () => {
    expect(standingMatch({ to: ['dani@pelda.hu'], reply_to: 'something' }, listed)).toBeNull()
  })

  it('returns null with an empty or missing standing set', () => {
    expect(standingMatch({ to: ['dani@pelda.hu'] }, new Set())).toBeNull()
    expect(standingMatch({ to: ['dani@pelda.hu'] }, null)).toBeNull()
  })
})

describe('standingAnchor', () => {
  it('is deterministic and normalises case/whitespace', () => {
    expect(standingAnchor('Dani@Pelda.hu')).toBe(standingAnchor('  dani@pelda.hu  '))
    expect(standingAnchor('a@b.hu')).not.toBe(standingAnchor('c@d.hu'))
    expect(standingAnchor('a@b.hu')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('standingAuthorized (real temp sqlite db)', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('throws (fail-closed) when the db file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'standing-auth-'))
    expect(() => standingAuthorized('dani@pelda.hu', join(dir, 'nope.db'))).toThrow()
  })

  it('no row at all -> not live, "nincs elesites"', () => {
    dir = mkdtempSync(join(tmpdir(), 'standing-auth-'))
    const db = join(dir, 'c.db')
    makeApprovalsDb(db, [])
    const r = standingAuthorized('dani@pelda.hu', db)
    expect(r.live).toBe(false)
    expect(r.detail).toContain('nincs')
  })

  it('an approved, resolved row -> live', () => {
    dir = mkdtempSync(join(tmpdir(), 'standing-auth-'))
    const db = join(dir, 'c.db')
    makeApprovalsDb(db, [{ hash: standingAnchor('dani@pelda.hu'), status: 'approved', resolvedAgo: 0 }])
    expect(standingAuthorized('dani@pelda.hu', db).live).toBe(true)
  })

  it('a rejected row -> not live, names the status', () => {
    dir = mkdtempSync(join(tmpdir(), 'standing-auth-'))
    const db = join(dir, 'c.db')
    makeApprovalsDb(db, [{ hash: standingAnchor('dani@pelda.hu'), status: 'rejected', resolvedAgo: 0 }])
    const r = standingAuthorized('dani@pelda.hu', db)
    expect(r.live).toBe(false)
    expect(r.detail).toContain('rejected')
  })

  it('a pending (unresolved) row -> not live, names it pending', () => {
    dir = mkdtempSync(join(tmpdir(), 'standing-auth-'))
    const db = join(dir, 'c.db')
    makeApprovalsDb(db, [{ hash: standingAnchor('dani@pelda.hu'), status: 'pending' }])
    const r = standingAuthorized('dani@pelda.hu', db)
    expect(r.live).toBe(false)
    expect(r.detail).toContain('FUGGOBEN')
  })

  it('NOT time-windowed: an approval resolved long ago is still live', () => {
    dir = mkdtempSync(join(tmpdir(), 'standing-auth-'))
    const db = join(dir, 'c.db')
    makeApprovalsDb(db, [{ hash: standingAnchor('dani@pelda.hu'), status: 'approved', resolvedAgo: 100_000 }])
    expect(standingAuthorized('dani@pelda.hu', db).live).toBe(true)
  })

  it('the LAST resolved decision wins: a later rejection revokes an earlier approval', () => {
    dir = mkdtempSync(join(tmpdir(), 'standing-auth-'))
    const db = join(dir, 'c.db')
    const h = standingAnchor('dani@pelda.hu')
    makeApprovalsDb(db, [
      { hash: h, status: 'approved', resolvedAgo: 600 },
      { hash: h, status: 'rejected', resolvedAgo: 0 },
    ])
    expect(standingAuthorized('dani@pelda.hu', db).live).toBe(false)
    // and the reverse: a later approval re-activates after an earlier rejection
    const db2 = join(dir, 'c2.db')
    makeApprovalsDb(db2, [
      { hash: h, status: 'rejected', resolvedAgo: 600 },
      { hash: h, status: 'approved', resolvedAgo: 0 },
    ])
    expect(standingAuthorized('dani@pelda.hu', db2).live).toBe(true)
  })

  it('only the address asked about is affected, not other listed addresses', () => {
    dir = mkdtempSync(join(tmpdir(), 'standing-auth-'))
    const db = join(dir, 'c.db')
    makeApprovalsDb(db, [{ hash: standingAnchor('masik@pelda.hu'), status: 'approved', resolvedAgo: 0 }])
    expect(standingAuthorized('dani@pelda.hu', db).live).toBe(false)
    expect(standingAuthorized('masik@pelda.hu', db).live).toBe(true)
  })
})

describe('standingTrace', () => {
  it('appends a local log line and reports the dashboard reached (ok fetch)', async () => {
    const appended: string[] = []
    const gap = await standingTrace('garagizike', 'dani@pelda.hu', 'Targy - Torzs', {
      appendFile: (_p: string, line: string) => { appended.push(line) },
      fetchImpl: async () => ({ ok: true }),
      readFile: (p: string) => (p.endsWith('.dashboard-token') ? 'tok' : 'WEB_PORT=3420'),
    })
    expect(gap).toBeNull()
    expect(appended).toHaveLength(1)
    expect(appended[0]).toContain('garagizike')
    expect(appended[0]).toContain('dani@pelda.hu')
    expect(appended[0]).toContain('gazda-ertesites=ok')
  })

  it('a failed dashboard post does NOT throw, but the gap is on the record (local log + return value)', async () => {
    const appended: string[] = []
    const gap = await standingTrace('garagizike', 'dani@pelda.hu', 'szoveg', {
      appendFile: (_p: string, line: string) => { appended.push(line) },
      fetchImpl: async () => { throw new Error('ECONNREFUSED') },
      readFile: (p: string) => (p.endsWith('.dashboard-token') ? 'tok' : 'WEB_PORT=3420'),
    })
    expect(gap).not.toBeNull()
    expect(appended[0]).toContain('NEM MENT KI')
  })

  it('a failed LOCAL append throws -- the caller must deny on it (unrecordable send never goes out)', async () => {
    await expect(standingTrace('garagizike', 'dani@pelda.hu', 'x', {
      appendFile: () => { throw new Error('EACCES') },
      fetchImpl: async () => ({ ok: true }),
    })).rejects.toThrow('EACCES')
  })
})

describe('gateDecision regression: send_email still unconditionally denies (standing is an entrypoint-only narrowing)', () => {
  it('kind stays send_email, unaffected by any standing list', () => {
    const d = gateDecision('mcp__server-gmail-autoauth-mcp__send_email', { to: ['dani@pelda.hu'] })
    expect(d.deny).toBe(true)
    expect(d.kind).toBe('send_email')
  })
})

describe('hasStandingRecipientCapability', () => {
  it('grants only a sub-agent that carries the capability', () => {
    expect(hasStandingRecipientCapability('garagizike', [EMAIL_STANDING_RECIPIENT_CAPABILITY])).toBe(true)
    expect(hasStandingRecipientCapability('garagizike', [])).toBe(false)
    expect(hasStandingRecipientCapability('garagizike', ['other:cap'])).toBe(false)
  })

  it('never applies to the main agent', () => {
    expect(hasStandingRecipientCapability(MAIN_AGENT_ID, [EMAIL_STANDING_RECIPIENT_CAPABILITY])).toBe(false)
  })
})

describe('injectEmailSendGate with the standing-recipient flag (independent of thread-reply)', () => {
  const innerCommand = (s: Record<string, unknown>): string => {
    const pre = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    expect(pre).toHaveLength(1)
    return (pre[0].hooks as Array<{ command: string }>)[0].command
  }

  it('default stays byte-identical shape: no flag', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    expect(innerCommand(s)).not.toContain(EMAIL_STANDING_RECIPIENT_FLAG)
  })

  it('standingRecipient=true (alone) passes only its own flag', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s, false, true)
    const cmd = innerCommand(s)
    expect(cmd).toContain(EMAIL_STANDING_RECIPIENT_FLAG)
    expect(cmd).not.toContain(EMAIL_THREAD_REPLY_FLAG)
  })

  it('both flags together, and each toggles independently of the other', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s, true, true)
    let cmd = innerCommand(s)
    expect(cmd).toContain(EMAIL_THREAD_REPLY_FLAG)
    expect(cmd).toContain(EMAIL_STANDING_RECIPIENT_FLAG)
    injectEmailSendGate(s, true, false)
    cmd = innerCommand(s)
    expect(cmd).toContain(EMAIL_THREAD_REPLY_FLAG)
    expect(cmd).not.toContain(EMAIL_STANDING_RECIPIENT_FLAG)
    injectEmailSendGate(s, false, true)
    cmd = innerCommand(s)
    expect(cmd).not.toContain(EMAIL_THREAD_REPLY_FLAG)
    expect(cmd).toContain(EMAIL_STANDING_RECIPIENT_FLAG)
  })
})

describe('emailGateCommandStale with the standing-recipient flag', () => {
  const entry = (command: string) => [{ matcher: 'Bash|.*send_email.*', hooks: [{ type: 'command', command }] }]
  const base = '"/usr/bin/node" "/x/scripts/email-send-gate.mjs"'

  it('flags a grant not yet applied, and a since-revoked grant', () => {
    expect(emailGateCommandStale(entry(base), `${base} ${EMAIL_STANDING_RECIPIENT_FLAG}`)).toBe(true)
    expect(emailGateCommandStale(entry(`${base} ${EMAIL_STANDING_RECIPIENT_FLAG}`), base)).toBe(true)
  })

  it('is quiet when the entry matches the expectation', () => {
    const flagged = `${base} ${EMAIL_STANDING_RECIPIENT_FLAG}`
    expect(emailGateCommandStale(entry(flagged), flagged)).toBe(false)
  })
})

describe('buildStandingDenyMsg', () => {
  it('appends the approval-request recipe only for the "not activated" detail', () => {
    expect(buildStandingDenyMsg('nincs gazdai elesites')).toContain('POST /api/approvals')
    expect(buildStandingDenyMsg('a cimzett nincs rajta az allando listan')).not.toContain('POST /api/approvals')
  })
})

// Entrypoint integration: a disposable root (scripts/ symlinked to the real
// repo, store/ a real temp dir) so the script's own path resolution (ROOT_DIR
// off import.meta.url) lands in an isolated store, exactly as the Python
// twin's test harness does for email-approval-gate.py (ENVRELAXGATE1104: no
// environment variable may choose the store).
describe('gate script entrypoint, standing-recipient flag (spawned, isolated store)', () => {
  function makeRoot(): string {
    // A full scripts/ SYMLINK would make import.meta.url resolve through to
    // the REAL repo root (Node resolves the entry module's realpath), which
    // would read/write the real store -- so the two files the gate actually
    // loads (itself + its one dynamic dependency) are COPIED instead, into a
    // scripts/ directory that is genuinely inside the temp root. node_modules
    // stays a symlink (nothing resolves it as the entry module's own path).
    const root = mkdtempSync(join(tmpdir(), 'standing-gate-root-'))
    mkdirSync(join(root, 'scripts'))
    copyFileSync(join(ROOT, 'scripts', 'email-send-gate.mjs'), join(root, 'scripts', 'email-send-gate.mjs'))
    copyFileSync(join(ROOT, 'scripts', 'recipient-ledger.mjs'), join(root, 'scripts', 'recipient-ledger.mjs'))
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'))
    mkdirSync(join(root, 'store'))
    writeFileSync(join(root, '.env'), 'WEB_PORT=3420\n')
    return root
  }
  function run(root: string, args: string[], payload: unknown): any {
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'email-send-gate.mjs'), ...args], {
      input: JSON.stringify(payload),
      cwd: join(root, 'agents', 'garagizike'),
      timeout: 15_000,
    }).toString()
    return out ? JSON.parse(out) : null
  }
  const sendPayload = (to: string[]) => ({ tool_name: 'mcp__server-gmail-autoauth-mcp__send_email', tool_input: { to, subject: 'T', body: 'B' } })

  afterEach(() => { /* each test makes its own root; nothing shared to clean mid-describe */ })

  it('WITHOUT the flag, send_email still gets the unconditional governance deny', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'agents', 'garagizike'), { recursive: true })
    try {
      const res = run(root, [], sendPayload(['dani@pelda.hu']))
      expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(res.hookSpecificOutput.permissionDecisionReason).toContain('governance hard-gate')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('WITH the flag but no standing-list file: denies, names the reason', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'agents', 'garagizike'), { recursive: true })
    try {
      const res = run(root, [EMAIL_STANDING_RECIPIENT_FLAG], sendPayload(['dani@pelda.hu']))
      expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(res.hookSpecificOutput.permissionDecisionReason).toContain('nincs rajta')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('WITH the flag, listed but not yet activated: denies, names the anchor', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'agents', 'garagizike'), { recursive: true })
    writeFileSync(join(root, 'store', 'email-standing-recipients.json'), JSON.stringify({ recipients: ['dani@pelda.hu'] }))
    makeApprovalsDb(join(root, 'store', 'claudeclaw.db'), [])
    try {
      const res = run(root, [EMAIL_STANDING_RECIPIENT_FLAG], sendPayload(['dani@pelda.hu']))
      expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(res.hookSpecificOutput.permissionDecisionReason).toContain('NINCS ELESITVE')
      expect(res.hookSpecificOutput.permissionDecisionReason).toContain(standingAnchor('dani@pelda.hu'))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('WITH the flag, listed AND activated: ALLOWS (no output), and records the trace locally', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'agents', 'garagizike'), { recursive: true })
    writeFileSync(join(root, 'store', 'email-standing-recipients.json'), JSON.stringify({ recipients: ['dani@pelda.hu'] }))
    makeApprovalsDb(join(root, 'store', 'claudeclaw.db'), [{ hash: standingAnchor('dani@pelda.hu'), status: 'approved' }])
    try {
      const res = run(root, [EMAIL_STANDING_RECIPIENT_FLAG], sendPayload(['dani@pelda.hu']))
      expect(res).toBeNull() // allow() exits 0 with no stdout
      const log = readFileSync(join(root, 'store', 'email-standing-sends.log'), 'utf-8')
      expect(log).toContain('garagizike')
      expect(log).toContain('dani@pelda.hu')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('WITH the flag, a cc present defeats the standing match even for a listed, activated address', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'agents', 'garagizike'), { recursive: true })
    writeFileSync(join(root, 'store', 'email-standing-recipients.json'), JSON.stringify({ recipients: ['dani@pelda.hu'] }))
    makeApprovalsDb(join(root, 'store', 'claudeclaw.db'), [{ hash: standingAnchor('dani@pelda.hu'), status: 'approved' }])
    try {
      const out = execFileSync(process.execPath, [join(root, 'scripts', 'email-send-gate.mjs'), EMAIL_STANDING_RECIPIENT_FLAG], {
        input: JSON.stringify({ tool_name: 'mcp__server-gmail-autoauth-mcp__send_email', tool_input: { to: ['dani@pelda.hu'], cc: ['x@y.hu'] } }),
        cwd: join(root, 'agents', 'garagizike'),
        timeout: 15_000,
      }).toString()
      const res = JSON.parse(out)
      expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(res.hookSpecificOutput.permissionDecisionReason).toContain('nincs rajta')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('non-mail tools still pass, and a Bash send route stays denied even with the flag', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'agents', 'garagizike'), { recursive: true })
    try {
      expect(run(root, [EMAIL_STANDING_RECIPIENT_FLAG], { tool_name: 'Bash', tool_input: { command: 'git status' } })).toBeNull()
      const res = run(root, [EMAIL_STANDING_RECIPIENT_FLAG], { tool_name: 'Bash', tool_input: { command: 'echo hi | sendmail x@y.hu' } })
      expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
      expect(res.hookSpecificOutput.permissionDecisionReason).toContain('governance hard-gate')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
