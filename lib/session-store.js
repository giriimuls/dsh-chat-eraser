/**
 * dsh-chat-eraser — session store surgery.
 *
 * The harness has no deletion API at any layer: sessions can be archived, never
 * removed (`dsh-session-persistence-jsonl` states it plainly — "Nothing deletes
 * session files"). This module supplies the two things the plugin needs:
 *
 *   * `deleteSession`  removes a session's artifacts — its generation files,
 *                      its projection cache, and every reference the
 *                      host-durable Workspace registry still holds. A full
 *                      deletion is the one operation that is genuinely a
 *                      filesystem removal.
 *   * `planRewind`     works out the surface range one cut must shadow, for the
 *                      harness's own append-only rewind convention.
 *
 * A turn is never rewritten out of a live log. The Agent that owns a session
 * keeps its own in-memory copy of the events plus an open persistence write
 * handle; editing the file behind its back leaves that Agent holding a stream
 * nothing can ever answer again, which is exactly the permanent silence a
 * rewrite used to cause. Instead the cut is expressed as a `user/message` whose
 * `data.id` starts with `rewind-` and whose `surfaceOp` replaces a range of
 * surface nodes — the fold drops the shadowed nodes from the model's view, the
 * transcript hides every sequence the marker cites, and the log itself only
 * ever grows.
 *
 * Two shapes of range, one per affordance:
 *
 *   * a *turn* cut is a suffix — from the turn's prompt to the end of the log,
 *     which is what an edit-and-resend needs, since the later turns were
 *     written against a prompt that no longer exists;
 *   * a *reply* cut is bounded to the one answer it names — it starts at the
 *     turn's first answer node and stops before the `turn/end` that closes
 *     that turn, so the prompt stays, the later turns are untouched, and all
 *     that is taken is the answer itself.
 *
 * The surface fold (`dsh-session`'s `foldSurface`) replaces an arbitrary range,
 * not only a tail, so a bounded marker is a first-class citizen of the same
 * convention.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseLogName, readLog } from './log-format.js'

/** Harness home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** Root of the per-project session directories. */
export function sessionsRoot(home) {
  return join(home, 'sessions')
}

/** Root of the durable Workspace registry domain. */
export function workspaceRegistryPath(home) {
  return join(home, 'storages', 'workspace.json')
}

