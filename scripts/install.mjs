/**
 * dsh-chat-eraser — installer.
 *
 * Registers the plugin as a profile bundle, the way an installed plugin is
 * registered:
 *
 *   1. link the package into the profile's `node_modules` so the bundle
 *      specifier resolves (no package manager involved — nothing is downloaded
 *      and no lockfile is rewritten),
 *   2. add the dependency and append the bundle to `dsh.profile.bundles` in the
 *      profile manifest,
 *   3. leave the profile manifest and the user patch layer backed up beside
 *      themselves.
 *
 * HMR watches the profile manifest, so a running host recomposes by itself; a
 * host without HMR picks the bundle up on its next start.
 *
 * Usage: node scripts/install.mjs [--profile desktop] [--home <dsh home>] [--dry-run]
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const packageName = manifest.name

/** Parse `--flag value` pairs; unknown flags are reported rather than ignored. */
function parseArgs(argv) {
  const options = { profile: 'desktop', home: process.env.DSH_HOME ?? join(homedir(), '.dsh'), dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--profile') options.profile = argv[++index]
    else if (flag === '--home') options.home = argv[++index]
    else throw new Error(`unknown argument: ${flag}`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const profileDir = join(resolve(options.home), 'profiles', options.profile)
const profileManifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', packageName)

if (!existsSync(profileManifestPath)) {
  console.error(`no profile manifest at ${profileManifestPath}`)
  process.exit(1)
}

const steps = []
const profile = JSON.parse(readFileSync(profileManifestPath, 'utf8'))

// 1. Module resolution: one directory link stands in for the installed package.
mkdirSync(dirname(linkPath), { recursive: true })
const existing = lstatOrNull(linkPath)
if (existing === null) {
  steps.push(`link ${linkPath} -> ${packageRoot}`)
  if (!options.dryRun) symlinkSync(packageRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
} else if (existing.isSymbolicLink()) {
  steps.push(`link already present at ${linkPath}`)
} else {
  steps.push(`a real directory already exists at ${linkPath}; leaving it untouched`)
}

// 2. Manifest: dependency plus ordered bundle list.
const spec = `file:${relative(profileDir, packageRoot).replace(/\\/g, '/')}`
profile.dependencies ??= {}
const previousSpec = profile.dependencies[packageName]
profile.dependencies[packageName] = spec
profile.dsh ??= {}
profile.dsh.profile ??= {}
const bundles = Array.isArray(profile.dsh.profile.bundles) ? profile.dsh.profile.bundles : []
const alreadySelected = bundles.includes(packageName)
if (!alreadySelected) bundles.push(packageName)
profile.dsh.profile.bundles = bundles

steps.push(
  previousSpec === undefined
    ? `dependency ${packageName}: ${spec}`
    : `dependency ${packageName}: ${previousSpec} -> ${spec}`
)
steps.push(alreadySelected ? `bundle already selected (position ${bundles.indexOf(packageName) + 1})` : `bundle added at position ${bundles.length}`)

if (!options.dryRun) {
  if (previousSpec === undefined || !alreadySelected) {
    backup(profileManifestPath)
    writeFileSync(profileManifestPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  }
}

console.log(`${packageName} -> profile "${options.profile}" (${profileDir})`)
for (const step of steps) console.log(`  ${step}`)
console.log(options.dryRun ? '\ndry run: nothing was written' : '\ninstalled. The running host recomposes through HMR; reload the page to pick up the browser half.')

/** `lstat` without throwing: null when the path does not exist. */
function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** Keep one timestamped copy of a file this script rewrites. */
function backup(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${path}.chat-eraser-${stamp}.bak`
  writeFileSync(target, readFileSync(path))
  console.log(`  backup: ${target}`)
}
