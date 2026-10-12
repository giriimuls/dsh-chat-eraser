/**
 * Browser-half checks: the bundle registers under the package name, contributes
 * the expected slots, exposes working injected faces, builds its component
 * trees, calls the two host routes with the right bodies, and reports a rewrite
 * the harness did not reflect.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ok = (name, condition, detail) => ({ name, ok: Boolean(condition), detail: condition ? undefined : detail })

/** Minimal React stand-in: element trees plus the hooks the bundle uses. */
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [initial, () => {}]
  },
  memo(component) {
    return component
  }
}

const primitivesStub = {
  MenuItemButton: 'MenuItemButton',
  Tooltip: 'Tooltip',
  Modal: 'Modal',
  Button: 'Button',
  IconTrashOutlineRegular: 'IconTrashOutlineRegular'
}

/** Shared recorder for every store the bundle creates. */
const storeWrites = []
const clientStoreStub = {
  createSnapshotStore(initial) {
    let value = initial
    return {
      getSnapshot: () => value,
      set(next) {
        value = next
        storeWrites.push(next)
      },
      subscribe: () => () => {}
    }
  }
}

/**
 * Load the bundle the way the module loader does: run the script (which only
 * registers a factory) and materialize the factory with a stub `require`.
 * @returns the registration, the materialized exports, captured style tags, and
 *   the sandbox window/document the closure actually uses.
 */
function loadBundle(bundlePath) {
  const source = readFileSync(bundlePath, 'utf8')
  const styleTags = []
  const sandbox = { registrations: [] }
  sandbox.document = {
    querySelector: () => null,
    // A transcript still showing turn 7, and a session row still listed: both
    // are what an unre-read rewrite looks like from this side.
    querySelectorAll: (selector) => {
      const text = String(selector)
      if (text.includes('data-turn-tail')) return [{ dataset: { turnTail: '7' } }]
      if (text.includes('data-row-key')) return [{}]
      return []
    },
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: (tag) => styleTags.push(tag) }
  }
  sandbox.window = {
    __ModuleLoader__: { load: (registration) => sandbox.registrations.push(registration) },
    setTimeout: (fn) => {
      fn()
      return 0
    },
    location: { reload: () => {} }
  }
  const require = (specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    if (specifier === '@deepseek-ai/dsh-client-store') return clientStoreStub
    throw new Error(`unexpected module request: ${specifier}`)
  }
  const run = new Function('window', 'document', 'require', source)
  run(sandbox.window, sandbox.document, require)
  const registration = sandbox.registrations[0]
  if (registration === undefined) throw new Error('bundle registered no module')
  const exported = registration.factory(require)
  return { registration, exported, styleTags, window: sandbox.window, document: sandbox.document, storage: sandbox.storage }
}

/**
 * Recording client context: captures slot registrations and locale writes.
 * @param hooks - `onRestart` runs when a window restart is requested, so a test
 *   can model whether the rebuild actually re-rendered the transcript, and
 *   `fails` makes the stream refuse to restart, which forces the remount
 *   fallback.
 */