/** One projection cache file per session. */
export function projectionCachePath(home, sessionId) {
  return join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/** Where this plugin keeps pre-rewrite copies. Never inside the sessions root. */
export function backupRoot(home) {
  return join(home, 'chat-eraser', 'backups')
}

/** Timestamped, collision-free backup file name. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Copy one file into the plugin's own backup tree; returns the path it wrote. */
function backupFile(home, sessionId, sourcePath, label) {
  const dir = join(backupRoot(home), sessionId)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${stamp()}-${label}`)
  copyFileSync(sourcePath, target)
  return target
}

/**
 * Enumerate every session directory the persistence root currently holds.
 * @param home - harness home.
 * @returns one entry per `<project>/<sessionId>` directory.
 */
export function listSessions(home) {
  const root = sessionsRoot(home)
  const found = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let entries
    try {
      entries = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('session-')) {
        found.push({ sessionId: entry.name, project: project.name, dir: join(projectDir, entry.name) })
      }
    }
  }
  return found
}

/**
 * Pick the canonical generation of one session directory: the highest version,
 * preferring the compressed suffix when both encodings are present.
 * @param dir - session directory.
 * @returns the log descriptor, or undefined when the directory holds no log.
 */
export function canonicalLog(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const candidates = []
  for (const name of names) {
    const parsed = parseLogName(name)
    if (parsed !== undefined) candidates.push({ name, ...parsed })
  }
  if (candidates.length === 0) return undefined
  candidates.sort((left, right) => right.version - left.version || Number(right.compressed) - Number(left.compressed))
  const chosen = candidates[0]
  return {
    path: join(dir, chosen.name),
    version: chosen.version,
    compressed: chosen.compressed,
    generations: candidates.map((candidate) => candidate.name)
  }
}

/**
 * Resolve one session id to its directory and canonical log.
 * @param home - harness home.
 * @param sessionId - session id as the client knows it.
 * @returns the location record, or null when the id owns no directory.
 */
export function locateSession(home, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  for (const entry of listSessions(home)) {
    if (entry.sessionId !== sessionId) continue
    const log = canonicalLog(entry.dir)
    return { ...entry, log: log ?? null }
  }
  return null
}

/** Parsed header row of a log, or null when the first row is not a header. */
function headerOf(rows) {
  if (rows.length === 0) return null
  try {
    const value = JSON.parse(rows[0])
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Read one session's log and index its turns.
 * @param location - result of `locateSession`.
 * @returns rows, header, frame bytes, and the turn table.
 */
export function readSessionLog(location) {
  if (location === null || location.log === null) throw new Error('session log not found')
  const { rows, headerFrame } = readLog(location.log.path, location.log.compressed)
  const header = headerOf(rows)
  if (header === null || header.type !== 'session') {
    throw new Error(`${location.log.path} does not start with a session header row`)
  }
  return { rows, header, headerFrame, ...turnTable(rows) }
}

/**
 * Index turns from durable rows. `turn/start` carries the turn number the
 * transcript labels its turns with, so the turn the user is looking at maps
 * one-to-one onto this table.
 * @param rows - storage lines, header first.
 * @returns per-turn start rows, the observed turn order, and any in-flight turn.
 */
export function turnTable(rows) {
  const turns = new Map()
  const startIndex = new Map()
  const order = []
  let lastStartIndex = -1
  let lastStartTurn = null
  let lastEndIndex = -1
  let maxSeq = -1
  for (const [index, row] of rows.entries()) {
    if (index === 0) continue
    let event
    try {
      event = JSON.parse(row)
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    if (typeof event.seq === 'number') maxSeq = Math.max(maxSeq, event.seq)
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (typeof turn === 'number') {
        if (!turns.has(turn)) {
          turns.set(turn, event.seq)
          startIndex.set(turn, index)
        }
        if (!order.includes(turn)) order.push(turn)
        lastStartIndex = index
        lastStartTurn = turn
      }
    } else if (event.type === 'turn/end') {
      lastEndIndex = index
    }
  }
  // A turn whose start follows the last end is still in flight.
  const openTurn = lastStartIndex > lastEndIndex ? lastStartTurn : null
  return { turns, startIndex, turnOrder: order, openTurn, maxSeq }
}

/**
 * Delete one session permanently.
 *
 * `scrubRegistry` is the fallback for a host that could not archive the session
 * first: writing the registry file directly is only useful when nothing else
 * owns that state, because a mounted harness rewrites the file from memory and
 * would put the membership straight back.
 * @param options - home, the session id, and whether to scrub the registry file.
 * @returns what was removed and which registry rows were scrubbed.
 */
export function deleteSession({ home, sessionId, scrubRegistry = true }) {
  const location = locateSession(home, sessionId)
  const removed = []
  let runningTurn = null
  let backup = null

  if (location !== null && location.log !== null) {
    try {
      const { openTurn } = readSessionLog(location)
      runningTurn = openTurn
      backup = backupFile(home, sessionId, location.log.path, `deleted-session.v${location.log.version}${location.log.compressed ? '.jsonl.zstd' : '.jsonl'}`)
    } catch {
      // An unreadable log is still removable; the backup is simply skipped.
      backup = null
    }
  }

  if (location !== null) {
    rmSync(location.dir, { recursive: true, force: true })
    removed.push(location.dir)
  }
  const cache = projectionCachePath(home, sessionId)
  if (existsSync(cache)) {
    rmSync(cache, { force: true })
    removed.push(cache)
  }
  const workspace = scrubRegistry ? scrubWorkspaceRegistry(home, sessionId) : { changed: false, removedFrom: [], backup: null, skipped: true }
  return { sessionId, found: location !== null, removed, backup, runningTurn, workspace }
}

/**
 * Remove every host-durable reference to a session id from the Workspace
 * registry (workspace membership plus the archived and pinned sets). Without
 * this the sidebar keeps a member id that can never resolve.
 * @param home - harness home.
 * @param sessionId - session id to scrub.
 * @returns which collections changed, and the backup path when anything did.
 */
export function scrubWorkspaceRegistry(home, sessionId) {
  const path = workspaceRegistryPath(home)
  if (!existsSync(path)) return { changed: false, removedFrom: [], backup: null }
  let registry
  try {
    registry = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read the workspace registry: ${error.message}`)
  }
  const removedFrom = []
  const drop = (list, label) => {
    if (!Array.isArray(list)) return list
    const next = list.filter((id) => id !== sessionId)
    if (next.length !== list.length) removedFrom.push(label)
    return next
  }
  const global = registry.global ?? {}
  global.archivedSessionIds = drop(global.archivedSessionIds, 'global.archivedSessionIds')
  global.pinnedSessionIds = drop(global.pinnedSessionIds, 'global.pinnedSessionIds')
  registry.global = global
  const workspaces = registry.tables?.workspaces
  if (workspaces !== undefined && workspaces !== null) {
    for (const [workspaceId, record] of Object.entries(workspaces)) {
      if (record === null || typeof record !== 'object') continue
      record.sessionIds = drop(record.sessionIds, `workspace:${workspaceId}`)
    }
  }
  if (removedFrom.length === 0) return { changed: false, removedFrom, backup: null }
  const backup = backupFile(home, '_registry', path, 'workspace.json')
  const temporary = `${path}.chat-eraser.tmp`
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return { changed: true, removedFrom, backup }
}

