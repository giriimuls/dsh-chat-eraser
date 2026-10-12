// Repair a file whose UTF-8 bytes were round-tripped through Latin-1 by a shell.
// Usage: node scripts/repair-utf8.mjs <path> [--check]
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
const check = process.argv.includes('--check')
const buf = readFileSync(path)

try {
  buf.toString('utf8')
  // Strict decode: Buffer.toString never throws, so look for replacement chars.
  if (!buf.toString('utf8').includes('\uFFFD')) {
    console.log('already valid UTF-8 (no replacement characters)')
    process.exit(0)
  }
} catch {
  /* fall through to repair */
}

const text = buf.toString('utf8')
const bytes = Buffer.from([...text].map((character) => character.codePointAt(0) & 0xff))
const repaired = bytes.toString('utf8')
const bad = [...repaired].filter((character) => character === '\uFFFD').length
console.log('repair attempt: replacement characters =', bad, 'bytes', buf.length, '->', bytes.length)
if (bad > 0) {
  console.log('repair did not produce clean text; leaving the file untouched')
  process.exit(1)
}
if (check) {
  console.log('sample:', JSON.stringify(repaired.slice(0, 60)))
  process.exit(0)
}
writeFileSync(path, repaired)
console.log('repaired', path)
