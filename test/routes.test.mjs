/**
 * HTTP surface checks: the plugin mounts its routes, answers JSON, refuses bad
 * input with a code, appends a rewind marker through a live session, and
 * degrades to a no-op host without a web server.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { readLog } from '../lib/log-format.js'
import { foldSurfaceNodes } from '../lib/session-store.js'
import { buildFixture } from './fixtures.mjs'

const ok = (name, condition, detail) => ({ name, ok: Boolean(condition), detail: condition ? undefined : detail })

/** A Session stand-in with just the surface a rewind append touches. */
function makeLiveSession(sessionId, events) {
  const appended = []
  const nodes = foldSurfaceNodes(events)
  return {
    id: sessionId,
    appended,
    surface: { nodes },
    snapshotEvents: () => events,
    append(type, data, opts) {
      appended.push({ type, data, opts })
      return { seq: events.length, type, data, ...opts }
    }
  }
}

/** Recording Cordis stand-in with just the surface `apply` touches. */
function makeCtx({ withWebServer = true, registry: providedRegistry, mounted = null, live = null } = {}) {
  const archived = []
  const stopped = []
  const detached = []
  const registry = providedRegistry === null ? null : (providedRegistry ?? {
    async archiveSession(sessionId) {
      archived.push(sessionId)
    },
    async stopSessionActivity(sessionId) {
      stopped.push(sessionId)
    }
  })
  const sessions = mounted === null && live === null
    ? null
    : {
        get: (sessionId) => {
          if (live !== null && sessionId === live.id) return live
          if (mounted !== null && sessionId === mounted.id) return { id: sessionId }
          return undefined
        },
        liveEntryFor: (session) => ({ id: session.id }),
        detachEntered: (entry) => {
          detached.push(entry.id)
        }
      }
  const result = buildCtx({ withWebServer, registry, sessions })
  return { ...result, archived, stopped, detached }
}

/** The route-table capture, parameterized by the injected services. */
function buildCtx({ withWebServer, registry, sessions = null }) {
  const routes = []
  const disposers = []
  let injected = false
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'clientModules') {
        return { graph: () => ({ entries: [{ id: 'dsh-chat-eraser' }] }), clientPath: () => 'C:\\plugin\\client.js' }
      }
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessions') return sessions
      return undefined
    },
    inject: (services, callback) => {
      if (Array.isArray(services) && services.includes('webServer') && withWebServer) {
        injected = true
        callback({
          effect: (fn) => {
            const dispose = fn()
            if (typeof dispose === 'function') disposers.push(dispose)
          },
          webServer: {
            register: (route) => {
              routes.push(route)
              return () => {
                const index = routes.indexOf(route)
                if (index >= 0) routes.splice(index, 1)
              }
            }
          }
        })
      }
    }
  }
  return { ctx, routes, disposers, injected: () => injected }
}

/** One request stand-in: a method, a URL, and an optional JSON body. */
function makeRequest(method, url, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    }
  }
}

/** One response stand-in whose `done` settles when the handler ends it. */
function makeResponse() {
  let settle
  const done = new Promise((resolve) => {
    settle = resolve
  })
  const state = { status: 0, headers: null, body: null }
  const response = {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body
      settle(state)
    },
    destroy() {
      settle(state)
    }
  }
  return { response, state, done }
}

/** Invoke one route and parse its JSON answer. */
async function call(routes, method, path, body) {
  const target = path.split('?')[0]
  const route = routes.find((candidate) => candidate.path === target)
  if (route === undefined) throw new Error(`route not mounted: ${target}`)
  const { response, state, done } = makeResponse()
  route.handler(makeRequest(method, path, body), response)
  await done
  let json = null
  try {
    json = JSON.parse(state.body)
  } catch {
    json = null
  }
  return { state, json }
}

