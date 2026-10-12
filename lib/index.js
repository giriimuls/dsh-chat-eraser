/**
 * dsh-chat-eraser — host half.
 *
 * A plain Cordis plugin (no build step): it claims a handful of exact HTTP
 * routes on the harness web server and performs the operations the harness
 * itself has no API for. The browser half (`client/client.js`) owns every
 * affordance; this half owns the durable truth.
 *
 *   GET  /chat-eraser/status         what this plugin sees (self-check)
 *   POST /chat-eraser/delete-session { sessionId }
 *   POST /chat-eraser/delete-turn    { sessionId, turn }
 *   POST /chat-eraser/delete-reply   { sessionId, turn }
 *
 * The two turn routes do not rewrite anything. They append the harness's own
 * rewind marker — a `user/message` whose `data.id` starts with `rewind-` and
 * whose `surfaceOp` replaces a range of surface nodes. The log only grows, the
 * Agent that owns the session keeps its open persistence handle and its
 * in-memory copy in step with the file, and the next open folds the cut away.
 *
 * A turn cut replaces the suffix from the turn's prompt, which is what an
 * edit-and-resend needs. A reply cut replaces only that turn's answer, so the
 * prompt stays and the later turns are untouched (see `planRewind`).
 *
 * Routes are registered inside `ctx.inject(['webServer'], …)` so the plugin
 * also loads on a host without a web server (it then simply serves nothing),
 * and every handler answers JSON instead of throwing, so one bad request can
 * never take the host's request loop down.
 */
import { randomUUID } from 'node:crypto'
import { backupRoot, deleteSession, describeTurn, dshHome, dropProjectionCache, inspectSession, listSessions, planRewind, sessionsRoot } from './session-store.js'

/** Cordis plugin name; must match the `cordis.patch.yml` row id. */
export const name = 'chat-eraser'

/** Route prefix owned by this plugin. */
const PREFIX = '/chat-eraser'

/** Package name; also the browser module id the client bundle registers under. */
const PACKAGE = 'dsh-chat-eraser'

/** Reject oversized bodies before parsing them. */
const BODY_LIMIT_BYTES = 16 * 1024

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/** Read a small JSON request body; returns `{}` for an empty body. */
async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > BODY_LIMIT_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/** Turn number as the client labels it: a positive integer. */
function requireTurn(value) {
  const turn = typeof value === 'string' ? Number(value) : value
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
    const error = new Error('`turn` must be a positive integer')
    error.code = 'invalid-turn'
    throw error
  }
  return turn
}

/** Session id as the client labels it. */
function requireSessionId(value) {
  if (typeof value !== 'string' || value === '' || value.length > 200) {
    const error = new Error('`sessionId` must be a non-empty string')
    error.code = 'invalid-session'
    throw error
  }
  return value
}

