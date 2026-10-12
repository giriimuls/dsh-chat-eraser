/**
 * Fixture harness home: real session artifacts when the machine has any, plus
 * a synthetic session whose turn structure the checks can reason about exactly.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { encodeLog, readLog, writeLogAtomic } from '../lib/log-format.js'

/** The harness home this machine is running with. */
export function dshHomeGuess() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** One synchronous beat, so a read that raced a live write can be retried. */
function rest(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Decode one session artifact, retrying while a live backend write is
 * mid-frame. A running harness appends to its logs continuously, so a read
 * that lands inside a flush can see a half-written frame. The artifact is not
 * the subject of these checks, so a bounded retry is enough.
 * @param path - artifact to decode.
 * @returns the decoded rows and frames of a clean read.
 * @throws the last failure when the artifact stays unreadable.
 */
export function decodeLog(path) {
  let last = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return readLog(path, true)
    } catch (error) {
      last = error
      rest(60)
    }
  }
  throw last
}

/**
 * Artifacts considered as the fixture's real session.
 *
 * A running harness writes its session logs continuously and creates or
 * removes directories underneath the sessions root while it runs, so both the
 * walk and the decode can fail underneath the reader, and a very large live
 * artifact costs more to hold than the checks need. Neither is the subject of
 * the checks: unreadable or vanished candidates are skipped, and the size cap
 * keeps the fixture light.
 */
const MAX_REAL_ARTIFACT_BYTES = 1500 * 1024

/** Every real session artifact under a harness home, smallest first. */
export function realLogCandidates(home, { requireTurns = false } = {}) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const found = []
  const collect = (dir, sessionId, project) => {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl.zstd')) continue
      const path = join(dir, name)
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        continue
      }
      if (size === 0 || size > MAX_REAL_ARTIFACT_BYTES) continue
      if (requireTurns) {
        let rows
        try {
          rows = decodeLog(path).rows
        } catch {
          continue
        }
        if (!rows.some((row) => row.includes('"turn/start"'))) continue
        // A session whose newest turn is still open cannot be cut, so it makes
        // a poor fixture — the live harness's own running session is exactly
        // that, and it is often the smallest artifact on the machine.
        if (hasOpenTurn(rows)) continue
      }
      found.push({ path, size, sessionId, project })
    }
  }
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(projectDir, session.name)
      try {
        collect(dir, session.name, project.name)
      } catch {
        /* the session directory went away while the harness was running */
      }
    }
  }
  return found.sort((left, right) => left.size - right.size)
}

/** Smallest real session artifact under a harness home, when one exists. */
export function smallestRealLog(home, options = {}) {
  return realLogCandidates(home, options)[0] ?? null
}

/** Whether the newest `turn/start` has no matching `turn/end` after it. */
function hasOpenTurn(rows) {
  let lastStart = -1
  let lastEnd = -1
  for (const [index, row] of rows.entries()) {
    if (row.includes('"turn/start"')) lastStart = index
    else if (row.includes('"turn/end"')) lastEnd = index
  }
  return lastStart > lastEnd
}

/**
 * Build rows for a synthetic session: settings, then `turns` complete turns.
 * Turn N's message group starts at its inbox splice, exactly as a real log does.
 * @param turns - number of complete turns.
 * @param options - `openTurn` appends a turn whose `turn/end` is missing.
 */
export function syntheticRows(turns, options = {}) {
  const header = {
    type: 'session',
    version: 4,
    id: 'session-00000000-0000-4000-8000-000000000001',
    createdAt: 1_700_000_000_000,
    cwd: 'C:\\fixture',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard'
  }
  const rows = [JSON.stringify(header)]
  let seq = 0
  const push = (type, data) => {
    rows.push(JSON.stringify({ type, seq: seq++, time: 1_700_000_000_000 + seq, data }))
  }
  push('permission/preset', { preset: 'danger-full-access' })
  push('sandbox/mode', { mode: 'danger-full-access' })
  push('approval/policy', { policy: 'never' })
  push('model/selection', { provider: 'deepseek-account', model: 'deepseek-flash' })
  for (let turn = 1; turn <= turns; turn += 1) {
    push('agent/inbox/spliced', { target: 'inbox', start: 0, inserted: [{ role: 'user' }] })
    push('turn/start', { turn })
    push('agent/inbox/spliced', { target: 'inbox', start: 0, removedCount: 1, inserted: [] })
    push('step/start', { turn, step: 1 })
    push('user/message', { content: `prompt ${turn}`, source: 'user', role: 'user', id: `m-${turn}` })
    push('assistant/message', { turn, step: 1, message: { role: 'assistant' }, usage: null, stream: 'complete' })
    push('tool/call', { turn, step: 1, callId: `c-${turn}`, name: 'pwsh', arguments: '{}' })
    push('tool/result', { turn, step: 1, message: {}, meta: {} })
    push('step/end', { turn, step: 1 })
    if (turn < turns || options.openTurn !== true) push('turn/end', { turn, reason: { kind: 'complete' } })
  }
  return rows
}

