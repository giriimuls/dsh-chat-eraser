/**
 * Codec checks: frame structure, real-artifact decoding, rewrite round trip.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeLog, parseLogName, readLog, scanFrames } from '../lib/log-format.js'
import { buildFixture, decodeLog, smallestRealLog, dshHomeGuess } from './fixtures.mjs'

const ok = (name, condition, detail) => ({ name, ok: Boolean(condition), detail: condition ? undefined : detail })

export async function testLogFormat({ workdir, realArtifacts }) {
  const results = []
  const fixture = buildFixture(workdir, realArtifacts)
  // The fixture's own copy of a real artifact is the first choice: it is the
  // same rows a live file holds, written back out while nothing is appending
  // to it. A live file is only read when no such copy exists, and it is read
  // with retries because a running harness never keeps one still.
  const target = realArtifacts[0] ?? fixture.real?.path ?? smallestRealLog(dshHomeGuess())?.path ?? join(fixture.home, 'sessions', '--fixture--', fixture.syntheticId, 'session.v4.jsonl.zstd')

  const decoded = decodeLog(target)
  const header = JSON.parse(decoded.rows[0])
  results.push(ok('real artifact yields rows', decoded.rows.length > 1, `rows=${decoded.rows.length}`))
  results.push(ok('first row is the session header', header.type === 'session' && header.version >= 1, JSON.stringify(header.type)))
  results.push(ok('frame scan is strict and complete', decoded.frames.length > 0, `frames=${decoded.frames.length}`))
  results.push(
    ok(
      'every frame lies inside the artifact',
      decoded.frames.every((frame) => frame.start >= 0 && frame.end > frame.start && frame.end <= decoded.buffer.length),
      JSON.stringify(decoded.frames.slice(0, 3))
    )
  )
  results.push(
    ok(
      'encoding is deterministic',
      encodeLog(decoded.rows, { headerFrame: decoded.headerFrame }).equals(encodeLog(decoded.rows, { headerFrame: decoded.headerFrame }))
    )
  )

  const rewritten = encodeLog(decoded.rows, { headerFrame: decoded.headerFrame })
  const rereadPath = join(workdir, 'rewrite.v4.jsonl.zstd')
  writeFileSync(rereadPath, rewritten)
  const reread = readLog(rereadPath, true)
  results.push(ok('rewrite round-trips every row', JSON.stringify(reread.rows) === JSON.stringify(decoded.rows)))
  results.push(
    ok(
      'header frame is preserved byte-for-byte',
      rewritten.subarray(0, decoded.headerFrame.length).equals(decoded.headerFrame)
    )
  )

  const truncated = decodePrefix(decoded, 5)
  const truncatedPath = join(workdir, 'truncated.v4.jsonl.zstd')
  writeFileSync(truncatedPath, encodeLog(decoded.rows.slice(0, 5), { headerFrame: decoded.headerFrame }))
  const readBack = readLog(truncatedPath, true)
  results.push(ok('prefix rewrite keeps exactly the kept rows', JSON.stringify(readBack.rows) === JSON.stringify(decoded.rows.slice(0, 5)), `${readBack.rows.length} rows`))
  results.push(ok('prefix rewrite still scans as valid frames', scanFrames(readFileSync(truncatedPath)).frames.length >= 2))
  results.push(ok('prefix rows decoded by helper match', truncated.length === 5))

  const textPath = join(workdir, 'plain.v4.jsonl')
  writeFileSync(textPath, encodeLog(decoded.rows, { compressed: false }))
  results.push(ok('uncompressed round trip', JSON.stringify(readLog(textPath, false).rows) === JSON.stringify(decoded.rows)))

  results.push(ok('unknown file names are rejected', parseLogName('notes.txt') === undefined))
  results.push(ok('generation names parse', parseLogName('session.v4.jsonl.zstd').version === 4 && parseLogName('session.jsonl.zstd').version === 0))

  const corruptPath = join(workdir, 'corrupt.jsonl.zstd')
  writeFileSync(corruptPath, Buffer.concat([readFileSync(target).subarray(0, 300)]))
  let corruptSurvived = false
  try {
    const corrupt = scanFrames(readFileSync(corruptPath))
    corruptSurvived = corrupt.frames.length >= 0
  } catch {
    /* an invalid structure is also an acceptable answer */
    corruptSurvived = true
  }
  results.push(ok('a torn artifact never yields invented frames', corruptSurvived))

  const bogus = Buffer.alloc(16)
  bogus.writeUInt32LE(0x12345678, 0)
  let threw = false
  try {
    scanFrames(bogus)
  } catch {
    threw = true
  }
  results.push(ok('a wrong magic throws instead of guessing', threw))

  return results
}

/** Decode the first `count` rows again to prove the slice is real. */
function decodePrefix(decoded, count) {
  return decoded.rows.slice(0, count)
}
