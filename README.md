# dsh-chat-eraser

Delete a whole chat session from the sidebar's `...` menu, and delete a single
turn from the transcript's turn tail. A DeepSeek Harness (dsh) plugin: the host
half performs the durable removal, the browser half owns both affordances.

```
sidebar ... menu            transcript turn tail
├── Pin session             ┌──────────────────────────────┐
├── Rename                  │  [answer of turn 17]         │
├── Fork session            │  🗑 Delete turn              │  ← this plugin
├── Archive session         └──────────────────────────────┘
└── 🗑 Delete session   ← this plugin
```

## Why a plugin is needed

The harness has no deletion API at any layer. `dsh-session-persistence-jsonl`
states it plainly — *"Nothing deletes session files"* — and the Workspace
browser documents *"sessions can be archived but never deleted"*. There is no
"delete turn" operation anywhere either: a session is an append-only JSONL log.

This plugin is therefore the outside-the-seam operator tool: it edits the same
per-session artifacts an operator would, and it does so carefully.

## Features

**Delete a session.** The sidebar row's `...` menu gains a *Delete session* row
(placed after the shipped *Archive session*, behind a separator). Confirming, in
this order:

* asks the host to **stop whatever is running in the session** (the registry's
  own stop fan-out, the same one Archive-with-stop uses),
* **takes the session out of the harness's live session store** — this is the
  step that actually removes it. A mounted session is listed from that store, so
  a session deleted out from under it kept its sidebar row *and* kept its log
  open, which is why the next prompt failed with
  `ENOENT … session.v4.jsonl.zstd`. The store's own single-shot removal is
  idempotent, drops the store entry and its attachment, and announces
  `session/disposed`, which is what makes the list and the query drop their live
  rows,
* asks the host to **archive it** through its registry API, so even a stale
  client list cannot render the row,
* removes every canonical generation in the session's directory
  (`session[.vN].jsonl[.zstd]`),
* removes its projection-cache checkpoint
  (`$DSH_HOME/storages/session_projcache/sessions/<id>.json`),
* and, when the host refused to archive it, falls back to scrubbing the
  host-durable Workspace registry
  (`$DSH_HOME/storages/workspace.json`: workspace membership plus the archived
  and pinned sets), with a timestamped copy of that file taken first.

A copy of the session log is written into this plugin's own backup tree before
anything is removed. The removal is complete: the session is gone from the
list data itself, not hidden by the archived filter, and the harness can no
longer mount it — so there is no row to open and no prompt that can fail
against a missing file.

Nothing reloads the page. The store release and the archived-state change both
reach the open page through the host's own events, so the row leaves in place;
an earlier build reloaded here, which flashed the empty New Session view and
then brought the row straight back from the harness's in-memory list.

**Delete a turn.** Every turn in the transcript carries a *Delete turn*
control. Confirming removes that turn **and every later turn** from the session
log. The log is append-only with contiguous sequence numbers, so a suffix cut is
the only sound rewrite: everything before the turn's first row is kept byte for
byte (original header frame included, sequence numbers included), and the
projection cache is dropped so the harness refolds instead of serving a
projection that is now ahead of the log.

Turns are 1-based and come straight from the durable `turn/start` events, so the
turn the transcript labels *17* is the turn the host cut. A turn that is still
running is never offered and is refused if asked for.

## Verified behaviour

| Check | Result |
|---|---|
| Menu row and per-turn control render in the real app | verified in Chromium against a live harness |
| Session deletion removes the row from the list data, mounted or not | verified: `mounted false`, `queryListed false`, row gone, still gone after a reload |
| The harness can no longer mount a deleted session | verified (`mounted false` after deleting the session it had opened) |
| Turn cut on a 621-row, 17-turn session | kept 612 rows, dropped 9, 235,023 → 119,721 bytes |
| Backups before every rewrite | written to `$DSH_HOME/chat-eraser/backups/` |
| Harness re-reads the rewritten log | after a host restart the transcript renders turns 5..16 (turn 17 gone) |
| Running turn | refused with code `turn-running` |

`node test/run.mjs` runs the package's checks: the physical codec against a real
session artifact, both deletion operations against a fixture harness home, the
HTTP surface through a stub web server, and the browser bundle through a stub
module loader.

## What the running harness does and does not see

The harness builds its session list in memory from the persisted corpus **plus
every session it has mounted**, and it never re-reads a log it already loaded.
That splits the two features:

* **A deleted session** leaves the list immediately: the deletion path archives
  it through the host's own registry API first, and nothing reloads the page.
* **A cut turn** cannot always be shown immediately: the transcript you are
  reading is served from the session the harness mounted, so it keeps showing
  the removed turn until the harness is reopened. The rewrite itself is already
  durable, and the plugin says so rather than pretending — the check runs in the
  page right after the operation and reports

  > **Already deleted** — The turn was removed from the log, but this harness
  > keeps serving the copy it mounted when it opened the session, so the
  > transcript still shows it. Closing and reopening DeepSeek Harness refreshes
  > the transcript.

  The same notice appears if a *stale* control is used — clicking delete on a
  turn the view still offers but the log no longer has answers `unknown-turn`,
  which the client reports as the stale view it is, not as a failure.

Reopening the harness loses nothing: no deletion has to be repeated.

## Uptake of a plugin's own code changes

Two halves age differently, which matters when this package is edited in place:

* the **browser half** is watched: the module graph republishes a bundle
  revision when `client/client.js` changes, so a page refresh picks it up;