/** Throw one coded error the route wrapper renders as a JSON refusal. */
function throwCoded(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

/**
 * Mount every route once the host web server exists.
 * @param ctx - owning Cordis context.
 * @param config - reserved for future options.
 */
export function apply(ctx, config = {}) {
  const home = dshHome()
  void config

  const routes = [
    {
      path: `${PREFIX}/status`,
      method: 'GET',
      handler: async (req, res) => {
        const sessions = listSessions(home)
        const payload = {
          ok: true,
          plugin: name,
          version: '0.1.1',
          home,
          sessionsRoot: sessionsRoot(home),
          backups: backupRoot(home),
          sessions: sessions.length,
          clientRows: clientRowsOf(ctx),
          clientBundle: clientBundleOf(ctx)
        }
        sendJson(res, 200, payload)
      }
    },
    {
      path: `${PREFIX}/delete-session`,
      method: 'POST',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const sessionId = requireSessionId(body.sessionId)
        // Order matters: stop whatever is running, take the session out of the
        // harness's live store, then archive it, and only then remove its files.
        // A session left mounted is what kept a deleted row in the sidebar and
        // made the next prompt fail with ENOENT against a log that was gone.
        const stopped = await stopActivityThroughHost(ctx, sessionId)
        const release = releaseMountedSession(ctx, sessionId)
        const archive = await archiveThroughHost(ctx, sessionId)
        const result = deleteSession({ home, sessionId, scrubRegistry: archive.archived !== true })
        sendJson(res, 200, { ok: true, action: 'delete-session', stopped, release, archive, ...result })
      }
    },
    {
      path: `${PREFIX}/delete-turn`,
      method: 'POST',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const sessionId = requireSessionId(body.sessionId)
        const turn = requireTurn(body.turn)
        sendJson(res, 200, rewindThroughHost(ctx, home, sessionId, turn, 'turn'))
      }
    },
    {
      path: `${PREFIX}/delete-reply`,
      method: 'POST',
      handler: async (req, res) => {
        const body = await readJsonBody(req)
        const sessionId = requireSessionId(body.sessionId)
        const turn = requireTurn(body.turn)
        sendJson(res, 200, rewindThroughHost(ctx, home, sessionId, turn, 'reply'))
      }
    },
    {
      path: `${PREFIX}/turn`,
      method: 'GET',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        const sessionId = requireSessionId(url.searchParams.get('sessionId') ?? '')
        const turn = requireTurn(url.searchParams.get('turn') ?? '')
        sendJson(res, 200, { ok: true, turn: describeTurn(home, sessionId, turn) })
      }
    },
    {
      path: `${PREFIX}/inspect`,
      method: 'GET',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        const sessionId = requireSessionId(url.searchParams.get('sessionId') ?? '')
        sendJson(res, 200, { ok: true, session: inspectSession(home, sessionId) })
      }
    },
    {
      path: `${PREFIX}/why`,
      method: 'GET',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        const sessionId = requireSessionId(url.searchParams.get('sessionId') ?? '')
        sendJson(res, 200, { ok: true, report: await explainListing(ctx, sessionId) })
      }
    }
  ]

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () => {
        const disposers = routes.map((route) =>
          host.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: (req, res) => {
              const fail = (error) => {
                const code = typeof error?.code === 'string' ? error.code : 'internal'
                const status = code === 'internal' ? 500 : 400
                try {
                  sendJson(res, status, { ok: false, error: { code, message: String(error?.message ?? error) } })
                } catch {
                  try {
                    res.destroy()
                  } catch {
                    /* the socket is already gone */
                  }
                }
                if (code === 'internal') {
                  try {
                    ctx.logger?.warn?.(`[chat-eraser] ${route.path}: ${String(error?.stack ?? error)}`)
                  } catch {
                    /* logging must never break the handler */
                  }
                }
              }
              try {
                if (req.method !== route.method) {
                  sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `use ${route.method}` } })
                  return
                }
                Promise.resolve(route.handler(req, res)).catch(fail)
              } catch (error) {
                fail(error)
              }
            }
          })
        )
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* a collapsed registration needs no second removal */
            }
          }
        }
      },
      'chat-eraser: http routes'
    )
  })

  try {
    ctx.logger?.info?.(`[chat-eraser] host half ready (${PREFIX})`)
  } catch {
    /* a host without a logger still loads */
  }
}

/** Package ids currently composed into the browser module graph. */
function clientRowsOf(ctx) {
  try {
    const clientModules = ctx.get?.('clientModules')
    const graph = clientModules?.graph?.()
    const entries = graph?.entries
    return Array.isArray(entries) ? entries.map((entry) => entry.id) : null
  } catch {
    return null
  }
}

/**
 * Ask the host to stop whatever is running in one session.
 *
 * The registry's own stop fan-out is the same one Archive-with-stop uses, and it
 * reports provider failures without refusing: a session that cannot be stopped
 * still has to leave the list.
 * @param ctx - owning Cordis context.
 * @param sessionId - session whose work should stop.
 * @returns whether the stop fan-out ran, and why not when it did not.
 */
