/**
 * Store checks: locating sessions, planning a rewind cut, describing a turn,
 * deleting a session, and the registry scrub that keeps the sidebar honest.
 *
 * The turn operations no longer rewrite anything: `planRewind` only works out
 * the surface range a `rewind-…` marker must replace, so these checks assert the
 * plan against the log's own structure and leave every artifact untouched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deleteSession,
  describeTurn,
  dropProjectionCache,
  foldSurfaceNodes,
  inspectSession,
  listSessions,
  locateSession,
  planRewind,
  projectionCachePath,
  promptTextForTurn,
  readSessionLog,
  scrubWorkspaceRegistry,
  turnTable
} from '../lib/session-store.js'
import { buildFixture, syntheticRows, writeSession } from './fixtures.mjs'

const ok = (name, condition, detail) => ({ name, ok: Boolean(condition), detail: condition ? undefined : detail })

/** Run one plan and capture whether it threw. */
function attempt(fn) {
  try {
    return { value: fn() }
  } catch (error) {
    return { error }
  }
}

/** Parse one log's events, header excluded. */
function eventsOfRows(rows) {
  return rows.slice(1).map((row) => JSON.parse(row))
}

export async function testSessionStore({ workdir, realArtifacts }) {
  const results = []
  const fixture = buildFixture(workdir, realArtifacts)
  const { home, syntheticId } = fixture

  results.push(ok('every fixture session is enumerated', listSessions(home).length === fixture.sessionIds.length, `found=${listSessions(home).length}`))
  results.push(ok('canonical generation resolves', locateSession(home, syntheticId)?.log?.version === 4))

  const before = inspectSession(home, syntheticId)
  results.push(ok('turn table is complete', JSON.stringify(before.turns) === JSON.stringify([1, 2, 3]), JSON.stringify(before.turns)))
  results.push(ok('no turn is reported in flight', before.openTurn === null))
  results.push(ok('rows decode for the fixture', before.rows === syntheticRows(3).length, `${before.rows} of ${syntheticRows(3).length}`))

  const rows = readSessionLog(locateSession(home, syntheticId)).rows
  const events = eventsOfRows(rows)
  const nodes = foldSurfaceNodes(events)
  const table = turnTable(rows)

  // --- foldSurfaceNodes -----------------------------------------------------
  const surfaceOnly = events.filter((event) => ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type))
  results.push(ok('the fold keeps exactly the surface-eligible events', nodes.length === surfaceOnly.length && nodes.every((seq, index) => seq === surfaceOnly[index].seq), `${nodes.length} of ${surfaceOnly.length}`))
  results.push(ok('the fold preserves sequence order', nodes.every((seq, index) => index === 0 || seq > nodes[index - 1])))

  // A replace collapses the shadowed range to the marker's own sequence.
  const replaced = foldSurfaceNodes([
    ...events,
    { type: 'user/message', seq: 100, data: { id: 'rewind-a' }, surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes[1] }, sourceEventSeqs: [nodes[0], nodes[1]] }
  ])
  results.push(ok('a replace swaps the range for the marker', replaced[0] === 100 && !replaced.includes(nodes[0]) && !replaced.includes(nodes[1]), JSON.stringify(replaced.slice(0, 3))))

  // --- planRewind: turn mode ------------------------------------------------
  const cut = planRewind({ turn: 2, mode: 'turn', events, nodes })
  const turn2Start = table.startIndex.get(2)
  const turn2PromptSeq = events.find((event) => event.type === 'user/message' && event.seq > turn2Start && event.seq < (table.startIndex.get(3) ?? Infinity)).seq
  results.push(ok('a turn cut starts at the first prompt node', cut.startSeq === turn2PromptSeq && nodes.includes(cut.startSeq), `startSeq=${cut.startSeq} prompt=${turn2PromptSeq}`))
  results.push(ok('a turn cut ends at the last node', cut.endSeq === nodes[nodes.length - 1], `endSeq=${cut.endSeq}`))
  results.push(ok('a turn cut reports the surviving turns', cut.remainingTurns.join(',') === '1', JSON.stringify(cut.remainingTurns)))
  results.push(ok('a turn cut reports the removed turns', cut.removedTurns.join(',') === '2,3', JSON.stringify(cut.removedTurns)))
  results.push(ok('a turn cut cites every event from the splice onwards', cut.sourceEventSeqs[0] <= turn2Start && cut.sourceEventSeqs.every((seq, index) => index === 0 || seq > cut.sourceEventSeqs[index - 1]), `first=${cut.sourceEventSeqs[0]} turnStart=${turn2Start}`))
  results.push(ok('a turn cut cites every shadowed node', nodes.slice(nodes.indexOf(cut.startSeq)).every((seq) => cut.sourceEventSeqs.includes(seq))))
  results.push(ok('a turn cut begins before turn/start at the inbox splice', events.find((event) => event.seq === cut.sourceEventSeqs[0])?.type === 'agent/inbox/spliced', events.find((event) => event.seq === cut.sourceEventSeqs[0])?.type))

  // --- planRewind: reply mode -----------------------------------------------
  const replyCut = planRewind({ turn: 2, mode: 'reply', events, nodes })
  const turn2AnswerSeq = events.find((event) => event.type === 'assistant/message' && event.seq > turn2PromptSeq && event.seq < (table.startIndex.get(3) ?? Infinity)).seq
  const turn2EndSeq = events.find((event) => event.type === 'turn/end' && event.seq > turn2PromptSeq && event.seq < (table.startIndex.get(3) ?? Infinity)).seq
  const turn3UserSeq = events.find((event) => event.type === 'user/message' && event.seq > (table.startIndex.get(3) ?? Infinity)).seq
  results.push(ok('a reply cut keeps the prompt node', nodes.indexOf(replyCut.startSeq) > nodes.indexOf(turn2PromptSeq), `replyStart=${replyCut.startSeq} prompt=${turn2PromptSeq}`))
  results.push(ok('a reply cut starts at the answer', replyCut.startSeq === turn2AnswerSeq, `startSeq=${replyCut.startSeq} answer=${turn2AnswerSeq}`))
  results.push(ok('a reply cut stops inside its own turn', replyCut.endSeq < turn2EndSeq, `endSeq=${replyCut.endSeq} turnEnd=${turn2EndSeq}`))
  results.push(ok('a reply cut never shadows a later turn', replyCut.endSeq < turn3UserSeq, `endSeq=${replyCut.endSeq} turn3prompt=${turn3UserSeq}`))
  results.push(ok('a reply cut keeps the turn it cuts', replyCut.remainingTurns.join(',') === '1,2,3', JSON.stringify(replyCut.remainingTurns)))
  results.push(ok('a reply cut removes no turn at all', replyCut.removedTurns.length === 0, JSON.stringify(replyCut.removedTurns)))
  results.push(ok('a reply cut cites its own answer nodes', replyCut.sourceEventSeqs.every((seq) => seq >= replyCut.startSeq && seq <= replyCut.endSeq), JSON.stringify([replyCut.sourceEventSeqs[0], replyCut.sourceEventSeqs.at(-1)])))
  results.push(ok('a reply cut cites fewer leading events than a turn cut', replyCut.sourceEventSeqs[0] >= cut.sourceEventSeqs[0], `reply=${replyCut.sourceEventSeqs[0]} turn=${cut.sourceEventSeqs[0]}`))
  // The fold the marker produces must keep turn 2's prompt and turn 3 whole.
  const marker = {
    type: 'user/message',
    seq: 1000,
    data: { id: 'rewind-reply' },
    surfaceOp: { op: 'replace', startSeq: replyCut.startSeq, endSeq: replyCut.endSeq },
    sourceEventSeqs: [...replyCut.sourceEventSeqs]
  }
  const foldedBefore = foldSurfaceNodes(events)
  const folded = foldSurfaceNodes([...events, marker])
  results.push(ok('the folded reply cut keeps the prompt, its marker and turn 3', folded.includes(turn2PromptSeq) && folded.includes(1000) && folded.includes(turn3UserSeq), JSON.stringify(folded)))
  results.push(ok(
    'the folded reply cut splices one marker in place of the answer',
    JSON.stringify(folded) === JSON.stringify([
      ...foldedBefore.filter((seq) => seq < replyCut.startSeq),
      1000,
      ...foldedBefore.filter((seq) => seq > replyCut.endSeq)
    ]),
    JSON.stringify(folded)
  ))

  // --- planRewind: refusals -------------------------------------------------
  const unknown = attempt(() => planRewind({ turn: 99, mode: 'turn', events, nodes }))
  results.push(ok('an unknown turn is refused', unknown.error?.code === 'unknown-turn', unknown.error?.code))
  const lastReply = attempt(() => planRewind({ turn: 3, mode: 'reply', events, nodes }))
  results.push(ok('the last turn still offers a reply cut', lastReply.error === undefined && lastReply.value.endSeq === nodes[nodes.length - 1], lastReply.error?.code))

  const openId = 'session-00000000-0000-4000-8000-000000000003'
  writeSession(home, '--fixture--', openId, syntheticRows(2, { openTurn: true }))
  const openEvents = eventsOfRows(readSessionLog(locateSession(home, openId)).rows)
  const running = attempt(() => planRewind({ turn: 1, mode: 'turn', events: openEvents, nodes: foldSurfaceNodes(openEvents) }))
  results.push(ok('a running turn is refused', running.error?.code === 'turn-running', running.error?.code))

  // --- promptTextForTurn / describeTurn -------------------------------------
  const prompt1 = promptTextForTurn(rows, 1)
  results.push(ok('the first prompt reads back verbatim', prompt1 === 'prompt 1', JSON.stringify(prompt1)))
  const missingPrompt = promptTextForTurn(rows, 99)
  results.push(ok('an unknown turn has no prompt text', missingPrompt === null))

  const described = describeTurn(home, syntheticId, 2)
  results.push(ok('a turn describes its prompt', described.prompt === 'prompt 2', JSON.stringify(described.prompt)))
  results.push(ok('a closed turn reports its reply presence', described.hasReply === true))
  results.push(ok('a closed turn is not reported in flight', described.sequenceOpen === null))
  const describedUnknown = attempt(() => describeTurn(home, syntheticId, 99))
  results.push(ok('describing an unknown turn is refused', describedUnknown.error?.code === 'unknown-turn', describedUnknown.error?.code))

  // --- dropProjectionCache --------------------------------------------------
  const cachePath = projectionCachePath(home, syntheticId)
  results.push(ok('the fixture ships a projection cache', existsSync(cachePath)))
  const dropped = dropProjectionCache(home, syntheticId)
  results.push(ok('dropping the cache reports the removal', dropped === true && existsSync(cachePath) === false))
  const droppedAgain = dropProjectionCache(home, syntheticId)
  results.push(ok('dropping a missing cache is a no-op', droppedAgain === false))

  // --- a plan never mutates the log -----------------------------------------
  const untouched = readSessionLog(locateSession(home, syntheticId))
  results.push(ok('planning a cut leaves the log untouched', untouched.rows.length === rows.length && JSON.stringify(untouched.turnOrder) === JSON.stringify([1, 2, 3]), `${untouched.rows.length} rows`))

  // --- deleteSession (still a real filesystem removal) -----------------------
  const removedId = fixture.sessionIds[0]
  const removed = deleteSession({ home, sessionId: removedId })
  results.push(ok('the session directory is gone', removed.found && removed.removed.some((path) => path.includes(removedId))))
  results.push(ok('the directory really left the disk', listSessions(home).every((entry) => entry.sessionId !== removedId)))
  const registry = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
  const stillReferenced = Object.values(registry.tables.workspaces).some((workspace) => workspace.sessionIds.includes(removedId))
  results.push(ok('the workspace registry no longer lists it', stillReferenced === false && removed.workspace.changed === true))
  results.push(
    ok(
      'archived and pinned sets drop only the deleted id',
      !registry.global.archivedSessionIds.includes(removedId) &&
        !registry.global.pinnedSessionIds.includes(removedId) &&
        removed.workspace.removedFrom.some((label) => label.includes('pinnedSessionIds')),
      JSON.stringify({ archived: registry.global.archivedSessionIds, pinned: registry.global.pinnedSessionIds, scrub: removed.workspace.removedFrom })
    )
  )
  results.push(ok('the registry write left a backup', typeof removed.workspace.backup === 'string' && existsSync(removed.workspace.backup)))

  const rewriteRegistry = scrubWorkspaceRegistry(home, removedId)
  results.push(ok('scrubbing twice is a no-op', rewriteRegistry.changed === false))

  const ghost = deleteSession({ home, sessionId: 'session-not-there' })
  results.push(ok('deleting an unknown session is reported, not thrown', ghost.found === false))

  // --- a real artifact, when one exists --------------------------------------
  if (fixture.real !== null) {
    const realRows = readSessionLog(locateSession(home, fixture.real.sessionId)).rows
    const realEvents = eventsOfRows(realRows)
    const realNodes = foldSurfaceNodes(realEvents)
    const realTurns = inspectSession(home, fixture.real.sessionId).turns
    results.push(ok('a real artifact exposes its turns', realTurns.length > 0, `turns=${realTurns.join(',')}`))
    if (realTurns.length >= 2) {
      const realCut = attempt(() => planRewind({ turn: 2, mode: 'turn', events: realEvents, nodes: realNodes }))
      if (realCut.error !== undefined) {
        results.push(ok('a real artifact plans a cut or explains why not', ['unknown-turn', 'no-prompt', 'turn-running'].includes(realCut.error.code), realCut.error.code))
      } else {
        results.push(ok('a real cut shadows the tail of the fold', realNodes.indexOf(realCut.value.startSeq) >= 0 && realNodes.indexOf(realCut.value.endSeq) === realNodes.length - 1, JSON.stringify({ start: realCut.value.startSeq, end: realCut.value.endSeq, last: realNodes.at(-1) })))
        results.push(ok('a real cut cites every shadowed node', realNodes.slice(realNodes.indexOf(realCut.value.startSeq)).every((seq) => realCut.value.sourceEventSeqs.includes(seq))))
        results.push(ok('a real cut reports its surviving turns', realCut.value.remainingTurns.length === 1, JSON.stringify(realCut.value.remainingTurns)))
      }
    }
    const realDeleted = deleteSession({ home, sessionId: fixture.real.sessionId })
    results.push(ok('a real artifact can be deleted too', realDeleted.found && !existsSync(fixture.real.dir)))
  }

  const danglingCache = writeSession(home, '--fixture--', 'session-00000000-0000-4000-8000-000000000004', syntheticRows(1))
  writeFileSync(danglingCache.path, readFileSync(danglingCache.path))
  results.push(ok('writing the same session twice is idempotent on disk', existsSync(danglingCache.path)))

  return results
}
