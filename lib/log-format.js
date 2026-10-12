/**
 * dsh-chat-eraser — physical log codec.
 *
 * The shipped persistence backend (`@deepseek-ai/dsh-session-persistence-jsonl`)
 * stores one session per file as a *concatenation of independent Zstandard
 * frames*: frame 0 holds only the header line, every later frame holds one
 * durable append batch. Reading a log therefore means walking frame structure,
 * not searching for the Zstandard magic (compressed blocks may contain those
 * bytes). Writing a log means emitting the same shape: header frame first, then
 * one frame per batch of retained rows.
 *
 * `compression: 'none'` roots store the same logical lines as plain text; both
 * encodings are handled here.
 *
 * Nothing in this module touches Cordis or HTTP: it is the pure storage seam
 * and is exercised directly by the package's own checks.
 */
import { readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Little-endian read of the four Zstandard magic bytes (`28 b5 2f fd`). */
const ZSTD_MAGIC = 0xfd2fb528

/** Checksummed frames match what the backend's own writer emits. */
const CHECKSUM_OPTIONS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

/** Rows per rewritten frame; keeps frames near the backend's append batch size. */
const MAX_ROWS_PER_FRAME = 64

/** Bytes per rewritten frame; bounds one frame's decoded size. */
const MAX_BYTES_PER_FRAME = 64 * 1024

/** Canonical log filenames: `session.jsonl.zstd`, `session.v4.jsonl`, ... */
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/**
 * Decide whether a filename is a canonical session-log generation.
 * @param name - file name inside a session directory.
 * @returns the generation version and compression, or undefined for other files.
 */
export function parseLogName(name) {
  const match = LOG_NAME.exec(name)
  if (match === null) return undefined
  return { version: match[1] === undefined ? 0 : Number(match[1]), compressed: match[2] === '.zstd' }
}

/**
 * Walk the concatenated frames of one session artifact without decompressing
 * their blocks. Ported from the backend's own scanner so a false magic inside
 * compressed data can never split a frame.
 * @param buffer - complete bytes currently present in the artifact.
 * @returns complete frame ranges and an optional torn final frame start.
 * @throws {Error} when a complete frame's structure is invalid.
 */
export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  const torn = (start) => ({ frames, tornStart: start })
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5) return torn(start)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return torn(start)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return torn(start)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payload = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payload) return torn(start)
      offset += payload
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return torn(start)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Decode every row of one session artifact in order.
 * @param path - absolute artifact path.
 * @param compressed - whether the artifact holds Zstandard frames.
 * @returns the raw lines in storage order (header first) and the frame ranges.
 */
export function readLog(path, compressed) {
  const buffer = readFileSync(path)
  if (!compressed) {
    const text = buffer.toString('utf8')
    return { rows: splitLines(text), frames: [], buffer, headerFrame: undefined }
  }
  const { frames, tornStart } = scanFrames(buffer)
  // A torn tail only exists after a crash, and the backend recovers it by
  // rewriting those records. Dropping them here would lose committed events,
  // so the caller is told to repair the session (open it) instead.
  if (tornStart !== undefined) {
    throw new Error(`torn final frame at byte ${tornStart}; open the session once to let the backend repair its tail`)
  }
  const rows = []
  for (const frame of frames) {
    let decoded
    try {
      decoded = zstdDecompressSync(buffer.subarray(frame.start, frame.end))
    } catch (error) {
      throw new Error(`frame at byte ${frame.start} failed to decompress`, { cause: error })
    }
    rows.push(...splitLines(decoded.toString('utf8')))
  }
  const headerFrame = frames.length === 0 ? undefined : buffer.subarray(frames[0].start, frames[0].end)
  return { rows, frames, buffer, headerFrame }
}

/** Split one decoded chunk into non-empty storage lines. */
function splitLines(text) {
  const lines = []
  for (const line of text.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (trimmed !== '') lines.push(trimmed)
  }
  return lines
}

/**
 * Encode retained rows back into artifact bytes: the original header frame
 * byte-for-byte when available, then one checksummed frame per row batch.
 * @param rows - retained lines in order, header first.
 * @param options - `headerFrame` reuses the original first frame; `compressed` selects text output.
 * @returns the complete artifact bytes.
 */
export function encodeLog(rows, options = {}) {
  const { headerFrame, compressed = true } = options
  if (rows.length === 0) throw new Error('refusing to write a session log without its header row')
  if (!compressed) return Buffer.from(rows.join('\n') + '\n', 'utf8')

  const chunks = []
  if (headerFrame !== undefined) {
    // Frame 0 is the artifact's own header frame, kept byte-for-byte.
    chunks.push(headerFrame)
  } else {
    chunks.push(zstdCompressSync(Buffer.from(rows[0] + '\n', 'utf8'), CHECKSUM_OPTIONS))
  }

  let batch = []
  let bytes = 0
  const flush = () => {
    if (batch.length === 0) return
    chunks.push(zstdCompressSync(Buffer.from(batch.join('\n') + '\n', 'utf8'), CHECKSUM_OPTIONS))
    batch = []
    bytes = 0
  }
  for (const row of rows.slice(1)) {
    batch.push(row)
    bytes += Buffer.byteLength(row) + 1
    if (batch.length >= MAX_ROWS_PER_FRAME || bytes >= MAX_BYTES_PER_FRAME) flush()
  }
  flush()
  return Buffer.concat(chunks)
}

/**
 * Publish artifact bytes atomically: write a sibling temporary file, then move
 * it over the target. Renames over a file the host holds open succeed on
 * Windows because Node opens artifacts with delete sharing; a refused rename
 * falls back to an in-place rewrite so the operation still completes.
 * @param path - target artifact path.
 * @param bytes - complete replacement content.
 * @returns the publishing strategy that was used.
 */
export function writeLogAtomic(path, bytes) {
  const temporary = `${path}.chat-eraser.tmp`
  writeFileSync(temporary, bytes)
  try {
    renameSync(temporary, path)
    return 'rename'
  } catch {
    writeFileSync(path, bytes)
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* the temporary is cosmetic once the target is written */
    }
    return 'in-place'
  }
}

/** Size in bytes, or undefined when the file is gone. */
export function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}