/**
 * Event types that occupy a node of the canonical surface fold.
 *
 * These five are exactly the types the harness treats as model-visible: each
 * one must carry a `surfaceOp` marker, and the fold keeps an ordered list of
 * their sequence numbers — the "surface". A positional replace splices a range
 * of that list out, which is how the harness itself rewrites history without
 * ever editing the append-only log.
 */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** Parse one storage row, or null when it is unreadable. */
function parseRow(row) {
  try {
    const event = JSON.parse(row)
    return event !== null && typeof event === 'object' ? event : null
  } catch {
    return null
  }
}

/** Throw one coded error the route wrapper renders as a JSON refusal. */
function throwCoded(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

/** Flatten one stored message content into plain text. */
function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.map((block) => {
      if (typeof block === 'string') return block
      if (typeof block?.text === 'string') return block.text
      if (typeof block?.content === 'string') return block.content
      return ''
    })
    return parts.filter((part) => part !== '').join('\n')
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return null
}

/** Parsed events of one log, header row excluded, in sequence order. */
function eventsOf(rows) {
  const events = []
  for (const row of rows.slice(1)) {
    const event = parseRow(row)
    if (event !== null && typeof event.seq === 'number') events.push(event)
  }
  return events
}

/**
 * Replay the surface fold's node list over a parsed event list.
 *
 * Mirrors `dsh-session`'s `foldSurface` node tracking: an append pushes the
 * event's sequence number, a positional replace splices the shadowed range out
 * and inserts the replacing number in its place. Surface-eligible events in a
 * real log always carry a `surfaceOp`; a missing marker is treated as an append
 * so a hand-written fixture still folds.
 * @param events - session events in contiguous sequence order.
 * @returns the current surface node sequences, in surface order.
 */
export function foldSurfaceNodes(events) {
  const nodes = []
  for (const event of events) {
    if (!SURFACE_TYPES.has(event?.type)) continue
    const op = event.surfaceOp
    if (op === 'append' || op === undefined || op === null) {
      nodes.push(event.seq)
      continue
    }
    if (typeof op !== 'object' || Array.isArray(op)) continue
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
  }
  return nodes
}

/** Turn numbers in first-start order, with each turn's `turn/start` sequence. */
function turnIndex(events) {
  const starts = new Map()
  const order = []
  for (const event of events) {
    if (event.type !== 'turn/start') continue
    const turn = event.data?.turn
    if (typeof turn !== 'number' || starts.has(turn)) continue
    starts.set(turn, event.seq)
    order.push(turn)
  }
  return { starts, order }
}

/** The newest `turn/start` with no `turn/end` after it, or null when all closed. */
function openTurnOf(events) {
  let start = null
  let end = null
  for (const event of events) {
    if (event.type === 'turn/start') start = event
    else if (event.type === 'turn/end') end = event
  }
  return start !== null && (end === null || end.seq < start.seq) ? start.data?.turn ?? null : null
}