* the **host half** is not: this profile runs HMR with `root: []`, which keeps
  module watching off, and Node caches an imported module for the life of the
  process. Edited `lib/*` code therefore takes effect on the next harness
  start, while configuration changes (patch layers, the profile manifest) still
  recompose live.

To run an edited host half *without* restarting the harness, point an inserted
row at a cache-busted path — a module is cached per resolved URL, so a new URL
imports fresh code — and disable the bundle row it replaces:

```yaml
# profile cordis.patch.yml, applied after every bundle layer
- id: chat-eraser
  disabled: true
- insert:
    - id: chat-eraser-live
      name: 'file:///C:/Users/<you>/.dsh/plugins/dsh-chat-eraser/lib/index.js?v=2'
```

Bump `?v=` after each `lib/*` edit; that patch file is watched, so a running
harness recomposes within a second or two. The browser half still comes from the
package (`client/client.js`), because the inserted row resolves to the same
package name. A restart returns the composition to the bundle row, so these two
entries can simply be removed then — the pre-edit copy of the file is kept
beside it as `cordis.patch.yml.bak`.

## Install

The package is a profile bundle. `scripts/install.mjs` performs the whole
install (idempotently) and needs no package manager — nothing is downloaded and
no lockfile is rewritten:

```sh
node scripts/install.mjs                # --profile desktop (default), --home <dsh home>
node scripts/install.mjs --dry-run      # print the plan
node scripts/uninstall.mjs              # reverse it
```

It

1. links the package into `<profile>/node_modules/dsh-chat-eraser`,
2. adds `"dsh-chat-eraser": "file:<relative path>"` to the profile manifest,
3. appends `dsh-chat-eraser` to `dsh.profile.bundles`,
4. backs up the profile manifest before rewriting it.

The package's own `cordis.patch.yml` then inserts the loader row. A running
harness recomposes through HMR within a few seconds (the manifest and the patch
layers are watched); a host without HMR picks the bundle up on its next start.
Reload the browser page to load the browser half.

To install by hand instead, add to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: chat-eraser
      name: dsh-chat-eraser
```

and make the specifier resolvable (the link above, or an `npm`/`pnpm add`).

## HTTP surface

Exact routes on the harness web server, same-origin only, JSON in and out.
Errors answer `{ ok: false, error: { code, message } }` and never throw into the
host's request loop.

| Route | Body | Does |
|---|---|---|
| `GET /chat-eraser/status` | — | what this plugin sees: home, session count, composed client rows, served bundle path |
| `GET /chat-eraser/inspect?sessionId=` | — | one session's turns, open turn, size, title |
| `GET /chat-eraser/why?sessionId=` | — | why a session is (still) listed: whether it is mounted, whether the query lists it, and which services and methods exist on this host |
| `POST /chat-eraser/delete-session` | `{ sessionId }` | stop, release from the live store, archive, then delete a session permanently |
| `POST /chat-eraser/delete-turn` | `{ sessionId, turn }` | cut a turn and everything after it |

Error codes: `session-not-found`, `unknown-turn`, `turn-running`, `invalid-turn`,
`invalid-session`, `method-not-allowed`, `internal`.

## Layout

```
package.json           dsh.bundle.patch + dsh.client (web)
cordis.patch.yml       the loader row this bundle inserts
lib/index.js           cordis plugin: routes, JSON envelope, error codes
lib/session-store.js   locate / delete / cut; workspace-registry scrub; backups
lib/log-format.js      Zstandard concatenated-frame codec (read, scan, encode)
client/client.js       Module Loader bundle: three slot registrations + one notice
scripts/install.mjs    idempotent bundle install
scripts/uninstall.mjs  reverse of it
test/                  four suites, no framework: node test/run.mjs
```

## Recovery

Every destructive step copies what it is about to change:

```
$DSH_HOME/chat-eraser/backups/<sessionId>/<timestamp>-<label>
$DSH_HOME/chat-eraser/backups/_registry/<timestamp>-workspace.json
```

To restore a session, put its log back as
`$DSH_HOME/sessions/<project>/<sessionId>/session.v4.jsonl.zstd` and re-add the
id to the Workspace registry (or simply start the harness and let it list the
directory). To restore a cut turn, copy the pre-cut backup over the log path and
restart the harness. A session left archived by a deletion can be unarchived
from the sidebar's *All conversations (show archived)* view; with no log behind
it, it stays out of the list either way.

## Notes for maintainers

* The session log format is a **concatenation of independent Zstandard frames**,
  first frame the header line, later frames append batches. `lib/log-format.js`
  walks frame structure (magic, descriptor, block headers, checksum) instead of
  searching for the magic, because a compressed block may contain those bytes.
  The header frame is reused byte for byte; new frames are checksummed like the
  backend's own writer.
* The cut point is the `turn/start` row **plus the `agent/inbox/spliced` rows
  immediately before it** — those queue the turn's user message, and keeping
  them while dropping the message would leave the inbox projection pointing at
  events that no longer exist.
* The projection cache must be deleted on a cut. Its record is matched by
  lifecycle identity (`formatVersion`, `createdAt`, `cwd`, `isSeeded`), not by
  the log's revision, so a cache left in place would serve a projection from
  before the cut — ahead of the log it is supposed to summarise. A missing
  record reads as absent and the harness refolds, which is the correct answer;
  the sidebar title returns as soon as the harness writes the next checkpoint.
* A torn final frame rejects the rewrite instead of silently dropping committed
  events; open the session once so the backend repairs its tail, then retry.