function makeClientCtx(hooks = {}) {
  const registered = []
  const dictionaries = []
  const reopened = []
  const restarted = []
  const binding = (sessionId) => ({
    session: {
      events: {
        restart: () => {
          if (hooks.fails?.yes === true) throw new Error('no restartable stream')
          restarted.push(sessionId)
          hooks.onRestart?.()
        }
      }
    }
  })
  const ctx = {
    effect: (fn) => fn(),
    inject: (services, callback) => {
      if (Array.isArray(services) && services.includes('uiWorkspace')) {
        callback({ uiWorkspace: { openSession: (sessionId) => reopened.push(sessionId) } })
      }
      if (Array.isArray(services) && services.includes('sessions')) {
        callback({ sessions: { binding } })
      }
      return () => {}
    },
    locale: {
      register: (namespace, dicts) => {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
      bind: (namespace) => (key, params) => (params === undefined ? `${namespace}.${key}` : `${namespace}.${key} ${JSON.stringify(params)}`)
    },
    slots: {
      inject: (name, callback) => {
        callback({ inject: () => {}, register: () => () => {} })
        return () => {}
      },
      register: (spec, component) => {
        registered.push({ spec, component })
        return () => {}
      }
    }
  }
  return { ctx, registered, dictionaries, reopened, restarted }
}

/** Flatten an element tree into a readable shape for assertions. */
function flatten(element, depth = 0) {
  if (element === null || element === undefined || depth > 6) return []
  if (Array.isArray(element)) return element.flatMap((child) => flatten(child, depth))
  if (typeof element !== 'object') return [String(element)]
  const children = [element.children ?? []].flat().flatMap((child) => flatten(child, depth + 1))
  const props = element.props ?? {}
  return [{ type: typeof element.type === 'string' ? element.type : String(element.type), props, keys: Object.keys(props) }, ...children]
}

/** React element type name of one prop, for icon assertions. */
function propType(element, key) {
  const value = element?.props?.[key]
  return value === undefined || value === null ? undefined : typeof value.type === 'string' ? value.type : undefined
}

/** Depth-first search for the first element of one host type. */
function findByType(element, type) {
  if (element === null || typeof element !== 'object') return null
  if (element.type === type) return element
  for (const child of [element.children ?? []].flat()) {
    const found = findByType(child, type)
    if (found !== null) return found
  }
  return null
}

export async function testClientBundle() {
  const results = []
  const pluginRoot = fileURLToPath(new URL('../client/client.js', import.meta.url))
  const { registration, exported, styleTags, window: sandboxWindow, document: sandboxDocument } = loadBundle(pluginRoot)

  results.push(ok('the bundle registers the package id', registration.id === 'dsh-chat-eraser', registration.id))
  results.push(ok('the module exports the client plugin face', exported.name === 'dsh-chat-eraser' && typeof exported.apply === 'function'))
  results.push(ok('it injects only shipped client services', JSON.stringify(exported.inject) === JSON.stringify(['slots', 'locale']), JSON.stringify(exported.inject)))
  results.push(ok('it injects its own stylesheet once', styleTags.length === 1 && styleTags[0].dataset.plugin === 'dsh-chat-eraser'))

  // The window restart is what actually re-reads the log, so the drawn count
  // follows it: a rebuild that re-rendered draws one answer fewer, and a window
  // that stayed stale keeps drawing all of them.
  const drawn = { count: 0 }
  const rebuilt = { yes: false }
  const restartFails = { yes: false }
  const { ctx, registered, dictionaries, reopened, restarted } = makeClientCtx({
    onRestart: () => {
      if (rebuilt.yes && drawn.count > 0) drawn.count -= 1
    },
    fails: restartFails
  })
  exported.apply(ctx)

  const names = registered.map((entry) => entry.spec.name)
  results.push(ok('it registers six contributions', registered.length === 6, names.join(' ')))
  results.push(ok('the session menu row targets the shipped ... menu', names.includes('sidebar.workspaces.session.menu.item')))
  results.push(ok('the turn control targets the shipped turn tail', names.includes('conversation.chat.turnTail')))
  results.push(ok('both dialogs target the shared overlay seat', names.filter((name) => name === 'shell.overlay').length === 3, names.join(' ')))

  const menu = registered.find((entry) => entry.spec.id === 'chat-eraser.delete-session')
  const turn = registered.find((entry) => entry.spec.id === 'chat-eraser.prompt-actions')
  const reply = registered.find((entry) => entry.spec.id === 'chat-eraser.delete-reply')
  const editOverlay = registered.find((entry) => entry.spec.id === 'chat-eraser.edit')
  const confirmOverlay = registered.find((entry) => entry.spec.id === 'chat-eraser.confirm')
  const noticeOverlay = registered.find((entry) => entry.spec.id === 'chat-eraser.notice')
  results.push(ok('the menu row lands after the shipped archive row', menu.spec.order === 500, menu.spec.order))
  results.push(ok('the prompt controls have their own id and order', turn.spec.order === 10, turn.spec.order))
  results.push(ok('the reply action sits after the shipped feedback controls', reply.spec.name === 'conversation.chat.assistant-actions' && reply.spec.order === 20, JSON.stringify(reply.spec)))
  results.push(ok('every contribution is localized', registered.every((entry) => entry.spec.locale === 'chat-eraser')))

  const menuFace = menu.spec.inject()
  results.push(ok('the menu face hands over a request callback', typeof menuFace.requestDelete === 'function'))
  const turnFace = turn.spec.inject('session-abc')
  results.push(ok('a session-scoped entry receives its session id', turnFace.sessionId === 'session-abc' && typeof turnFace.requestDelete === 'function'))
  const overlayFace = confirmOverlay.spec.inject()
  results.push(ok('the overlay face owns the request store and both callbacks', typeof overlayFace.runDelete === 'function' && typeof overlayFace.settleDelete === 'function' && overlayFace.hooks?.deleteRequest !== undefined))
  results.push(ok('the notice entry carries its own store', noticeOverlay.spec.inject().hooks?.noticeRequest !== undefined))

  results.push(ok('both dictionaries are registered', dictionaries.length === 1 && dictionaries[0].namespace === 'chat-eraser'))
  const en = Object.keys(dictionaries[0].dicts.en).sort()
  const zh = Object.keys(dictionaries[0].dicts.zh).sort()
  results.push(ok('the dictionaries cover the same keys', JSON.stringify(en) === JSON.stringify(zh), `${en.length} vs ${zh.length}`))

  const menuElement = menu.component({
    sessionId: 'session-abc',
    displayTitle: 'Fixture chat',
    useMenuOpenState: () => [false, () => {}],
    t: (key) => key,
    requestDelete: () => {}
  })
  const menuTree = flatten(menuElement)
  results.push(
    ok(
      'the menu row renders one menu item with a trash icon',
      menuTree[0].type === 'MenuItemButton' && propType(menuElement, 'icon') === 'IconTrashOutlineRegular' && menuTree[0].keys.includes('separatorBefore'),
      JSON.stringify(menuTree[0])
    )
  )
  const asked = []
  const menuElementAsking = menu.component({
    sessionId: 'session-abc',
    displayTitle: 'Fixture chat',
    useMenuOpenState: () => [true, (value) => asked.push(value)],
    t: (key) => key,
    requestDelete: (request) => asked.push(request)
  })
  menuElementAsking.props.onSelect()
  results.push(
    ok(
      'the row asks for the session it belongs to and dismisses the menu',
      JSON.stringify(asked) === JSON.stringify([false, { kind: 'session', sessionId: 'session-abc', displayTitle: 'Fixture chat' }]),
      JSON.stringify(asked)
    )
  )

  const turnTree = flatten(
    turn.component({
      turn: { turn: 4, status: 'closed', steps: [], data: {} },
      seq: 42,
      sessionId: 'session-abc',
      t: (key) => key,
      requestDelete: () => {},
      requestEdit: () => {}
    })
  )
  results.push(ok('the turn control renders a labelled button', turnTree.some((node) => node.type === 'button') && turnTree.some((node) => node.type === 'Tooltip')))
  const button = turnTree.find((node) => node.type === 'button')
  results.push(ok('the turn record currency is read as its turn number', button.props['aria-label'].includes('4'), button.props['aria-label']))
  results.push(ok('a plain numeric currency still works', flatten(turn.component({ turn: 9, sessionId: 's', t: (key) => key, requestDelete: () => {} })).some((node) => node.type === 'button')))
  results.push(ok('a running turn offers no control', turn.component({ turn: { turn: 5, status: 'open' }, sessionId: 's', t: (key) => key, requestDelete: () => {} }) === null))

  const turnRequests = []
  const turnAsking = turn.component({
    turn: { turn: 6, status: 'closed' },
    sessionId: 'session-abc',
    t: (key) => key,
    requestDelete: (request) => turnRequests.push(request),
    requestEdit: (request) => turnRequests.push(request)
  })
  flatten(turnAsking).find((node) => node.type === 'button' && String(node.props['aria-label']).startsWith('prompt.delete')).props.onClick()
  results.push(
    ok(
      'the turn control asks with the turn number and its session',
      JSON.stringify(turnRequests) === JSON.stringify([{ kind: 'prompt', sessionId: 'session-abc', turn: 6 }]),
      JSON.stringify(turnRequests)
    )
  )

  const closed = confirmOverlay.component({ useDeleteRequest: () => null, settleDelete: () => {}, runDelete: async () => ({}), t: (key) => key })
  results.push(ok('the dialog renders nothing without a request', closed === null))

  const opened = flatten(
    confirmOverlay.component({
      useDeleteRequest: () => ({ kind: 'turn', sessionId: 'session-abc', turn: 2 }),
      settleDelete: () => {},
      runDelete: async () => ({ ok: true }),
      t: (key) => key
    })
  )
  results.push(ok('a pending turn request opens the shared modal', opened[0].type === 'Modal'))
  results.push(ok('the modal carries a title, a close label and a footer', typeof opened[0].props.title === 'string' && typeof opened[0].props.closeLabel === 'string' && Array.isArray(opened[0].props.footer)))

  const sessionDialog = flatten(
    confirmOverlay.component({
      useDeleteRequest: () => ({ kind: 'session', sessionId: 'session-abc', displayTitle: 'Fixture chat' }),
      settleDelete: () => {},
      runDelete: async () => ({ ok: true }),
      t: (key) => key
    })
  )
  results.push(ok('a session request also opens the modal', sessionDialog[0].type === 'Modal'))

  results.push(ok('the notice renders nothing without a notice', noticeOverlay.component({ useNoticeRequest: () => null, dismissNotice: () => {}, t: (key) => key }) === null))
  const noticeTree = flatten(noticeOverlay.component({ useNoticeRequest: () => ({ kind: 'turn', sessionId: 's', turn: 3 }), dismissNotice: () => {}, t: (key) => key }))
  results.push(ok('a notice opens the shared modal with a close action', noticeTree[0].type === 'Modal' && noticeTree[0].props.footer.length === 1))

  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ ok: true, action: 'x', archive: { archived: true }, remainingTurns: [1, 2, 3], removedTurns: [] }) }
  }
  const reloaded = []
  sandboxWindow.setTimeout = (fn) => {
    fn()
    return 0
  }
  sandboxWindow.location = { reload: () => reloaded.push(true) }
  restarted.length = 0
  reopened.length = 0
  storeWrites.length = 0
  try {
    const turnResult = await overlayFace.runDelete({ kind: 'turn', sessionId: 'session-abc', turn: 2 })
    results.push(ok('a turn request posts to the turn route', calls.at(-1).url === '/chat-eraser/delete-turn' && JSON.parse(calls.at(-1).options.body).turn === 2, calls.at(-1).url))
    results.push(ok('the turn request is same-origin JSON', calls.at(-1).options.method === 'POST' && calls.at(-1).options.headers['content-type'] === 'application/json'))
    results.push(ok('the page is not reloaded at all', reloaded.length === 0 && turnResult.ok === true))
    results.push(ok('the mounted window is rebuilt in place', JSON.stringify(restarted) === JSON.stringify(['session-abc']), JSON.stringify(restarted)))
    results.push(ok('a restartable stream leaves the session mounted', reopened.length === 0, JSON.stringify(reopened)))
    results.push(
      ok(
        'a transcript that still shows a cut turn raises the notice in place',
        storeWrites.some((value) => value !== null && value.kind === 'turn'),
        JSON.stringify(storeWrites)
      )
    )

    // --- the reply cut is judged by the answers it removes, not the turns ----
    const originalQueryAll = sandboxDocument.querySelectorAll
    sandboxDocument.querySelectorAll = (selector) => {
      const text = String(selector)
      if (text.includes('data-chat-eraser-reply-action')) return Array.from({ length: drawn.count }, () => ({}))
      return originalQueryAll(selector)
    }
    try {
      // Three answers are on screen and the window never rebuilt: the cut is
      // durable but this page still draws everything it did before it.
      drawn.count = 3
      rebuilt.yes = false
      storeWrites.length = 0
      await overlayFace.runDelete({ kind: 'reply', sessionId: 'session-abc', turn: 2 })
      results.push(ok('a reply request posts to the reply route', calls.at(-1).url === '/chat-eraser/delete-reply' && JSON.parse(calls.at(-1).options.body).turn === 2, calls.at(-1).url))
      results.push(ok('the reply request rebuilds the window in place', JSON.stringify(restarted) === JSON.stringify(['session-abc', 'session-abc']), JSON.stringify(restarted)))
      results.push(ok('a reply that still renders every answer is reported', storeWrites.some((value) => value !== null && value.kind === 'reply'), JSON.stringify(storeWrites)))

      // The window rebuilt and drew one answer fewer: the view did re-read, so
      // there is nothing to report.
      drawn.count = 2
      rebuilt.yes = true
      storeWrites.length = 0
      await overlayFace.runDelete({ kind: 'reply', sessionId: 'session-abc', turn: 2 })
      results.push(ok('a reply the transcript no longer draws raises nothing', storeWrites.every((value) => value === null), JSON.stringify(storeWrites)))
    } finally {
      sandboxDocument.querySelectorAll = originalQueryAll
    }

    storeWrites.length = 0
    await overlayFace.runDelete({ kind: 'session', sessionId: 'session-abc' })
    results.push(ok('a session request posts to the session route', calls.at(-1).url === '/chat-eraser/delete-session' && JSON.parse(calls.at(-1).options.body).sessionId === 'session-abc'))
    results.push(ok('an archived session needs no notice', storeWrites.every((value) => value === null), JSON.stringify(storeWrites)))

    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'turn-running', message: 'stop it first' } }) })
    let failure = null
    try {
      await overlayFace.runDelete({ kind: 'turn', sessionId: 'session-abc', turn: 2 })
    } catch (error) {
      failure = error
    }
    results.push(ok('a refused delete surfaces the host code', failure !== null && failure.message.includes('turn-running'), String(failure?.message)))

    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'unknown-turn', message: 'turn 9 is not in this session' } }) })
    storeWrites.length = 0
    try {
      await overlayFace.runDelete({ kind: 'turn', sessionId: 'session-abc', turn: 9 })
    } catch {
      /* the caller shows the message; the notice is the extra signal */
    }
    results.push(
      ok(
        'a control around an already-removed turn is reported as a stale view',
        storeWrites.some((value) => value !== null && value.kind === 'turn'),
        JSON.stringify(storeWrites)
      )
    )
    // --- the edit sends through the composer it was opened with ------------
    const editCalls = []
    const inputActions = {
      setDraft: (text) => editCalls.push(['setDraft', text]),
      submit: () => editCalls.push(['submit'])
    }
    const editFace = editOverlay.spec.inject()
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ ok: true, remainingTurns: [1], removedTurns: [2, 3] }) }
    }
    rebuilt.yes = true
    restarted.length = 0
    await editFace.runEdit({ kind: 'prompt', sessionId: 'session-abc', turn: 2, inputActions }, 'edited prompt')
    results.push(
      ok(
        'an edit sends through its own composer after the window rebuild',
        JSON.stringify(restarted) === JSON.stringify(['session-abc'])
          && editCalls.some((entry) => entry[0] === 'setDraft' && entry[1] === 'edited prompt')
          && editCalls.some((entry) => entry[0] === 'submit'),
        JSON.stringify(editCalls)
      )
    )
    // Without a restartable stream the edit falls back to the remount, which is
    // what the pending draft exists for: nothing is sent through the dead
    // composer, and the session is reopened instead.
    const restartedBefore = restarted.length
    reopened.length = 0
    restartFails.yes = true
    await editFace.runEdit({ kind: 'prompt', sessionId: 'session-abc', turn: 2, inputActions: null }, 'fallback')
    results.push(
      ok(
        'an edit without a restartable stream remounts instead',
        restarted.length === restartedBefore && reopened.includes('session-abc') && editCalls.every((entry) => entry[1] !== 'fallback'),
        JSON.stringify({ restarted, reopened })
      )
    )
  } finally {
    globalThis.fetch = realFetch
  }

  return results
}
