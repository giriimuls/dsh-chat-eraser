// Probe: shape of one user prompt's content, and the row order inside a turn.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const rows = []
let start = 0
while (start < buf.length) {
  const next = buf.indexOf(MAGIC, start + 4)
  const end = next === -1 ? buf.length : next
  try {
    rows.push(...zstdDecompressSync(buf.subarray(start, end)).toString('utf8').split('\n').filter(Boolean))
  } catch {
    /* torn frame */
  }
  start = end
}
const events = rows.map((row) => {
  try {
    return JSON.parse(row)
  } catch {
    return null
  }
})

for (const event of events) {
  if (event?.type !== 'user/message') continue
  const content = event.data?.content
  const kind = Array.isArray(content) ? 'array' : typeof content
  console.log('user content kind:', kind, Array.isArray(content) ? `blocks=${content.length} blockKeys=${Object.keys(content[0] ?? {}).join(',')}` : '')
  if (typeof content === 'string') console.log('  length:', content.length)
  else if (Array.isArray(content)) {
    const first = content[0] ?? {}
    for (const key of ['text', 'content', 'type', 'value']) {
      if (first[key] !== undefined) console.log(`  first.${key}: ${typeof first[key]}`)
    }
  }
  console.log('  data keys:', Object.keys(event.data ?? {}).join(','))
  break
}

// Row order inside one turn.
const thirdTurn = events.findIndex((event) => event?.type === 'turn/start' && event.data?.turn === 3)
if (thirdTurn >= 0) {
  const slice = events.slice(thirdTurn, thirdTurn + 8).map((event) => `${event.type}${event.data?.turn !== undefined ? `(t${event.data.turn}` : ''}${event.data?.step !== undefined ? `,s${event.data.step})` : event.data?.turn !== undefined ? ')' : ''}`)
  console.log('turn 3 rows:', slice.join(' -> '))
}