async function stopActivityThroughHost(ctx, sessionId) {
  const registry = workspaceRegistryOf(ctx)
  if (registry === null || typeof registry.stopSessionActivity !== 'function') {
    return { stopped: false, reason: 'the host mounts no workspace registry' }
  }
  try {
    await registry.stopSessionActivity(sessionId)
    return { stopped: true }
  } catch (error) {
    return { stopped: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Take one session out of the harness's live session store.
 *
 * This is the step that actually removes a session: a mounted session is listed
 * from the store (`sessionQuery` adds a live row for it) and keeps its log open,
 * so a deleted session stayed in the sidebar and its next prompt failed with
 * ENOENT against the file that was gone. `detachEntered` is the store's own
 * single-shot removal — it is idempotent, removes the store entry and its
 * attachment, and emits `session/disposed` when the session was announced, which
 * is what tells the list and the query to drop their live rows.
 * @param ctx - owning Cordis context.
 * @param sessionId - session to release.
 * @returns whether a mounted session was released, and why not when it was not.
 */
function releaseMountedSession(ctx, sessionId) {
  let sessions
  try {
    sessions = ctx.get?.('sessions') ?? null
  } catch {
    return { released: false, reason: 'the session store is unavailable' }
  }
  if (
    sessions === null ||
    typeof sessions.get !== 'function' ||
    typeof sessions.liveEntryFor !== 'function' ||
    typeof sessions.detachEntered !== 'function'
  ) {
    return { released: false, reason: 'this host exposes no session store to release' }
  }
  try {
    const session = sessions.get(sessionId)
    if (session === undefined || session === null) {
      return { released: false, reason: 'the harness has not mounted this session' }
    }
    const entry = sessions.liveEntryFor(session)
    if (entry === undefined || entry === null) {
      return { released: false, reason: 'the mounted session has no live entry' }
    }
    sessions.detachEntered(entry)
    return { released: true }
  } catch (error) {
    return { released: false, reason: String(error?.message ?? error) }
  }
}

/**
 * The live Session object the harness currently holds for one id, when it holds one.
 *
 * A rewind is an append, and only a mounted Session can append: `Session.append`
 * writes through the persistence listener that is bound to the store entry, so
 * an unmounted session would take the marker into memory and never durably.
 * The caller only ever cuts a turn it is looking at, so "not mounted" here means
 * the view is detached from the host, not that the session is gone.
 * @param ctx - owning Cordis context.
 * @param sessionId - session to resolve.
 * @returns the live Session, or null when the host holds none.
 */
function liveSessionOf(ctx, sessionId) {
  let sessions
  try {
    sessions = ctx.get?.('sessions') ?? null
  } catch {
    return null
  }
  if (sessions === null || typeof sessions.get !== 'function') return null
  try {
    const session = sessions.get(sessionId)
    return session !== undefined && session !== null && typeof session.append === 'function' ? session : null
  } catch {
    return null
  }
}

/**
 * Cut one turn by appending the harness's own rewind marker.
 *
 * The marker is a `user/message` whose `data.id` starts with `rewind-`. Three
 * layers then agree on the cut without the append-only log ever changing:
 *
 *   * the surface fold replaces the shadowed node range with the marker, so the
 *     model's next request no longer contains the cut turns;
 *   * `deriveEventMessage` projects a `rewind-` message to nothing, so the
 *     marker itself never reaches the model as a prompt;
 *   * the transcript's `rewindVisibleEntries` hides the marker, the range, and
 *     every sequence the marker cites — which `planRewind` deliberately widens
 *     past the surface nodes to include the turn and step scaffolding, so an
 *     earlier cut turn cannot leave an orphan `turn/start` still rendering as a
 *     live process indicator.
 *
 * Nothing is detached and nothing is rewritten, so the Agent that owns the
 * session keeps its open persistence handle and its in-memory log in step with
 * the file. That is the whole point: a rewrite left that Agent holding a
 * detached Session and a closed writer, and every later prompt disappeared into
 * a stream nothing could answer.
 * @param ctx - owning Cordis context.
 * @param home - harness home.
 * @param sessionId - session to cut.
 * @param turn - 1-based turn the transcript labels.
 * @param mode - `turn` cuts the prompt onward; `reply` keeps the prompt.
 * @returns the cut summary the client reports.
 */
function rewindThroughHost(ctx, home, sessionId, turn, mode) {
  const live = liveSessionOf(ctx, sessionId)
  if (live === null) {
    throwCoded('session-not-live', `session ${sessionId} is not mounted; open it before cutting a turn`)
  }
  const events = live.snapshotEvents()
  const nodes = [...live.surface.nodes]
  const plan = planRewind({ turn, mode, events, nodes })
  const marker = live.append(
    'user/message',
    {
      id: `rewind-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: '' }],
      source: { kind: 'user' }
    },
    {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: plan.sourceEventSeqs
    }
  )
  // A rewind changes the surface without changing the row count, so a cached
  // fold that predates the marker would replay a stale transcript on cold start.
  const projectionCacheRemoved = dropProjectionCache(home, sessionId)
  return {
    ok: true,
    action: mode === 'reply' ? 'delete-reply' : 'delete-turn',
    sessionId,
    turn,
    mode,
    startSeq: plan.startSeq,
    endSeq: plan.endSeq,
    cutSeq: marker.seq,
    sourceEventSeqs: plan.sourceEventSeqs,
    remainingTurns: plan.remainingTurns,
    removedTurns: plan.removedTurns,
    projectionCacheRemoved
  }
}

/** The host's own Workspace registry service, when the composition mounts it. */
function workspaceRegistryOf(ctx) {
  try {
    const registry = ctx.get?.('workspaceRegistry')
    return registry !== null && typeof registry === 'object' ? registry : null
  } catch {
    return null
  }
}

/** Method names published by one service object, without walking its prototype chain blindly. */
function methodsOf(service) {
  if (service === null || service === undefined) return null
  const names = new Set()
  let node = service
  for (let depth = 0; depth < 3 && node !== null && node !== Object.prototype; depth += 1) {
    for (const name of Object.getOwnPropertyNames(node)) {
      if (name === 'constructor' || name.startsWith('_')) continue
      const value = Object.getOwnPropertyDescriptor(node, name)?.value
      if (typeof value === 'function') names.add(name)
    }
    node = Object.getPrototypeOf(node)
  }
  return [...names].sort()
}

/**
 * Explain why a session is still listed: which source (mounted session, query
 * index, or neither) still carries it, and what removal surface exists.
 * @param ctx - owning Cordis context.
 * @param sessionId - session under investigation.
 * @returns a diagnostic report.
 */
async function explainListing(ctx, sessionId) {
  const get = (name) => {
    try {
      return ctx.get?.(name) ?? null
    } catch {
      return null
    }
  }
  const sessions = get('sessions')
  const query = get('sessionQuery')
  const report = { sessionId, mounted: false, queryListed: null, services: {}, levers: {} }

  try {
    const session = sessions?.get?.(sessionId)
    report.mounted = session !== undefined && session !== null
    if (report.mounted) {
      report.sessionHeader = session.header ?? null
      report.levers.liveEntryFor = typeof sessions.liveEntryFor
      report.levers.detachEntered = typeof sessions.detachEntered
      report.levers.emitDisposed = typeof sessions.emitDisposed
      try {
        report.entry = sessions.liveEntryFor(session) === undefined ? null : 'present'
      } catch (error) {
        report.entry = `threw: ${String(error?.message ?? error)}`
      }
    }
  } catch (error) {
    report.mounted = `threw: ${String(error?.message ?? error)}`
  }

  try {
    const records = await query?.listSessions?.()
    report.queryListed = Array.isArray(records) ? records.some((record) => record?.header?.id === sessionId) : null
    report.queryCount = Array.isArray(records) ? records.length : null
  } catch (error) {
    report.queryListed = `threw: ${String(error?.message ?? error)}`
  }

  for (const name of ['sessions', 'sessionQuery', 'sessionProjections', 'sessionProjectionCache', 'agentLoop', 'agent', 'workspaceRegistry', 'storageDomain']) {
    const service = get(name)
    report.services[name] = service === null ? 'missing' : methodsOf(service)
  }
  for (const name of ['sessions', 'sessionQuery']) {
    const service = get(name)
    report.levers[name] = service === null ? 'missing' : methodsOf(service)
  }
  return report
}

/**
 * Ask the host to archive one session through its own API.
 *
 * This is the only supported way to take a session out of the sidebar while the
 * harness is running: the list a client renders comes from the host's session
 * index, which is built in memory (persisted corpus plus mounted sessions) and
 * never notices an out-of-band file removal. An archived Session leaves the
 * default "Hide archived" view immediately, and the durable archive mark is
 * inert once the log is gone — on the next start there is no stored session to
 * list, so no ghost row survives.
 * @param ctx - owning Cordis context.
 * @param sessionId - session to archive.
 * @returns whether the host accepted it, and why not when it did not.
 */
async function archiveThroughHost(ctx, sessionId) {
  const registry = workspaceRegistryOf(ctx)
  if (registry === null || typeof registry.archiveSession !== 'function') {
    return { archived: false, reason: 'the host mounts no workspace registry' }
  }
  try {
    await registry.archiveSession(sessionId)
    return { archived: true }
  } catch (error) {
    return { archived: false, reason: String(error?.message ?? error) }
  }
}

/** Absolute path of this plugin's served client bundle, when composed. */
function clientBundleOf(ctx) {
  try {
    return ctx.get?.('clientModules')?.clientPath?.(PACKAGE) ?? null
  } catch {
    return null
  }
}
