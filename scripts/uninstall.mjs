/**
 * dsh-chat-eraser — uninstaller.
 *
 * Reverses `install.mjs`: removes the bundle from the profile manifest, drops
 * the dependency entry, and removes the module link. Session data the plugin
 * already rewrote is never touched, and the plugin's own backup folder is left
 * in place so a uninstall cannot delete the only copy of an original log.
 *
 * Usage: node scripts/uninstall.mjs [--profile desktop] [--home <dsh home>] [--dry-run]
 */
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name

const argv = process.argv.slice(2)
const options = { profile: 'desktop', home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), dryRun: false }
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]
  if (flag === '--dry-run') options.dryRun = true
  else if (flag === '--profile') options.profile = argv[++index]
  else if (flag === '--home') options.home = argv[++index]
  else throw new Error(`unknown argument: ${flag}`)
}

const profileDir = join(resolve(options.home), 'profiles', options.profile)
const profileManifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', packageName)
const profile = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
const steps = []

if (Array.isArray(profile.dsh?.profile?.bundles) && profile.dsh.profile.bundles.includes(packageName)) {
  profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((entry) => entry !== packageName)
  steps.push(`bundle removed (${profile.dsh.profile.bundles.length} remain)`)
}
if (profile.dependencies?.[packageName] !== undefined) {
  delete profile.dependencies[packageName]
  steps.push('dependency entry removed')
}
if (steps.length > 0 && !options.dryRun) {
  writeFileSync(profileManifestPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
}

const existing = (() => {
  try {
    return lstatSync(linkPath)
  } catch {
    return null
  }
})()
if (existing !== null && existing.isSymbolicLink()) {
  steps.push(`link removed: ${linkPath}`)
  if (!options.dryRun) rmSync(linkPath, { recursive: true, force: true })
}

console.log(`${packageName} <- profile "${options.profile}"`)
if (steps.length === 0) console.log('  nothing to undo')
for (const step of steps) console.log(`  ${step}`)
console.log(options.dryRun ? '\ndry run: nothing was written' : '\nremoved from the composition. The package directory and its backups are untouched.')