/**
 * Work out what one rewind must shadow.
 *
 * The harness's own rewind convention is an append-only `user/message` whose
 * `data.id` starts with `rewind-` and whose `surfaceOp` replaces a range of
 * surface nodes. Three separate layers then agree on the cut without the log
 * ever changing: the fold drops the shadowed nodes from the model's view, the
 * transcript hides the marker plus every sequence it cites, and the model
 * projector renders the marker itself to nothing.
 *
 * `sourceEventSeqs` is scoped to the same range rather than the whole tail: the
 * client's `rewindVisibleEntries` hides every sequence the marker cites, so the
 * step markers and call rows the answer is built from are hidden with it. A
 * turn cut cites the whole suffix because it removes the whole suffix; a reply
 * cut cites only its own turn's answer, which is what keeps the later turns
 * drawing exactly as they were.
 *
 * @param options - the turn, the cut mode, the events, and the current nodes.
 * @returns the marker's `startSeq`, `endSeq`, and `sourceEventSeqs`.
 */
export function planRewind({ turn, mode = 'turn', events, nodes }) {
  const openTurn = openTurnOf(events)
  if (openTurn !== null) throwCoded('turn-running', `turn ${openTurn} is still running; stop it first`)

  const { starts, order } = turnIndex(events)
  if (!starts.has(turn)) {
    throwCoded('unknown-turn', `turn ${turn} is not in this session (turns: ${order.join(', ') || 'none'})`)
  }

  const nodeIndex = new Map(nodes.map((seq, index) => [seq, index]))
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const turnStart = starts.get(turn)
  const nextTurnStart = order.indexOf(turn) >= 0 && order[order.indexOf(turn) + 1] !== undefined
    ? starts.get(order[order.indexOf(turn) + 1])
    : Infinity

  // The first storage row the cut takes: the inbox splice that queues the
  // turn's prompt sits before its `turn/start`, and dropping the splice while
  // keeping the message would leave the inbox projection pointing at rows the
  // transcript no longer shows.
  let cutFrom = turnStart
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].seq >= turnStart) continue
    if (events[index].type === 'agent/inbox/spliced') cutFrom = events[index].seq
    else break
  }

  // The turn's first prompt that is still a live surface node.
  let promptSeq = null
  for (const event of events) {
    if (event.seq < turnStart || event.seq >= nextTurnStart) continue
    if (event.type === 'turn/start' && event.seq > turnStart) break
    if (event.type !== 'user/message' || !nodeIndex.has(event.seq)) continue
    promptSeq = event.seq
    break
  }
  if (promptSeq === null) throwCoded('no-prompt', `turn ${turn} has no visible prompt to cut`)

  let from = nodeIndex.get(promptSeq)

  // A turn cut takes the turn and everything after it, so the range runs to
  // the end of the log and the cut turn stops existing. A reply cut takes one
  // turn's answer and nothing else, so its range stops at that turn's own
  // `turn/end` and later turns survive untouched.
  let cutTo = null
  let firstRemoved = turn
  if (mode === 'reply') {
    // Keep the prompt; start at the first answer node that follows it.
    let found = null
    for (let index = from + 1; index < nodes.length; index += 1) {
      const event = bySeq.get(nodes[index])
      if (event === undefined) continue
      if (event.type === 'assistant/message' || event.type === 'tool/result') {
        found = index
        break
      }
      if (event.type === 'user/message') break
    }
    if (found === null) throwCoded('no-reply', `turn ${turn} has no reply to delete`)
    from = found
    cutFrom = nodes[from]

    // The answer's own group ends before the `turn/end` that closes its turn.
    // Leaving that node outside the range keeps the turn closed, so no orphan
    // process row is left behind and the later turns are never touched.
    for (const event of events) {
      if (event.seq >= nodes[from] && event.type === 'turn/end') {
        cutTo = event.seq
        break
      }
    }
    firstRemoved = null
  }

  // The last node the range covers: the end of the log for a turn cut, the
  // node just before the turn's close for a reply cut. A reply to a turn that
  // already ends the log has nothing beyond its answer but the close, so it
  // covers exactly what it covers and the fold still holds.
  let to = nodes.length - 1
  if (cutTo !== null) {
    to = from
    while (to + 1 < nodes.length && nodes[to + 1] < cutTo) to += 1
  }
  const shadowed = nodes.slice(from, to + 1)
  if (shadowed.length === 0) throwCoded('no-reply', `turn ${turn} has nothing left to cut`)
  const endSeq = shadowed[shadowed.length - 1]

  // Every sequence inside the range: the surface range covers the model-view
  // nodes, this list covers the step and boundary scaffolding around them so
  // the transcript hides the whole cut cleanly. A reply cut cites only its own
  // group, so the turns it keeps keep their scaffolding.
  const sourceEventSeqs = events.filter((event) => event.seq >= cutFrom && event.seq <= endSeq).map((event) => event.seq)

  // A turn cut removes the prompt and its reply, so every event from the
  // prompt onward is gone: the cut turn no longer exists. A reply cut keeps
  // the prompt and every other turn, so the turn still exists with its
  // answer taken away.
  const remainingTurns = firstRemoved === null ? order : order.filter((value) => value < firstRemoved)
  const removedTurns = firstRemoved === null ? [] : order.filter((value) => value >= firstRemoved)

  return {
    turn,
    mode,
    startSeq: shadowed[0],
    endSeq,
    sourceEventSeqs,
    cutFrom,
    remainingTurns,
    removedTurns
  }
}