/** Write one encoded artifact into a fixture session directory. */
export function writeSession(home, project, sessionId, rows, compressed = true) {
  const dir = join(home, 'sessions', project, sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl')
  writeFileSync(path, encodeLog(rows, { compressed }))
  return { dir, path }
}

/** Workspace registry referencing both fixture sessions. */
export function writeWorkspaceRegistry(home, sessionIds) {
  const path = join(home, 'storages', 'workspace.json')
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [sessionIds[1]], pinnedSessionIds: [sessionIds[0]], defaultWorkspaceId: 'w1' },
        tables: {
          workspaces: {
            w1: { path: 'C:\\fixture', title: 'fixture', sessionIds: [...sessionIds], createdAt: 'x', updatedAt: 'y' }
          }
        }
      },
      null,
      2
    )}\n`
  )
  return path
}

/** Projection cache file for one session. */
export function writeProjectionCache(home, sessionId) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sessionId}.json`)
  writeFileSync(path, '{"projection":true}\n')
  return path
}

/**
 * Choose the artifact the fixture copies as its real session.
 *
 * Both halves of the choice can go wrong underneath the reader. A candidate
 * may fail to decode, because a running harness is still writing it, and a
 * candidate may decode to a session with no turns at all — a just-opened one
 * holds only its setup rows, and it is often the smallest artifact on the
 * machine, so a walk that ranks by size walks straight into it. The checks
 * that reason about a real artifact assert on its turns, so a candidate is
 * accepted only when it both decodes and holds one, and when none does the
 * fixture simply ships no real session (which those checks already allow for).
 *
 * @param home - harness home to search.
 * @param realArtifacts - optional artifact paths passed on the command line.
 * @returns `{ path, rows }` for the chosen artifact, or null.
 */
function pickRealTurnLog(home, realArtifacts = []) {
  const accept = (path) => {
    if (typeof path !== 'string' || !existsSync(path)) return null
    try {
      const { rows, headerFrame } = decodeLog(path)
      return rows.some((row) => row.includes('"turn/start"')) ? { path, rows, headerFrame } : null
    } catch {
      return null
    }
  }
  if (realArtifacts.length > 0) return accept(realArtifacts[0])
  // Turnful and already closed first, since a real cut then plans without
  // complaining; any other turnful artifact is still better than none.
  for (const options of [{ requireTurns: true }, {}]) {
    for (const candidate of realLogCandidates(home, options)) {
      const picked = accept(candidate.path)
      if (picked !== null) return picked
    }
  }
  return null
}

/**
 * Assemble a fixture harness home: one real artifact copy (when available) and
 * one synthetic session, both registered in the workspace registry.
 * @param workdir - suite working directory.
 * @param realArtifacts - optional artifact paths passed on the command line.
 * @returns fixture facts the checks assert against.
 */
export function buildFixture(workdir, realArtifacts = []) {
  const home = join(workdir, 'home')
  const syntheticId = 'session-00000000-0000-4000-8000-000000000001'
  const syntheticRowsValue = syntheticRows(3)
  writeSession(home, '--fixture--', syntheticId, syntheticRowsValue)
  writeProjectionCache(home, syntheticId)

  const picked = pickRealTurnLog(dshHomeGuess(), realArtifacts)
  let real = null
  if (picked !== null) {
    const realId = 'session-00000000-0000-4000-8000-000000000002'
    const dir = join(home, 'sessions', '--real--', realId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.v4.jsonl.zstd')
    // The artifact's bytes are written back out from the rows that just
    // decoded, rather than copied: the source file is being appended to
    // underneath the reader, and a byte-for-byte copy of a half-written frame
    // hands the fixture a log no reader can open.
    writeLogAtomic(path, encodeLog(picked.rows, { headerFrame: picked.headerFrame }))
    real = { sessionId: realId, dir, path, rows: picked.rows, source: picked.path }
    writeProjectionCache(home, realId)
  }

  const ids = real === null ? [syntheticId] : [syntheticId, real.sessionId]
  writeWorkspaceRegistry(home, ids)
  return { home, syntheticId, syntheticRows: syntheticRowsValue, real, sessionIds: ids }
}
