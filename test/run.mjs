/**
 * dsh-chat-eraser — checks.
 *
 * Four suites, no framework: they exercise the physical codec against real
 * session artifacts, the two deletion operations against a fixture harness
 * home, the HTTP surface through a stub web server, and the browser bundle
 * through a stub module loader.
 *
 * Usage: node test/run.mjs [path-to-a-real-session-artifact]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testLogFormat } from './log-format.test.mjs'
import { testSessionStore } from './session-store.test.mjs'
import { testRoutes } from './routes.test.mjs'
import { testClientBundle } from './client-bundle.test.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-chat-eraser-test-'))
const suites = [testLogFormat, testSessionStore, testRoutes, testClientBundle]
let failed = 0

for (const suite of suites) {
  const workdir = mkdtempSync(join(root, 'suite-'))
  try {
    const results = await suite({ workdir, realArtifacts: process.argv.slice(2) })
    for (const result of results) {
      const mark = result.ok ? 'ok  ' : 'FAIL'
      if (!result.ok) failed += 1
      console.log(`${mark} ${suite.name.replace(/^test/, '').toLowerCase()} :: ${result.name}${result.detail === undefined ? '' : ` — ${result.detail}`}`)
    }
  } catch (error) {
    failed += 1
    console.log(`FAIL ${suite.name} threw: ${error?.stack ?? error}`)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