/**
 * The text of one turn's prompt, read from its `user/message` rows.
 * @param rows - storage lines, header first.
 * @param turn - turn to read.
 * @returns the prompt text, or null when the turn has no prompt rows.
 */
export function promptTextForTurn(rows, turn) {
  const table = turnTable(rows)
  const start = table.startIndex.get(turn)
  if (start === undefined) return null
  const parts = []
  for (let at = start; at < rows.length; at += 1) {
    const event = parseRow(rows[at])
    if (event === null) continue
    if (at > start && event.type === 'turn/start') break
    if (event.type !== 'user/message') continue
    const text = messageText(event.data?.content)
    if (text !== null && text !== '') parts.push(text)
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * What one turn offers the transcript controls: the prompt text to prefill an
 * edit, and whether there is a reply to remove.
 * @param home - harness home.
 * @param sessionId - session id.
 * @param turn - 1-based turn.
 * @returns the turn's prompt text, reply presence, and running state.
 */
export function describeTurn(home, sessionId, turn) {
  const location = locateSession(home, sessionId)
  if (location === null || location.log === null) throwCoded('session-not-found', `no session log for ${sessionId}`)
  const session = readSessionLog(location)
  if (!session.startIndex.has(turn)) {
    throwCoded('unknown-turn', `turn ${turn} is not in this session (turns: ${session.turnOrder.join(', ') || 'none'})`)
  }
  const events = eventsOf(session.rows)
  let hasReply = false
  try {
    planRewind({ turn, mode: 'reply', events, nodes: foldSurfaceNodes(events) })
    hasReply = true
  } catch (error) {
    if (error?.code !== 'no-reply' && error?.code !== 'no-prompt') throw error
  }
  return {
    sessionId,
    turn,
    prompt: promptTextForTurn(session.rows, turn),
    hasReply,
    sequenceOpen: session.openTurn
  }
}

/**
 * Drop one session's projection cache so the next open rebuilds it.
 *
 * A rewind changes the surface without changing the log's row count, so a
 * cached fold that predates the marker would replay a stale transcript on the
 * next cold start. The cache is a pure derivative of the log, so removing it is
 * always safe — it is rebuilt on demand.
 * @param home - harness home.
 * @param sessionId - session whose cache should go.
 * @returns whether a cache file was removed.
 */
export function dropProjectionCache(home, sessionId) {
  const cache = projectionCachePath(home, sessionId)
  if (!existsSync(cache)) return false
  rmSync(cache, { force: true })
  return true
}

/**
 * Read one session's transcript summary without mutating anything.
 * @param home - harness home.
 * @param sessionId - session id.
 * @returns counts and turn order, for diagnostics.
 */
export function inspectSession(home, sessionId) {
  const location = locateSession(home, sessionId)
  if (location === null || location.log === null) return { found: false, sessionId }
  const session = readSessionLog(location)
  return {
    found: true,
    sessionId,
    project: location.project,
    dir: location.dir,
    log: location.log,
    rows: session.rows.length,
    title: titleOf(session.rows),
    cwd: session.header?.cwd ?? null,
    createdAt: session.header?.createdAt ?? null,
    formatVersion: session.header?.version ?? null,
    turns: session.turnOrder,
    openTurn: session.openTurn,
    maxSeq: session.maxSeq,
    bytes: statSync(location.log.path).size
  }
}

/** Last durable `session/title` value, for diagnostics only. */
function titleOf(rows) {
  let title = null
  for (const row of rows) {
    try {
      const event = JSON.parse(row)
      if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
    } catch {
      /* ignore unparsable rows */
    }
  }
  return title
}