export async function testRoutes({ workdir, realArtifacts }) {
  const results = []
  const fixture = buildFixture(workdir, realArtifacts)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = fixture.home

  // The synthetic session, as events a live Session would report.
  const logPath = join(fixture.home, 'sessions', '--fixture--', fixture.syntheticId, 'session.v4.jsonl.zstd')
  const events = readLog(logPath, true).rows.slice(1).map((row) => JSON.parse(row))
  const live = makeLiveSession(fixture.syntheticId, events)

  const { ctx, routes, disposers, injected, archived, stopped, detached } = makeCtx({ mounted: { id: 'session-mounted' }, live })
  let threw = null
  try {
    apply(ctx, {})
  } catch (error) {
    threw = error
  }
  results.push(ok('apply never throws', threw === null, String(threw)))
  results.push(ok('routes mount through the webServer injection', injected() && routes.length === 7, `routes=${routes.length}`))
  results.push(
    ok(
      'every route is an exact path under the plugin prefix',
      routes.every((route) => route.kind === 'exact' && route.path.startsWith('/chat-eraser/')),
      routes.map((route) => route.path).join(' ')
    )
  )

  const status = await call(routes, 'GET', '/chat-eraser/status')
  results.push(ok('status answers 200 JSON', status.state.status === 200 && status.json?.ok === true, String(status.state.status)))
  results.push(ok('status reports the session root', status.json.sessionsRoot === join(fixture.home, 'sessions')))
  results.push(ok('status counts sessions', status.json.sessions === fixture.sessionIds.length, String(status.json.sessions)))
  results.push(ok('status reports the composed client rows', Array.isArray(status.json.clientRows) && status.json.clientRows.includes('dsh-chat-eraser')))
  results.push(ok('status reports the served bundle path', status.json.clientBundle === 'C:\\plugin\\client.js'))

  const wrongMethod = await call(routes, 'GET', '/chat-eraser/delete-turn')
  results.push(ok('a wrong method answers 405', wrongMethod.state.status === 405 && wrongMethod.json?.error?.code === 'method-not-allowed'))

  const badTurn = await call(routes, 'POST', '/chat-eraser/delete-turn', { sessionId: fixture.syntheticId, turn: 0 })
  results.push(ok('turn 0 is rejected', badTurn.state.status === 400 && badTurn.json?.error?.code === 'invalid-turn', JSON.stringify(badTurn.json)))

  const noSession = await call(routes, 'POST', '/chat-eraser/delete-turn', { sessionId: 'session-missing', turn: 1 })
  results.push(ok('an unmounted session answers a coded 400', noSession.state.status === 400 && noSession.json?.error?.code === 'session-not-live', noSession.json?.error?.code))

  const badBody = await call(routes, 'POST', '/chat-eraser/delete-session', { sessionId: 7 })
  results.push(ok('a non-string session id is rejected', badBody.state.status === 400 && badBody.json?.error?.code === 'invalid-session'))

  // --- the turn cut appends a rewind marker ---------------------------------
  const turnCut = await call(routes, 'POST', '/chat-eraser/delete-turn', { sessionId: fixture.syntheticId, turn: 3 })
  results.push(ok('deleting a turn answers ok', turnCut.state.status === 200 && turnCut.json?.ok === true, JSON.stringify(turnCut.json?.error)))
  results.push(ok('the turn cut names the session and the turn', turnCut.json.sessionId === fixture.syntheticId && turnCut.json.turn === 3))
  results.push(ok('the turn cut reports the replacement range', typeof turnCut.json.startSeq === 'number' && typeof turnCut.json.endSeq === 'number' && turnCut.json.startSeq <= turnCut.json.endSeq, JSON.stringify({ start: turnCut.json.startSeq, end: turnCut.json.endSeq })))
  results.push(ok('the turn cut cites the source sequences', Array.isArray(turnCut.json.sourceEventSeqs) && turnCut.json.sourceEventSeqs.length > 0 && turnCut.json.sourceEventSeqs.every((seq) => typeof seq === 'number')))
  results.push(ok('the turn cut reports the surviving turns', JSON.stringify(turnCut.json.remainingTurns) === JSON.stringify([1, 2]), JSON.stringify(turnCut.json.remainingTurns)))
  results.push(ok('the turn cut reports the removed turns', JSON.stringify(turnCut.json.removedTurns) === JSON.stringify([3]), JSON.stringify(turnCut.json.removedTurns)))

  const marker = live.appended.at(-1)
  results.push(ok('the cut appended exactly one marker', live.appended.length === 1 && marker.type === 'user/message', JSON.stringify(live.appended.map((entry) => entry.type))))
  results.push(ok('the marker carries a rewind- identity', typeof marker.data?.id === 'string' && marker.data.id.startsWith('rewind-'), marker.data?.id))
  results.push(ok('the marker replaces the planned range', marker.opts?.surfaceOp?.op === 'replace' && marker.opts.surfaceOp.startSeq === turnCut.json.startSeq && marker.opts.surfaceOp.endSeq === turnCut.json.endSeq, JSON.stringify(marker.opts)))
  results.push(ok('the marker cites the planned sources', JSON.stringify(marker.opts?.sourceEventSeqs) === JSON.stringify(turnCut.json.sourceEventSeqs)))

  // The plan's own consistency: folding the marker swaps the shadowed tail out.
  const nodesBefore = foldSurfaceNodes(events)
  const nodesAfter = foldSurfaceNodes([...events, { type: 'user/message', seq: events.length, data: marker.data, ...marker.opts }])
  const shadowed = nodesBefore.slice(nodesBefore.indexOf(turnCut.json.startSeq))
  results.push(
    ok(
      'the fold swaps the shadowed tail for the marker',
      nodesAfter.at(-1) === events.length && shadowed.every((seq) => !nodesAfter.includes(seq)),
      JSON.stringify({ before: nodesBefore.length, after: nodesAfter.length, shadowed: shadowed.length })
    )
  )

  const inspected = await call(routes, 'GET', `/chat-eraser/inspect?sessionId=${fixture.syntheticId}`)
  results.push(ok('inspect still reports every turn in the log', JSON.stringify(inspected.json?.session?.turns) === JSON.stringify([1, 2, 3]), JSON.stringify(inspected.json?.session?.turns)))
  results.push(ok('inspect reports the appended event count', inspected.json?.session?.rows === events.length + 1, `${inspected.json?.session?.rows} of ${events.length + 1}`))

  // --- the reply cut takes one answer, not the turns after it ----------------
  // Turn 2 of the synthetic fixture: prompt 18, answer 19, tool result 21,
  // its own turn/end 23, and turn 3's prompt 28.
  const turn2Answer = events.find((event) => event.type === 'assistant/message' && event.seq > 18 && event.seq < 23)
  const turn2ToolResult = events.find((event) => event.type === 'tool/result' && event.seq > 18 && event.seq < 23)
  const turn3Prompt = events.find((event) => event.type === 'user/message' && event.seq > 23)
  const replyCut = await call(routes, 'POST', '/chat-eraser/delete-reply', { sessionId: fixture.syntheticId, turn: 2 })
  results.push(ok('deleting a reply answers ok', replyCut.state.status === 200 && replyCut.json?.ok === true, JSON.stringify(replyCut.json?.error)))
  results.push(ok('the reply cut starts at the answer', replyCut.json.startSeq === turn2Answer.seq, `${replyCut.json.startSeq} != ${turn2Answer.seq}`))
  results.push(ok('the reply cut stops inside its own turn', replyCut.json.endSeq === turn2ToolResult.seq && replyCut.json.endSeq < replyCut.json.startSeq + 4, JSON.stringify({ start: replyCut.json.startSeq, end: replyCut.json.endSeq })))
  results.push(ok('the reply cut names its mode', replyCut.json.mode === 'reply' && replyCut.json.action === 'delete-reply'))
  results.push(ok('the reply cut keeps every turn', JSON.stringify(replyCut.json.remainingTurns) === JSON.stringify([1, 2, 3]), JSON.stringify(replyCut.json.remainingTurns)))
  results.push(ok('the reply cut removes no turn at all', JSON.stringify(replyCut.json.removedTurns) === JSON.stringify([]), JSON.stringify(replyCut.json.removedTurns)))

  const replyMarker = live.appended.at(-1)
  results.push(ok('the reply cut appended its own marker', live.appended.length === 2 && replyMarker.data.id.startsWith('rewind-'), String(replyMarker.data?.id)))
  results.push(ok('the reply cut cites nothing from a later turn', replyCut.json.sourceEventSeqs.every((seq) => seq >= turn2Answer.seq && seq <= turn2ToolResult.seq), JSON.stringify([replyCut.json.sourceEventSeqs[0], replyCut.json.sourceEventSeqs.at(-1)])))

  // The plan's own consistency: the fold keeps turn 2's prompt and all of turn 3.
  const replyNodesBefore = foldSurfaceNodes(events)
  const replyNodesAfter = foldSurfaceNodes([...events, { type: 'user/message', seq: events.length, data: replyMarker.data, ...replyMarker.opts }])
  results.push(
    ok(
      'the reply fold keeps the prompt and the later turns',
      replyNodesAfter.includes(18) && replyNodesAfter.includes(turn3Prompt.seq) && !replyNodesAfter.includes(turn2Answer.seq),
      JSON.stringify(replyNodesAfter)
    )
  )
  results.push(
    ok(
      'the reply fold splices exactly one marker',
      replyNodesAfter.length === replyNodesBefore.length - (replyNodesBefore.indexOf(turn2ToolResult.seq) - replyNodesBefore.indexOf(turn2Answer.seq) + 1) + 1,
      JSON.stringify({ before: replyNodesBefore.length, after: replyNodesAfter.length })
    )
  )

  // --- session deletion is still a filesystem removal ------------------------
  // A dedicated id keeps this independent of which sessions the live stub holds.
  const unmountedId = 'session-00000000-0000-4000-8000-00000000feed'
  const removed = await call(routes, 'POST', '/chat-eraser/delete-session', { sessionId: unmountedId })
  results.push(ok('deleting a session answers ok', removed.state.status === 200 && removed.json?.ok === true, JSON.stringify(removed.json?.error)))
  results.push(ok('the host was asked to stop the session first', stopped.includes(unmountedId) && removed.json.stopped.stopped === true, JSON.stringify(removed.json.stopped)))
  results.push(ok('the host was asked to archive it', archived.includes(unmountedId) && removed.json.archive.archived === true, JSON.stringify(removed.json.archive)))
  results.push(ok('an unmounted session reports no release', removed.json.release.released === false, JSON.stringify(removed.json.release)))
  results.push(ok('deleting a session that was never on disk is reported', removed.json.found === false, JSON.stringify(removed.json)))

  const mountedDelete = await call(routes, 'POST', '/chat-eraser/delete-session', { sessionId: 'session-mounted' })
  results.push(ok('a mounted session is released from the live store', mountedDelete.json.release.released === true && detached.includes('session-mounted'), JSON.stringify({ release: mountedDelete.json.release, detached })))
  results.push(ok('the release runs before the files are touched', mountedDelete.json.stopped.stopped === true && mountedDelete.json.found === false, JSON.stringify(mountedDelete.json)))

  // The registry still lists the untouched fixture sessions; deleting a
  // never-registered id leaves it alone.
  const registry = JSON.parse(readFileSync(join(fixture.home, 'storages', 'workspace.json'), 'utf8'))
  results.push(
    ok(
      'a never-registered id leaves the registry untouched',
      registry.tables.workspaces.w1.sessionIds.includes(fixture.sessionIds.at(-1)) && removed.json.workspace.skipped === true,
      JSON.stringify(removed.json.workspace)
    )
  )

  // A host whose archive call is refused still gets the file-level fallback.
  const refusing = makeCtx({
    registry: {
      async archiveSession() {
        throw new Error('session is active')
      }
    }
  })
  apply(refusing.ctx, {})
  const fallback = await call(refusing.routes, 'POST', '/chat-eraser/delete-session', { sessionId: fixture.syntheticId })
  const scrubbed = JSON.parse(readFileSync(join(fixture.home, 'storages', 'workspace.json'), 'utf8'))
  results.push(ok('a refused archive falls back to scrubbing the registry file', fallback.json.archive.archived === false && fallback.json.workspace.changed === true, JSON.stringify(fallback.json)))
  results.push(ok('the fallback removed the membership', !scrubbed.tables.workspaces.w1.sessionIds.includes(fixture.syntheticId)))

  // A host without a registry service is a supported degradation.
  const bare2 = makeCtx({ registry: null })
  apply(bare2.ctx, {})
  const noRegistry = await call(bare2.routes, 'POST', '/chat-eraser/delete-session', { sessionId: 'session-none' })
  results.push(ok('a host without a registry still answers', noRegistry.state.status === 200 && noRegistry.json.archive.archived === false, JSON.stringify(noRegistry.json)))

  const before = routes.length
  for (const dispose of disposers) dispose()
  results.push(ok('disposal unmounts every route', routes.length === 0 && before === 7, `before=${before} after=${routes.length}`))

  const bare = makeCtx({ withWebServer: false })
  let bareThrew = null
  try {
    apply(bare.ctx, {})
  } catch (error) {
    bareThrew = error
  }
  results.push(ok('a host without a web server still loads', bareThrew === null && bare.routes.length === 0))

  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  return results
}
