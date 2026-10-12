/**
 * dsh-chat-eraser — browser half.
 * cache-bust 2026-10-09T17:25:00Z
 *
 * A Module Loader bundle (`window.__ModuleLoader__.load({ id, factory })`), the
 * same shape every shipped client plugin uses: running the script only
 * registers the factory, and the module body runs at materialization. It
 * requires only baseline externals — React, the shared control primitives, and
 * the shared snapshot store — so it needs no `dsh.client.external` entry.
 *
 * It contributes six registrations:
 *
 *   sidebar.workspaces.session.menu.item  "Delete session" row in the ... menu
 *   conversation.chat.turnTail            per-turn delete / edit of the prompt
 *   conversation.chat.assistant-actions   delete this reply
 *   shell.overlay                         the confirm, edit and notice dialogs
 *
 * A pen icon is also painted into every user message's own action row (the row
 * that already holds the shipped copy button). No shipped slot exists there:
 * `UserMessageNodeView` renders `MessageIconActions` without `extraActions`,
 * so the icon is inserted into the live DOM and re-asserted by a MutationObserver.
 *
 * A session deletion is the only destructive cut: the host archives and
 * releases it, and this page drops its main reference so the next open rebuilds
 * against nothing, refreshes the list, and clears the `removed` flag the
 * released binding latches — the InputBar reads that flag to disable the
 * composer, so a session the plugin released stays permanently mute otherwise.
 *
 * A turn cut never rewrites the log. The host appends the harness's own rewind
 * marker (`rewind-…` + a `surfaceOp.replace` over the turn's node range), which
 * the fold already hides from the model. The transcript hides the cut through
 * the marker's `sourceEventSeqs`, but only runs that pass inside a full-window
 * rebuild — so this half forces one after every cut, with the live stream's own
 * `restart()`: the stream re-opens, the window is re-folded with the marker
 * already in it, and the reply that was cut stops being drawn. No scope is
 * released, so the Agent keeps its live Session, its open persistence handle,
 * an append-only log, and a composer that is still alive for the next prompt.
 *
 * A reply cut is bounded to that one answer: the range stops at the turn's own
 * `turn/end`, so the prompt stays, the later turns are untouched, and what
 * disappears is the answer alone. A turn cut is a suffix — that turn and
 * everything after it, which is what an edit-and-resend needs.
 *
 * An edit sends through the composer it was opened with, since that composer
 * survives a window restart. Only a session without a restartable stream falls
 * back to remounting, and then the draft is handed to the replacement composer
 * through `pendingDraft`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-eraser',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const store = require('@deepseek-ai/dsh-client-store')

    const h = React.createElement
    const NS = 'chat-eraser'

    /** The hook surface, resolved once: the test harness substitutes a lean React. */
    const useEffect = typeof React.useEffect === 'function' ? React.useEffect : () => {}

    /** User-facing copy. Keys are flat so both dictionaries stay comparable. */
    const en = {
      'menu.deleteSession': 'Delete session',
      'prompt.edit': 'Edit prompt',
      'prompt.delete': 'Delete prompt',
      'reply.delete': 'Delete reply',
      'edit.title': 'Edit prompt {turn}',
      'edit.body':
        'Sending replaces this prompt: its reply and everything after it are cut from the transcript and from what the model sees, and your text is sent straight away so a fresh reply is generated.',
      'edit.send': 'Send',
      'edit.busy': 'Replacing...',
      'edit.done': 'Replaced',
      'dialog.session.title': 'Delete this session?',
      'dialog.session.body':
        'The session is removed from disk: its log, its projection cache and its sidebar membership. This cannot be undone from the app.',
      'dialog.prompt.title': 'Delete prompt {turn}?',
      'dialog.prompt.body':
        'This prompt, its reply and every later turn are removed from the transcript and from what the model sees. Earlier turns are kept. Nothing is overwritten — the log keeps its full history and the cut is reversible by the harness itself.',
      'dialog.reply.title': 'Delete this reply?',
      'dialog.reply.body':
        'Only this reply is taken out: the prompt above it and every turn after it stay. The conversation’s last reply takes its prompt with it, because Harness’s transcript drops the turn whose reply is gone.',
      'dialog.turn.title': 'Delete this turn?',
      'dialog.turn.body':
        'This turn and everything after it are taken out; the turns before it stay. The log itself is never rewritten, so the full history is still there.',
      'dialog.confirm': 'Delete',
      'dialog.cancel': 'Cancel',
      'dialog.busy': 'Deleting...',
      'dialog.done': 'Deleted',
      'dialog.error': 'Delete failed: {message}',
      'notice.title': 'Already deleted',
      'notice.session.body':
        'The removal is durable, but this harness still holds the session in memory, so it is still listed. Closing and reopening DeepSeek Harness refreshes the list.',
      'notice.turn.body':
        'The turn was cut from the log, but this harness still shows the copy it mounted before the cut. Closing and reopening DeepSeek Harness refreshes the transcript.',
      'notice.reply.body':
        'The answer was cut from the log, but this harness still shows the copy it mounted before the cut. Closing and reopening DeepSeek Harness refreshes the transcript.',
      'notice.close': 'Understood'
    }
    const zh = {
      'menu.deleteSession': '删除会话',
      'prompt.edit': '编辑提问',
      'prompt.delete': '删除提问',
      'reply.delete': '删除回答',
      'edit.title': '编辑第 {turn} 轮提问',
      'edit.body': '发送会替换这条提问：这一轮及之后的内容都会从对话和模型可见的上下文中移除，并立刻把编辑后的文本发送出去，从而生成新的回答。',
      'edit.send': '发送',
      'edit.busy': '替换中…',
      'edit.done': '已替换',
      'dialog.session.title': '确定删除这个会话？',
      'dialog.session.body': '将从磁盘移除该会话：日志、投影缓存以及侧边栏成员关系都会被删除。应用内无法撤销。',
      'dialog.prompt.title': '确定删除第 {turn} 轮提问？',
      'dialog.prompt.body': '这一轮提问、它的回答以及之后的所有轮次都会从对话和模型可见的上下文中移除，之前的轮次保留。日志本身不会被改写，完整历史仍然保留。',
      'dialog.reply.title': '确定删除这条回答？',
      'dialog.reply.body': '只移除这条回答：它上面的提问和之后的轮次都会保留。删除对话中最后一条回答时，那一轮的提问会一起消失，因为 Harness 的对话视图会连同失去回答的轮次一起收起。日志本身不会被改写，完整历史仍然保留。',
      'dialog.turn.title': '确定删除这一轮？',
      'dialog.turn.body': '这一轮及之后的所有内容都会从对话和模型可见的上下文中移除，之前的轮次保留。日志本身不会被改写，完整历史仍然保留。',
      'dialog.confirm': '删除',
      'dialog.cancel': '取消',
      'dialog.busy': '删除中…',
      'dialog.done': '已删除',
      'dialog.error': '删除失败：{message}',
      'notice.title': '已经从磁盘删除',
      'notice.session.body': '删除已经落盘，但当前 Harness 进程仍把该会话保存在内存里，所以列表里还看得到。关闭并重新打开 DeepSeek Harness 即可刷新列表。',
      'notice.turn.body': '这一轮已经从日志中剪除，但当前 Harness 仍在返回它剪除前载入的那份副本。关闭并重新打开 DeepSeek Harness 即可刷新对话。',
      'notice.reply.body': '这条回答已经从日志中剪除，但当前 Harness 仍在返回它剪除前载入的那份副本。关闭并重新打开 DeepSeek Harness 即可刷新对话。',
      'notice.close': '我知道了'
    }

    /** Shared styles, injected once per page through the plugin's own style tag. */
    const CSS = [
      '.chat-eraser-turn{display:flex;align-items:center;gap:2px;min-height:24px}',
      '.chat-eraser-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;box-sizing:border-box;border:none;background:transparent;border-radius:6px;cursor:pointer;padding:0;opacity:.65;color:var(--dsw-alias-icon-secondary,#6b7280);transition:opacity .12s ease,background .12s ease}',
      '.chat-eraser-action:hover{opacity:1;background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12))}',
      '.chat-eraser-action:focus-visible{opacity:1;outline:2px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.4));outline-offset:2px}',
      '.chat-eraser-action svg{flex:none;width:16px;height:16px}',
      '.chat-eraser-body{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#4a4a4a)}',
      '.chat-eraser-error{margin:8px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-error,#d93025)}',
      '.chat-eraser-editor{display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:8px 10px;font:inherit;font-size:13px;line-height:20px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-separator-primary,rgba(127,127,127,.4));border-radius:8px;resize:vertical}',
      '.chat-eraser-editor:focus-visible{outline:none;border-color:var(--dsw-alias-border-accent,#3b82f6)}'
    ].join('')

    if (typeof document !== 'undefined') {
      const tagId = 'dsh-chat-eraser/styles.css'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-chat-eraser'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
    }

    /**
     * The pending confirmation. One dialog serves both deletions: the request
     * carries which one it is, so nothing else has to be kept in sync.
     */
    const deleteRequest = store.createSnapshotStore(null)

    /** Open the confirmation dialog for one deletion request. */
    function requestDelete(request) {
      deleteRequest.set(request)
    }

    /** Close the dialog without acting. */
    function settleDelete() {
      deleteRequest.set(null)
    }

    /** The post-operation message, when a removal did not reach this page. */
    const noticeRequest = store.createSnapshotStore(null)

    /** The workspace's own navigation object layer, once the plugin resolves it. */
    let workspaceUi = null

    /** The session list service, once the plugin resolves it. */
    let sessionsApi = null

    /** The plugin context, kept so the list service can also be resolved lazily. */
    let pluginCtx = null

    /** The session list service, resolved on first use when the inject ran early. */
    function sessionList() {
      if (sessionsApi !== null) return sessionsApi
      try {
        sessionsApi = pluginCtx?.get?.('sessions') ?? null
      } catch {
        sessionsApi = null
      }
      return sessionsApi
    }

    /** Translator bound to this plugin's namespace, for the injected pen icons. */
    let translate = (key) => key

    /** The Session currently drawn in the main view, as the occupants see it. */
    let currentSessionId = null

    /** The composer action face of that Session, handed over by the turn tail. */
    let currentInputActions = null

    /** One short beat, on the page's own timer. */
    function wait(ms) {
      return new Promise((resolve) => {
        window.setTimeout(resolve, ms)
      })
    }

    /**
     * The prompt an edit is about to hand back to the composer when no window
     * restart was available: the session had to be remounted, which retires the
     * composer's shell, so the replacement shell arrives with the freshly
     * mounted turn tails instead, and the first one to render picks this up,
     * writes the draft and sends it.
     */
    const pendingDraft = { sessionId: null, text: null, send: false }

    /**
     * Clear the harness's `removed` flag on one Session binding.
     *
     * `api-session/removed` is relayed by `handleSessionRemoved` into
     * `session.removed = true`, and nothing in the harness ever sets it back:
     * the shipped InputBar reads it to disable the composer
     * (`dsh-client-ui-conversation`, `const disabled = removed || ...`), so a
     * session the plugin released stays permanently mute. The flag lives on the
     * resident Session instance, and its snapshot is rebuilt from the field, so
     * clearing the field and marking the notifier dirty re-enables the bar.
     * @param sessionId - session whose binding should accept input again.
     * @returns whether a flag was actually cleared.
     */
    function reviveSession(sessionId) {
      const list = sessionList()
      if (typeof list?.binding !== 'function') return false
      let session
      try {
        session = list.binding(sessionId)?.session
      } catch {
        return false
      }
      if (session === undefined || session === null || session.removed !== true) return false
      session.removed = false
      try {
        session.notifier?.markDirty?.()
      } catch {
        /* the next host relay rebuilds the snapshot anyway */
      }
      return true
    }

    /**
     * Keep the flag cleared for a few seconds after a cut.
     *
     * Retiring the old binding closes its host stream, and the host answers
     * that by disposing the session — which raises `session/disposed` and
     * therefore `api-session/removed` again, this time against the binding that
     * was just rebuilt. Watching for a handful of seconds covers that late
     * relay without holding on to anything afterwards.
     * @param sessionId - session that was just remounted.
     */
    function armRevive(sessionId) {
      reviveSession(sessionId)
      if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return
      const clearInterval = typeof window.clearInterval === 'function' ? window.clearInterval : null
      let ticks = 0
      const timer = window.setInterval(() => {
        reviveSession(sessionId)
        ticks += 1
        if (ticks >= 24 && clearInterval !== null) clearInterval(timer)
      }, 250)
    }

    /**
     * Force the mounted transcript to re-read the log, in place.
     *
     * A cut is an appended marker, and the live stream reports appends as
     * `append` — the transcript's window grows, it never rebuilds. The window
     * is only rebuilt from a `replace`, which is exactly what forcing a stream
     * restart produces: the stream re-opens, re-sends its snapshot with the
     * marker already in it, and the window (marker plus every sequence it
     * cites) is re-folded from scratch. The Harness itself makes this call to
     * recover from a re-baselined assistant stream
     * (`dsh-api-session-controller`, `events.restart()`).
     *
     * Nothing is released, so the scope survives, the composer keeps its
     * session and the User's draft stays where it is. That is the point: a
     * release-and-reopen only rebuilds when it happens not to be outlived by
     * another view that is still holding the session open, and in the meantime
     * the window on screen is still the stale one.
     * @param sessionId - session whose window should be rebuilt.
     * @returns true when the stream itself accepted the restart.
     */
    function restartSessionWindow(sessionId) {
      const binding = sessionList()?.binding?.(sessionId)
      const events = binding?.session?.events
      if (events === undefined || events === null || typeof events.restart !== 'function') return false
      try {
        events.restart()
        return true
      } catch {
        return false
      }
    }

    /**
     * Bring the view back onto the rewritten log.
     *
     * A cut is appended without releasing anything, so in the common case the
     * session is still mounted and a window restart is enough
     * ({@link restartSessionWindow}). The release-and-reopen path stays as the
     * fallback for the compositions that do not expose a restartable stream:
     * the host answers after releasing, the sidebar row is refreshed so the
     * session can be addressed at all, and the session is opened again, which
     * remounts it from the rewritten file. {@link armRevive} keeps the
     * `removed` flag cleared while the host finishes tearing the retired
     * binding down.
     * @param sessionId - session that the host half just cut.
     */
    async function reopenSession(sessionId) {
      if (restartSessionWindow(sessionId)) {
        armRevive(sessionId)
        return
      }
      const ui = workspaceUi
      const list = sessionList()
      // The host answers after releasing, but the removal relay can still be
      // in flight; one beat keeps the refresh from racing it.
      await wait(200)
      try {
        ui?.clearMain?.()
      } catch {
        /* a composition without a main view still benefits from the refresh */
      }
      try {
        await list?.refresh?.()
      } catch {
        /* the sidebar is the reader's fallback either way */
      }
      const show = () => {
        try {
          ui?.openSession?.(sessionId)
          return true
        } catch {
          return false
        }
      }
      if (show()) {
        armRevive(sessionId)
        return
      }
      try {
        await list?.refresh?.()
      } catch {
        /* nothing further to try */
      }
      if (show()) armRevive(sessionId)
    }

    /**
     * Ask the host half to delete, then close the loop in place: a session
     * removal is judged from the sidebar, a cut by reopening the session.
     * @param request - the pending deletion request.
     * @returns the host's summary.
     */
    async function runDelete(request) {
      const path = request.kind === 'session'
        ? '/chat-eraser/delete-session'
        : request.kind === 'reply' ? '/chat-eraser/delete-reply' : '/chat-eraser/delete-turn'
      const body = request.kind === 'session'
        ? { sessionId: request.sessionId }
        : { sessionId: request.sessionId, turn: request.turn }
      // A reply cut keeps every turn, so the turn tallies cannot show the cut.
      // What has to change is how many answers are drawn, and that is read off
      // the plugin's own reply controls, counted before the cut is sent.
      const repliesBefore = request.kind === 'reply' ? countRenderedReplies() : null
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        const code = payload?.error?.code ?? `http-${response.status}`
        const message = payload?.error?.message ?? response.statusText ?? 'request failed'
        // The view offered something the log does not have: a mounted harness is
        // serving an older copy of this session, which is a stale view around a
        // removal that already happened — not a failure of this one.
        if (code === 'unknown-turn' || code === 'session-not-found' || code === 'no-reply') {
          noticeRequest.set({ kind: request.kind, sessionId: request.sessionId, turn: request.turn ?? null })
        }
        throw new Error(`${code}: ${message}`)
      }
      if (request.kind !== 'session') await reopenSession(request.sessionId)
      reportUnreflected(request, payload, repliesBefore)
      return payload
    }

    /**
     * How many answers are currently drawn in the transcript.
     *
     * Every rendered answer carries the plugin's own reply control, so the
     * number of those controls is the number of answers on screen — the
     * plugin's own marker counted in the Harness's own rendering.
     * @returns the reply controls currently in the document, or null when there
     *   is no document to count them in.
     */
    function countRenderedReplies() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null
      return document.querySelectorAll('[data-chat-eraser-reply-action]').length
    }

    /**
     * Close the loop in this page: say so when the removal is durable but the
     * harness kept serving what it had already loaded.
     * @param request - the deletion that just succeeded.
     * @param payload - the host's answer, including the archive and release results.
     * @param repliesBefore - answers on screen before a reply cut, else null.
     */
    function reportUnreflected(request, payload, repliesBefore = null) {
      window.setTimeout(() => {
        try {
          if (!isUnreflected(request, payload, repliesBefore)) return
          noticeRequest.set({ kind: request.kind, sessionId: request.sessionId, turn: request.turn ?? null })
        } catch {
          /* reporting is best-effort and never blocks the app */
        }
      }, 900)
    }

    /**
     * Whether this page still shows something the removal already took away.
     * @param request - the deletion that was answered.
     * @param payload - the host's answer.
     * @param repliesBefore - answers on screen before a reply cut, else null.
     * @returns true when the page is demonstrably serving the pre-cut copy.
     */
    function isUnreflected(request, payload, repliesBefore = null) {
      if (typeof request?.sessionId !== 'string') return false
      if (request.kind === 'session') {
        // A session is archived and released through the host on the way out;
        // only a refusal leaves the row behind.
        if (payload?.archive?.archived === true) return false
        return document.querySelectorAll(`[data-row-key="session:${request.sessionId}"]`).length > 0
      }
      if (request.kind === 'reply') {
        // A reply cut keeps every turn, so a turn that still renders proves
        // nothing. The answer it took has to stop rendering instead.
        if (!Number.isInteger(repliesBefore)) return false
        return countRenderedReplies() >= repliesBefore
      }
      const tails = [...document.querySelectorAll('[data-turn-tail]')]
      if (tails.length === 0) return false
      // The host reports which turns survive the cut, so a transcript that
      // renders a later turn than that is demonstrably serving the old copy.
      const remaining = Array.isArray(payload?.remainingTurns) ? payload.remainingTurns : null
      const last = remaining === null || remaining.length === 0
        ? (typeof request.turn === 'number' ? request.turn - 1 : null)
        : Math.max(...remaining)
      if (last === null) return false
      const highest = Math.max(...tails.map((node) => Number(node.dataset.turnTail)))
      return Number.isFinite(highest) && highest > last
    }

    /** The pending prompt edit, with the text the dialog is prefilled with. */
    const editRequest = store.createSnapshotStore(null)

    /**
     * Open the edit dialog for one turn, prefilled with that turn's prompt.
     * The prompt text comes from the log, so what the reader edits is what was
     * actually sent, not the rendered projection of it.
     * @param request - session, turn, and (when the caller had one) the composer.
     */
    async function requestEdit(request) {
      const query = `sessionId=${encodeURIComponent(request.sessionId)}&turn=${request.turn}`
      try {
        const response = await fetch(`/chat-eraser/turn?${query}`, { cache: 'no-store' })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true) {
          throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
        }
        editRequest.set({ ...request, prompt: payload.turn.prompt ?? '', failure: null })
      } catch (error) {
        editRequest.set({ ...request, prompt: '', failure: String(error?.message ?? error) })
      }
    }

    /** Close the edit dialog without acting. */
    function settleEdit() {
      editRequest.set(null)
    }

    /**
     * Replace a prompt: cut the turn (prompt, reply and everything after it),
     * remount the session on the rewritten log, then put the edited text back
     * into the composer and send it, so a fresh reply is generated.
     *
     * The send cannot go through the `inputActions` this dialog was opened
     * with: the cut retires that shell. It is handed to the replacement
     * composer instead, through {@link pendingDraft}, which the first remounted
     * turn tail picks up. The live shell is still written first, so the
     * harness's own draft mirror carries the text even when nothing renders a
     * turn tail afterwards.
     * @param request - the pending edit.
     * @param text - the edited prompt text.
     * @returns the host's cut summary.
     */
    async function runEdit(request, text) {
      const input = request.inputActions ?? currentInputActions ?? null
      const response = await fetch('/chat-eraser/delete-turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: request.sessionId, turn: request.turn }),
        cache: 'no-store'
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      }
      // A window restart keeps the composer this dialog was opened with, so the
      // edited prompt goes straight back into it and the send is this same
      // composer's. Only a remount kills that composer — then the text is
      // handed to the replacement through {@link pendingDraft} instead.
      if (restartSessionWindow(request.sessionId)) {
        try {
          if (input !== null) {
            try {
              input.setDraft?.(text)
            } catch {
              /* the composer writes its own projection; a failed seed is not fatal */
            }
            sendDraft(input, text)
          }
        } catch {
          /* a composer that cannot be driven is driven by the User instead */
        }
        return payload
      }
      pendingDraft.sessionId = request.sessionId
      pendingDraft.text = text
      pendingDraft.send = true
      try {
        input?.setDraft?.(text)
      } catch {
        /* the remounted composer picks the draft up instead */
      }
      await reopenSession(request.sessionId)
      return payload
    }

    /** The prompt edit dialog: a prefilled draft, and one Send. */
    function EraserEditDialog(props) {
      const { useEditRequest, settleEdit: settle, runEdit: run, t } = props
      const request = useEditRequest((value) => value)
      const [text, setText] = React.useState('')
      const [phase, setPhase] = React.useState('idle')
      const [failure, setFailure] = React.useState(null)
      const [seen, setSeen] = React.useState(null)

      const identity = request === null ? null : `${request.sessionId}:${request.turn}`
      if (seen !== identity) {
        setSeen(identity)
        setText(request?.prompt ?? '')
        setPhase('idle')
        setFailure(request?.failure ?? null)
      }
      if (request === null) return null

      const send = () => {
        if (phase === 'busy' || text.trim() === '') return
        setPhase('busy')
        setFailure(null)
        run(request, text).then(
          () => {
            setPhase('done')
            // The replacement is already on its way, so the dialog gets out of
            // the way of the reply it just started.
            window.setTimeout(settle, 600)
          },
          (error) => {
            setFailure(String(error?.message ?? error))
            setPhase('idle')
          }
        )
      }

      return h(
        primitives.Modal,
        {
          open: true,
          title: t('edit.title', { turn: request.turn }),
          closeLabel: t('dialog.cancel'),
          onClose: phase === 'busy' ? () => {} : settle,
          footer: [
            h(primitives.Button, { key: 'cancel', variant: 'ghost', disabled: phase !== 'idle', onClick: settle }, t('dialog.cancel')),
            h(
              primitives.Button,
              { key: 'send', variant: 'primary', disabled: phase === 'busy' || text.trim() === '', onClick: send },
              phase === 'done' ? t('edit.done') : phase === 'busy' ? t('edit.busy') : t('edit.send')
            )
          ]
        },
        h('p', { className: 'chat-eraser-body' }, t('edit.body', { turn: request.turn })),
        h('textarea', {
          className: 'chat-eraser-editor',
          value: text,
          rows: 6,
          spellCheck: false,
          disabled: phase !== 'idle',
          'aria-label': t('edit.title', { turn: request.turn }),
          onChange: (event) => setText(event.target.value)
        }),
        failure === null ? null : h('p', { className: 'chat-eraser-error' }, t('dialog.error', { message: failure }))
      )
    }

    /** One `...` menu row: delete the whole session. */
    function DeleteSessionMenuItem(props) {
      const { displayTitle, useMenuOpenState, requestDelete: ask, t } = props
      const [, setMenuOpen] = useMenuOpenState()
      return h(
        primitives.MenuItemButton,
        {
          separatorBefore: true,
          icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
          onSelect: () => {
            setMenuOpen(false)
            ask({ kind: 'session', sessionId: props.sessionId, displayTitle })
          }
        },
        t('menu.deleteSession')
      )
    }

    /**
     * Hand an edited prompt to whichever composer is now mounted.
     *
     * The turn tail is the earliest occupant that reliably receives
     * `inputActions` for the live Session, and it mounts as soon as the
     * remounted transcript settles. Only one instance wins: the pending draft
     * is taken, not read.
     * @param inputActions - the mounted composer's action face.
     * @param sessionId - session this occupant belongs to.
     */
    function takePendingDraft(inputActions, sessionId) {
      if (inputActions === undefined || inputActions === null) return
      if (pendingDraft.text === null || pendingDraft.sessionId !== sessionId) return
      const text = pendingDraft.text
      const send = pendingDraft.send
      pendingDraft.text = null
      pendingDraft.send = false
      if (!send) {
        try {
          inputActions.setDraft(text)
        } catch {
          /* the reader still has the text in the dialog; nothing else to try */
        }
        return
      }
      sendDraft(inputActions, text)
    }

    /**
     * Write one draft into a composer and send it.
     *
     * The draft lands in the editor's projection asynchronously, and `submit`
     * reads that projection — so the text is written once more just before the
     * send, rather than racing the first write.
     * @param inputActions - the composer's action face.
     * @param text - the text to send.
     */
    function sendDraft(inputActions, text) {
      const write = () => {
        try {
          inputActions.setDraft(text)
        } catch {
          /* the reader still has the text in the dialog; nothing else to try */
        }
      }
      write()
      window.setTimeout(() => {
        write()
        window.setTimeout(() => {
          try {
            inputActions.submit()
          } catch {
            /* the reader can press Send themselves */
          }
        }, 120)
      }, 250)
    }

    /**
     * The turn's own action cluster: delete the prompt, or edit it.
     *
     * The owner hands the Turn **location** (`node.location.turn`) in real
     * traffic — a number — but the turn record (`{ turn, status }`) is also
     * accepted, and a record whose turn is still open is being written right
     * now, so its controls are withheld instead of offering calls that must fail.
     */
    function TurnActions(props) {
      const { turn, sessionId, requestDelete: ask, requestEdit: edit, inputActions, t } = props
      useEffect(() => {
        takePendingDraft(inputActions, sessionId)
      }, [inputActions, sessionId])
      const record = typeof turn === 'object' && turn !== null ? turn : null
      const turnNumber = record === null
        ? (Number.isInteger(turn) ? turn : null)
        : (Number.isInteger(record.turn) ? record.turn : null)
      if (turnNumber === null) return null
      if (record !== null && record.status !== 'closed') return null
      if (typeof sessionId === 'string') currentSessionId = sessionId
      if (inputActions !== undefined) currentInputActions = inputActions
      return h(
        'div',
        { className: 'chat-eraser-turn' },
        h(
          primitives.Tooltip,
          { label: t('prompt.delete'), side: 'bottom', delayMs: 400 },
          h(
            'button',
            {
              type: 'button',
              className: 'chat-eraser-action',
              'aria-label': `${t('prompt.delete')} ${turnNumber}`,
              onClick: () => ask({ kind: 'prompt', sessionId, turn: turnNumber })
            },
            h(primitives.IconTrashOutlineRegular, { size: 16 })
          )
        ),
        h(
          primitives.Tooltip,
          { label: t('prompt.edit'), side: 'bottom', delayMs: 400 },
          h(
            'button',
            {
              type: 'button',
              className: 'chat-eraser-action',
              'aria-label': `${t('prompt.edit')} ${turnNumber}`,
              onClick: () => edit({ sessionId, turn: turnNumber, inputActions })
            },
            h(primitives.IconEditOutlineRegular, { size: 16 })
          )
        )
      )
    }

    /**
     * One reply action inside the shipped hover bar (next to copy, like, dislike).
     *
     * The currency is `{ messageId }`, and the bar lives inside the turn's own
     * DOM seat, so the turn number is read from the `data-turn-tail` ancestor the
     * shipped renderer already marks.
     */
    function DeleteReplyAction(props) {
      const { sessionId, requestDelete: ask, t } = props
      if (typeof sessionId === 'string') currentSessionId = sessionId
      return h(
        primitives.Tooltip,
        { label: t('reply.delete'), side: 'bottom', delayMs: 400 },
        h(
          'button',
          {
            type: 'button',
            className: 'chat-eraser-action',
            'data-chat-eraser-reply-action': '1',
            'aria-label': t('reply.delete'),
            onClick: (event) => {
              const seat = event?.currentTarget?.closest?.('[data-turn-tail]')
              const turn = Number(seat?.dataset?.turnTail)
              if (!Number.isInteger(turn) || turn < 1) return
              ask({ kind: 'reply', sessionId, turn })
            }
          },
          h(primitives.IconTrashOutlineRegular, { size: 16 })
        )
      )
    }

    /** The one dialog both affordances raise. */
    function EraserConfirmDialog(props) {
      const { useDeleteRequest, settleDelete: settle, runDelete: run, t } = props
      const request = useDeleteRequest((value) => value)
      const [phase, setPhase] = React.useState('idle')
      const [failure, setFailure] = React.useState(null)
      const [seen, setSeen] = React.useState(null)

      // One dialog serves every request, so its progress and error state belong
      // to the request identity, not to the component's lifetime.
      const identity =
        request === null ? null : `${request.kind}:${request.sessionId}:${request.turn ?? ''}`
      if (seen !== identity) {
        setSeen(identity)
        setPhase('idle')
        setFailure(null)
      }

      if (request === null) return null

      const isSession = request.kind === 'session'
      const isReply = request.kind === 'reply'
      const isPrompt = request.kind === 'prompt'
      const confirm = () => {
        if (phase === 'busy') return
        setPhase('busy')
        setFailure(null)
        run(request).then(
          () => setPhase('done'),
          (error) => {
            setFailure(String(error?.message ?? error))
            setPhase('idle')
          }
        )
      }

      return h(
        primitives.Modal,
        {
          open: true,
          title: t(
            isSession ? 'dialog.session.title' : isReply ? 'dialog.reply.title' : isPrompt ? 'dialog.prompt.title' : 'dialog.turn.title',
            { turn: request.turn }
          ),
          closeLabel: phase === 'busy' ? t('dialog.busy') : t('dialog.cancel'),
          onClose: phase === 'busy' ? () => {} : settle,
          footer: [
            h(
              primitives.Button,
              {
                key: 'cancel',
                variant: 'ghost',
                disabled: phase !== 'idle',
                onClick: settle
              },
              t('dialog.cancel')
            ),
            h(
              primitives.Button,
              {
                key: 'confirm',
                variant: 'primary',
                disabled: phase === 'busy' || phase === 'done',
                onClick: confirm
              },
              phase === 'done' ? t('dialog.done') : phase === 'busy' ? t('dialog.busy') : t('dialog.confirm')
            )
          ]
        },
        h('p', { className: 'chat-eraser-body' }, t(
          isSession ? 'dialog.session.body' : isReply ? 'dialog.reply.body' : isPrompt ? 'dialog.prompt.body' : 'dialog.turn.body',
          { turn: request.turn }
        )),
        isSession && typeof request.displayTitle === 'string'
          ? h('p', { className: 'chat-eraser-body' }, `“${request.displayTitle}”`)
          : null,
        failure === null ? null : h('p', { className: 'chat-eraser-error' }, t('dialog.error', { message: failure }))
      )
    }

    /**
     * The notice a stale view raises: either a rewrite the harness has not
     * re-read, or a control the view still offers around a removal that already
     * happened.
     */
    function EraserNoticeDialog(props) {
      const { useNoticeRequest, dismissNotice, t } = props
      const notice = useNoticeRequest((value) => value)
      if (notice === null) return null
      const body = notice.kind === 'session'
        ? 'notice.session.body'
        : notice.kind === 'reply' ? 'notice.reply.body' : 'notice.turn.body'
      return h(
        primitives.Modal,
        {
          open: true,
          title: t('notice.title'),
          closeLabel: t('notice.close'),
          onClose: dismissNotice,
          footer: [h(primitives.Button, { key: 'close', variant: 'primary', onClick: dismissNotice }, t('notice.close'))]
        },
        h('p', { className: 'chat-eraser-body' }, t(body))
      )
    }

    //#region the pen icon on a user message
    const PEN_MARK = 'data-chat-eraser-pen'
    const PEN_SELECTOR = 'div[data-chat-flow-kind="user"]:not([data-submission-echo]) [data-clock="start"]'

    /** Ask for the prompt edit behind one injected pen button. */
    function askEditFromPen(event) {
      const button = event?.target?.closest?.(`[${PEN_MARK}]`)
      if (button === null || button === undefined) return
      const row = button.closest('[data-chat-turn]')
      const turn = Number(row?.getAttribute?.('data-chat-turn') ?? button.getAttribute('data-chat-turn'))
      const sessionId = currentSessionId
      if (!Number.isInteger(turn) || turn < 1 || typeof sessionId !== 'string') return
      requestEdit({ sessionId, turn, inputActions: currentInputActions })
    }

    /**
     * Paint the pen into every user message action row that lacks one.
     * The shipped row holds the copy button as its first (and, for user
     * messages, only) button; the pen is inserted immediately before it, which
     * is the ChatGPT/Grok/Gemini placement.
     */
    function paintPenIcons() {
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return
      let rows
      try {
        rows = document.querySelectorAll(PEN_SELECTOR)
      } catch {
        return
      }
      for (const slot of rows) {
        if (slot.querySelector(`[${PEN_MARK}]`) !== null) continue
        const copy = slot.querySelector('button')
        if (copy === null) continue
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'chat-eraser-action'
        button.setAttribute(PEN_MARK, '1')
        button.setAttribute('aria-label', translate('prompt.edit'))
        button.title = translate('prompt.edit')
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 24 24')
        svg.setAttribute('width', '16')
        svg.setAttribute('height', '16')
        svg.setAttribute('aria-hidden', 'true')
        svg.setAttribute('fill', 'none')
        svg.setAttribute('stroke', 'currentColor')
        svg.setAttribute('stroke-width', '1.6')
        svg.setAttribute('stroke-linecap', 'round')
        svg.setAttribute('stroke-linejoin', 'round')
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', 'M4 20h4L20.5 7.5a2.1 2.1 0 0 0-3-3L5 17v3z')
        svg.appendChild(path)
        button.appendChild(svg)
        try {
          const reference = copy.parentElement === slot ? copy : copy.parentElement
          slot.insertBefore(button, reference)
        } catch {
          /* React re-parented the row; the next pass re-asserts the icon */
        }
      }
    }

    let penObserver = null
    let penFrame = 0

    function schedulePenPaint() {
      if (penFrame !== 0) return
      penFrame = window.setTimeout(() => {
        penFrame = 0
        paintPenIcons()
      }, 120)
    }

    function startPenIcons() {
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return
      if (typeof window === 'undefined' || typeof window.MutationObserver !== 'function') return
      paintPenIcons()
      document.addEventListener('click', askEditFromPen, true)
      penObserver = new window.MutationObserver(schedulePenPaint)
      penObserver.observe(document.body, { childList: true, subtree: true })
    }

    function stopPenIcons() {
      penObserver?.disconnect()
      penObserver = null
      if (penFrame !== 0) {
        window.clearTimeout(penFrame)
        penFrame = 0
      }
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('click', askEditFromPen, true)
      }
    }
    //#endregion

    /**
     * Register every contribution. `ctx.slots.inject` waits for each owner's
     * declaration and re-registers after the declaring slot collapses, so load
     * order against the shipped plugins does not matter.
     * @param ctx - browser plugin context carrying `slots`, `locale`, and the
     *   services the close-the-loop needs.
     */
    function apply(ctx) {
      pluginCtx = ctx
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'chat-eraser: dictionaries')
      translate = ctx.locale.bind(NS)

      // The workspace's navigation layer, used to reopen a session the host
      // released; absent on a composition without the Workspace browser.
      ctx.inject(['uiWorkspace'], (scope) => {
        workspaceUi = scope.uiWorkspace ?? null
        return () => {
          workspaceUi = null
        }
      })

      // The session list, used to put the sidebar row back after the host's
      // removal relay took it out.
      ctx.inject(['sessions'], (scope) => {
        sessionsApi = scope.sessions ?? (typeof scope.get === 'function' ? scope.get('sessions') : null) ?? null
        return () => {
          sessionsApi = null
        }
      })

      ctx.effect(() => {
        startPenIcons()
        return stopPenIcons
      }, 'chat-eraser: prompt edit icons')

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'chat-eraser.delete-session',
            // After the shipped Archive row (400); the separator opens the plugin group.
            order: 500,
            locale: NS,
            inject: () => ({ requestDelete })
          },
          DeleteSessionMenuItem
        )
      )

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'chat-eraser.prompt-actions',
            // First in the tail: the shipped feature tails come after.
            order: 10,
            locale: NS,
            inject: (sessionId) => ({ sessionId, requestDelete, requestEdit })
          },
          TurnActions
        )
      )

      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'chat-eraser.delete-reply',
            // Right after the shipped feedback controls (order 10).
            order: 20,
            locale: NS,
            inject: (sessionId) => ({ sessionId, requestDelete })
          },
          DeleteReplyAction
        )
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'chat-eraser.edit',
            order: 61,
            locale: NS,
            inject: () => ({ hooks: { editRequest }, settleEdit, runEdit })
          },
          EraserEditDialog
        )
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'chat-eraser.confirm',
            order: 60,
            locale: NS,
            inject: () => ({ hooks: { deleteRequest }, settleDelete, runDelete })
          },
          EraserConfirmDialog
        )
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'chat-eraser.notice',
            order: 61,
            locale: NS,
            inject: () => ({
              hooks: { noticeRequest },
              dismissNotice: () => {
                noticeRequest.set(null)
              }
            })
          },
          EraserNoticeDialog
        )
      )
    }

    return { name: 'dsh-chat-eraser', inject: ['slots', 'locale'], apply }
  }
})
