import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { SESSION_LOCK_BUSY_PREFIX, DEFERRED_PREFIX, type TrashRecord } from './types.js'
import { copy, type CopyKey } from './client-copy.js'
import { trashStore, type TrashEntries } from './client-store.js'
import { WorkspaceSync, type WorkspaceProjection, type WorkspaceReader } from './workspace-sync.js'

// The browser build calls this with the generated, bundled Remote contribution.
export default function registerTrashClient(contribution: TypertRemoteContribution): void {
  type SessionId = import('@deepseek-ai/dsh-session/types').SessionId
  type RemoteResult<T> = import('@deepseek-ai/dsh-typert-protocol').RemoteResult<T>

  // React comes from the browser table; Remote codecs are bundled at build time.
  type Element = unknown
  type Setter<T> = (value: T) => void
  interface ReactRuntime {
    createElement(type: unknown, props: unknown, ...children: unknown[]): Element
    useState<T>(value: T): [T, Setter<T>]
    useRef<T>(value: T): { current: T }
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void
    useId(): string
  }

  type Translate = (key: CopyKey, values?: Record<string, string>) => string
  // Remote/transport errors may come from another JS realm.
  const errorMessage = (reason: unknown): string =>
    reason !== null && typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string'
      ? reason.message : String(reason)
  interface RowProps {
    sessionId: SessionId
    t: Translate
    moveToTrash: (sessionId: SessionId) => Promise<void>
  }
  interface MenuProps extends RowProps {
    useMenuOpenState: () => readonly [boolean, (open: boolean) => void]
  }
  type RowSlotName = 'sidebar.workspaces.session.menu.item' | 'sidebar.workspaces.session.row.action'
  type SlotName = RowSlotName | 'sidebar.panellist' | 'main'
  interface TrashRemote {
    trashSession(sessionId: SessionId): Promise<RemoteResult<void>>
    listTrash(): Promise<RemoteResult<TrashEntries>>
    restoreSession(sessionId: SessionId): Promise<RemoteResult<void>>
    removeFromTrash(sessionId: SessionId): Promise<RemoteResult<boolean>>
    emptyTrash(): Promise<RemoteResult<number>>
  }
  interface PanelInjected {
    trash: TrashRemote
    getLocale: () => string
  }
  interface PanelProps extends PanelInjected {
    t: Translate
    useWorkspaces: <T>(selector: (state: {
      archivedSessionIds: readonly SessionId[]
      items: readonly { workspaceId: string; title: string; sessionIds: readonly SessionId[] }[]
    }) => T) => T
    // Installed SessionListState.byId is the catalog title authority. Retain
    // info only contains reference counts; reading it cannot recover a title.
    useSessions: <T>(selector: (state: {
      byId: Record<string, { title?: string; displayTitle: string } | undefined>
    }) => T) => T
  }
  interface ClientContext {
    get(name: 'remote.trash'): TrashRemote | undefined
    workspaces: { list: WorkspaceProjection }
    effect(setup: () => () => void, label?: string): unknown
    locale: {
      register(namespace: string, dictionaries: Record<'en' | 'zh', Record<CopyKey, string>>): () => void
      bind(namespace: string): Translate
      getSnapshot(): { active: string }
    }
    remote: {
      $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
      workspace: WorkspaceReader
    }
    slots: {
      inject(name: SlotName, register: () => unknown): unknown
      register<P extends RowProps>(options: {
        name: RowSlotName
        id: string
        order: number
        locale: string
        inject: () => Pick<RowProps, 'moveToTrash'>
      }, component: (props: P) => Element): unknown
      register(options: {
        name: 'sidebar.panellist'; id: 'trash'; order: number; locale: string; label: () => string
      }, component: (props: { size: number; active: boolean }) => Element): unknown
      register(options: {
        name: 'main'; key: 'trash'; locale: string; inject: () => PanelInjected
      }, component: (props: PanelProps) => Element): unknown
    }
  }

  const namespace = 'trash'
  const css = `
  .trash-menu { display:flex; align-items:center; gap:6px; box-sizing:border-box;
    width:100%; min-height:34px; padding:6px 8px; border:0; border-radius:4px;
    background:transparent; color:var(--dsw-alias-label-primary); font:inherit;
    font-size:13px; text-align:start; cursor:pointer; }
  .trash-menu:hover, .trash-menu:focus-visible { background:var(--dsw-alias-interactive-bg-hover); }
  .trash-action { display:inline-flex; align-items:center; }
  .trash-icon { display:inline-flex; align-items:center; justify-content:center; flex:none;
    width:24px; height:24px; margin:-4px; border:0; border-radius:4px; padding:0;
    background:transparent; color:var(--dsw-alias-label-tertiary); cursor:pointer; }
  .trash-icon:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); }
  .trash-icon:focus-visible, .trash-menu:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:-2px; }
  .trash-icon[aria-disabled=true], .trash-menu[aria-disabled=true] { opacity:.5; cursor:wait; }
  .trash-tooltip { position:fixed; z-index:1200; box-sizing:border-box; width:max-content;
    max-width:min(300px, calc(100vw - 16px)); padding:3px 7px; border-radius:4px;
    background:var(--dsw-alias-tooltip-bg);
    color:var(--dsw-alias-tooltip-label); font:13px/20px sans-serif; overflow-wrap:anywhere;
    pointer-events:none; }
  .trash-error { display:block; max-width:280px; padding:4px 8px;
    color:var(--dsw-alias-state-error-primary); font-size:12px; white-space:normal; }
  .trash-sr { position:absolute; width:1px; height:1px; padding:0; overflow:hidden;
    clip-path:inset(50%); white-space:nowrap; }
  .trash-panel { box-sizing:border-box; width:100%; height:100%; min-height:0; overflow:auto;
    padding:24px;
    background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; }
  .trash-panel-inner { max-width:960px; margin:auto; }
  .trash-panel-header, .trash-panel-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
  .trash-panel-header { justify-content:space-between; margin-bottom:16px;
    padding-inline-start:var(--dsh-frame-leading-clearance, 0px); }
  .trash-panel h1 { margin:0; font-size:24px; }
  .trash-panel p { margin:8px 0; }
  .trash-panel button { border:1px solid var(--dsw-alias-border-l2); border-radius:6px; padding:6px 10px;
    background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; cursor:pointer; }
  .trash-panel button:hover { background:var(--dsw-alias-interactive-bg-hover); }
  .trash-panel button:focus-visible { outline:2px solid var(--dsw-alias-border-l2); outline-offset:2px; }
  .trash-panel button:disabled { opacity:.5; cursor:default; }
  .trash-panel .trash-danger { color:var(--dsw-alias-state-error-primary); }
  .trash-panel-list { list-style:none; padding:0; margin:16px 0; }
  .trash-panel-row { border-bottom:1px solid var(--dsw-alias-border-l2); padding:16px 0; }
  .trash-panel-heading { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap;
    gap:4px 8px; margin-bottom:8px; min-width:0; }
  .trash-panel-title { margin:0; min-width:0; font-size:15px; overflow-wrap:anywhere; }
  .trash-session-id { min-width:0; max-width:100%; font-size:12px; color:var(--dsw-alias-label-tertiary); }
  .trash-session-id-line { display:flex; align-items:center; flex-wrap:wrap; gap:6px; min-width:0; }
  .trash-session-id code { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:monospace; }
  .trash-session-id .trash-copy-id { flex:none; padding:2px 6px; font-size:12px; }
  .trash-session-id input { display:block; box-sizing:border-box; width:100%; min-width:0; margin-top:4px;
    border:1px solid var(--dsw-alias-border-l2); border-radius:4px; padding:3px 5px;
    background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:12px monospace; }
  .trash-session-id-feedback { display:block; overflow-wrap:anywhere; }
  .trash-session-id-failure { color:var(--dsw-alias-state-error-primary); }
  .trash-panel-meta, .trash-panel-note { color:var(--dsw-alias-label-tertiary); font-size:13px; overflow-wrap:anywhere; }
  .trash-panel-confirm { margin:12px 0; padding:12px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; }
  .trash-panel-state { padding:40px 0; text-align:center; color:var(--dsw-alias-label-tertiary); }
  .trash-panel .trash-error { max-width:none; padding:8px 0; }
  @media (max-width:600px) { .trash-panel { padding-inline:16px; } }
  `

  ;(window as unknown as { __ModuleLoader__: { load(module: unknown): void } }).__ModuleLoader__.load({
    id: contribution.package,
    factory(require: (id: 'react') => ReactRuntime) {
      const React = require('react')
      const h = React.createElement

      function TrashIcon({ size = 14 }: { size?: number } = {}): Element {
        return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true },
        h('path', { d: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7' }))
      }

      function TrashPanelIcon({ size, active }: { size: number; active: boolean }): Element {
        return h('span', { style: { display: 'inline-flex',
          color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)' } },
        h(TrashIcon, { size }))
      }

      function unwrap<T>(result: RemoteResult<T>): T {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }

      type Confirmation = { kind: 'empty' } | { kind: 'delete'; sessionId: SessionId } | null
      type FailureKey = 'loadFailed' | 'restoreFailed' | 'deleteFailed' | 'emptyFailed'
      interface TrashRowProps extends Pick<PanelProps, 't' | 'useSessions' | 'useWorkspaces' | 'getLocale'> {
        sessionId: SessionId
        record: TrashRecord
        pending: boolean
        confirming: boolean
        onRestore: () => void
        onDelete: () => void
        onConfirm: () => void
        onCancel: () => void
      }

      // Stable ref: unrelated row rerenders must not steal focus back to the input.
      function selectFullId(input: HTMLInputElement | null): void {
        if (input) { input.focus(); input.select() }
      }

      function SessionIdentifier({ sessionId, t }: { sessionId: SessionId; t: Translate }): Element {
        const [copied, setCopied] = React.useState(false)
        const [copying, setCopying] = React.useState(false)
        const [fallback, setFallback] = React.useState<{ reason?: string } | null>(null)
        const timer = React.useRef<number | undefined>(undefined)
        const busy = React.useRef(false)
        const generation = React.useRef(0)
        React.useEffect(() => {
          generation.current++
          return () => {
            generation.current++
            window.clearTimeout(timer.current)
            timer.current = undefined
          }
        }, [sessionId])
        const copyId = async (): Promise<void> => {
          if (busy.current) return
          busy.current = true
          const token = generation.current
          window.clearTimeout(timer.current)
          timer.current = undefined
          setCopied(false)
          setCopying(true)
          setFallback(null)
          try {
            const clipboard = window.navigator?.clipboard
            if (typeof clipboard?.writeText !== 'function') {
              setFallback({})
              return
            }
            await clipboard.writeText(sessionId)
            if (token !== generation.current) return
            setCopied(true)
            timer.current = window.setTimeout(() => {
              timer.current = undefined
              setCopied(false)
            }, 1500)
          } catch (reason: unknown) {
            if (token === generation.current) setFallback({ reason: errorMessage(reason) })
          } finally {
            busy.current = false
            if (token === generation.current) setCopying(false)
          }
        }
        return h('div', { className: 'trash-session-id' },
          h('div', { className: 'trash-session-id-line' },
            h('code', { title: sessionId, 'aria-label': `${t('sessionId')}: ${sessionId}` },
              sessionId.length > 12 ? `…${sessionId.slice(-12)}` : sessionId),
            h('button', { type: 'button', className: 'trash-copy-id', title: t('copyId'),
              'aria-label': t('copyId'), disabled: copying,
              onClick: () => { void copyId() } }, t('copyId')),
            copied && h('span', { role: 'status' }, t('copied'))),
          fallback && h('div', null,
            h('span', { className: 'trash-session-id-feedback trash-session-id-failure', role: 'alert' },
              t('copyFailed', { reason: 'reason' in fallback
                ? fallback.reason?.trim() || t('copyErrorUnknown') : t('clipboardUnavailable') })),
            h('span', { className: 'trash-session-id-feedback' }, t('copyManually')),
            h('input', { type: 'text', readOnly: true, value: sessionId, title: sessionId,
              'aria-label': t('sessionId'), ref: selectFullId,
              onFocus: (event: { currentTarget: HTMLInputElement }) => event.currentTarget.select() })))
      }

      function TrashRow(props: TrashRowProps): Element {
        const { t, sessionId, record } = props
        // Each row owns its selector hook, so list length/order never changes
        // the panel's hook order. No Session is retained or opened for a title.
        const liveTitle = props.useSessions(state => {
          const session = state.byId[sessionId]
          return session?.title?.trim() || session?.displayTitle?.trim()
        })
        const title = record.titleSnapshot?.trim() || liveTitle || sessionId.slice(0, 12)
        // Current Workspace membership/name, not an optional historic marker.
        // Moves and renames follow the snapshot; detached sessions are explicit.
        const workspace = props.useWorkspaces(state =>
          state.items.find(item => item.sessionIds.includes(sessionId))?.title)
        const date = new Date(record.trashedAt)
        const validDate = !Number.isNaN(date.getTime())
        return h('li', { className: 'trash-panel-row' },
          h('div', { className: 'trash-panel-heading' },
            h('h2', { className: 'trash-panel-title', title: sessionId }, title),
            h(SessionIdentifier, { sessionId, t })),
          h('p', { className: 'trash-panel-meta' },
            h('time', { dateTime: validDate ? date.toISOString() : undefined },
              t('trashedAt', { time: validDate ? date.toLocaleString(props.getLocale()) : t('unknownTime') }))),
          h('p', { className: 'trash-panel-meta' }, t('workspace', { workspace: workspace || t('noWorkspace') })),
          record.purgePending && h('p', { className: 'trash-panel-note' }, t('purgePending')),
          record.deferred && h('p', { className: 'trash-panel-note' }, t('deferred')),
          h('div', { className: 'trash-panel-actions' },
            h('button', { type: 'button', disabled: props.pending || record.purgePending, onClick: props.onRestore }, t('restore')),
            h('button', { type: 'button', className: 'trash-danger', disabled: props.pending, onClick: props.onDelete }, t('deleteForever'))),
          props.confirming && h('div', { className: 'trash-panel-confirm', role: 'group',
            'aria-label': t('confirmDelete', { title }), onKeyDown: (event: KeyboardEvent) => {
              if (event.key === 'Escape' && !props.pending) props.onCancel()
            } },
            h('p', null, t('confirmDelete', { title })), h('p', { className: 'trash-panel-note' }, t('physicalDeletion')),
            h('div', { className: 'trash-panel-actions' },
              h('button', { type: 'button', className: 'trash-danger', disabled: props.pending, onClick: props.onConfirm }, t('deleteForever')),
              h('button', { type: 'button', disabled: props.pending, onClick: props.onCancel }, t('cancel')))))
      }

      function TrashPanel(props: PanelProps): Element {
        const { t, trash } = props
        const [storedEntries, setEntries] = React.useState<TrashEntries | null>(trashStore.getSnapshot())
        const archivedSessionIds = props.useWorkspaces(state => state.archivedSessionIds)
        const archived = new Set(archivedSessionIds)
        // Filter every render, including stale/in-flight list responses. This
        // is a projection only; Host listTrash owns durable marker cleanup.
        const entries = storedEntries?.filter(([id, record]) => record.purgePending || archived.has(id)) ?? null
        const [pending, setPending] = React.useState(true)
        const [confirmation, setConfirmation] = React.useState<Confirmation>(null)
        const [failure, setFailure] = React.useState<{ key: FailureKey; reason: string } | null>(null)
        const mounted = React.useRef(false)
        const busy = React.useRef(false)
        const request = React.useRef(0)
        const reload = async (): Promise<void> => {
          const token = ++request.current
          await trashStore.refresh(async () => unwrap(await trash.listTrash()),
            () => mounted.current && request.current === token)
        }
        const run = async (key: FailureKey, mutation?: () => Promise<unknown>): Promise<void> => {
          if (busy.current) return
          busy.current = true
          setPending(true)
          setFailure(null)
          let failureKey = key
          try {
            await mutation?.()
            if (!mounted.current) return
            if (mutation) setConfirmation(null)
            failureKey = 'loadFailed'
            await reload()
          } catch (reason: unknown) {
            if (mounted.current) {
              const message = errorMessage(reason)
              if ((failureKey === 'deleteFailed' || failureKey === 'emptyFailed') && message.startsWith(DEFERRED_PREFIX)) {
                setConfirmation(null)
              }
              setFailure({ key: failureKey, reason: message })
            }
          } finally {
            busy.current = false
            if (mounted.current) setPending(false)
          }
        }
        React.useEffect(() => {
          mounted.current = true
          const token = ++request.current
          const unsubscribe = trashStore.subscribe(() => setEntries(trashStore.getSnapshot()))
          setEntries(trashStore.getSnapshot())
          // A generation token also discards the first StrictMode effect's
          // response after its cleanup, even if the next effect is mounted.
          void trashStore.refresh(async () => unwrap(await trash.listTrash()),
            () => mounted.current && request.current === token).catch((reason: unknown) => {
            if (mounted.current && request.current === token) setFailure({ key: 'loadFailed',
              reason: errorMessage(reason) })
          }).finally(() => {
            if (mounted.current && request.current === token) setPending(false)
          })
          return () => { unsubscribe(); mounted.current = false; request.current++ }
        }, [trash])
        return h('section', { className: 'trash-panel', 'aria-label': t('panelTitle'), 'aria-busy': pending },
          h('style', null, css), h('div', { className: 'trash-panel-inner' },
            h('header', { className: 'trash-panel-header' }, h('h1', null, t('panelTitle')),
              h('div', { className: 'trash-panel-actions' },
                h('button', { type: 'button', disabled: pending, onClick: () => { void run('loadFailed') } }, t('refresh')),
                h('button', { type: 'button', className: 'trash-danger', disabled: pending || !entries?.length,
                  onClick: () => setConfirmation({ kind: 'empty' }) }, t('emptyTrash')))),
            h('p', { className: 'trash-panel-note' }, t('physicalDeletion')),
            failure && ((failure.key === 'deleteFailed' || failure.key === 'emptyFailed') && failure.reason.startsWith(DEFERRED_PREFIX)
              ? h('div', { className: 'trash-panel-note', role: 'status' }, t('deferredNotice', { reason: failure.reason }))
              : h('div', { className: 'trash-error', role: 'alert' },
              (failure.key === 'deleteFailed' || failure.key === 'emptyFailed')
                && failure.reason.startsWith(SESSION_LOCK_BUSY_PREFIX) && h('p', null, t('sessionLockBusy')),
              t(failure.key, { reason: failure.reason }))),
            pending && h('p', { role: 'status' }, t(entries === null ? 'loading' : 'working')),
            confirmation?.kind === 'empty' && h('div', { className: 'trash-panel-confirm', role: 'group',
              'aria-label': t('confirmEmpty'), onKeyDown: (event: KeyboardEvent) => {
                if (event.key === 'Escape' && !pending) setConfirmation(null)
              } }, h('p', null, t('confirmEmpty')),
              h('div', { className: 'trash-panel-actions' },
                h('button', { type: 'button', className: 'trash-danger', disabled: pending,
                  onClick: () => { void run('emptyFailed', async () => {
                    unwrap(await trash.emptyTrash())
                  }) } }, t('emptyTrash')),
                h('button', { type: 'button', disabled: pending, onClick: () => setConfirmation(null) }, t('cancel')))),
            entries?.length === 0 && !pending && !failure && h('p', { className: 'trash-panel-state', role: 'status' }, t('emptyState')),
            entries !== null && entries.length > 0 && h('ul', { className: 'trash-panel-list' },
              ...entries.map(([sessionId, record]) => h(TrashRow, {
                key: sessionId, sessionId, record, t, useSessions: props.useSessions,
                useWorkspaces: props.useWorkspaces, getLocale: props.getLocale, pending,
                confirming: confirmation?.kind === 'delete' && confirmation.sessionId === sessionId,
                onRestore: () => { void run('restoreFailed', async () => {
                  unwrap(await trash.restoreSession(sessionId))
                }) },
                onDelete: () => setConfirmation({ kind: 'delete', sessionId }),
                onConfirm: () => { void run('deleteFailed', async () => {
                  unwrap(await trash.removeFromTrash(sessionId))
                }) },
                onCancel: () => setConfirmation(null),
              })))))
      }

      function useMove({ sessionId, moveToTrash }: RowProps) {
        const [pending, setPending] = React.useState(false)
        const [error, setError] = React.useState<string | null>(null)
        const busy = React.useRef(false)
        const mounted = React.useRef(true)
        React.useEffect(() => {
          mounted.current = true
          return () => { mounted.current = false }
        }, [])
        const run = async (done?: () => void): Promise<void> => {
          if (busy.current) return
          busy.current = true
          setPending(true)
          setError(null)
          try {
            await moveToTrash(sessionId)
            if (mounted.current) done?.()
          } catch (reason: unknown) {
            if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
          } finally {
            busy.current = false
            if (mounted.current) setPending(false)
          }
        }
        return { pending, error, run }
      }

      function MenuItem(props: MenuProps): Element {
        const [, setMenuOpen] = props.useMenuOpenState()
        const { pending, error, run } = useMove(props)
        return h('div', null,
          h('style', null, css),
          h('button', { type: 'button', role: 'menuitem', className: 'trash-menu',
            'aria-disabled': pending, 'aria-busy': pending,
            onClick: () => { void run(() => setMenuOpen(false)) } },
          h(TrashIcon, null), props.t(pending ? 'moving' : 'moveToTrash')),
          error && h('span', { className: 'trash-error', role: 'alert' }, props.t('moveFailed', { reason: error })))
      }

      /** Local fixed tooltip; listeners and delay disappear with the button. */
      function RowAction(props: RowProps): Element {
        const { pending, error, run } = useMove(props)
        const [hovered, setHovered] = React.useState(false)
        const [focused, setFocused] = React.useState(false)
        const [dismissed, setDismissed] = React.useState(false)
        const [position, setPosition] = React.useState<{ top: number; right: number } | null>(null)
        const anchor = React.useRef<HTMLElement | null>(null)
        const delay = React.useRef<number | undefined>(undefined)
        const suppressed = React.useRef(false)
        const tooltipId = React.useId()
        const label = props.t(pending ? 'moving' : 'moveToTrash')
        const failure = error === null ? null : props.t('moveFailed', { reason: error })
        React.useEffect(() => {
          if ((!hovered && !focused) || dismissed) { setPosition(null); return }
          const timer = window.setTimeout(() => {
            delay.current = undefined
            if (suppressed.current) return
            const rect = anchor.current?.getBoundingClientRect()
            if (rect) setPosition({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
          }, 500)
          delay.current = timer
          const hide = (): void => { setPosition(null) }
          window.addEventListener('scroll', hide, true)
          window.addEventListener('resize', hide)
          return () => {
            window.clearTimeout(timer)
            delay.current = undefined
            window.removeEventListener('scroll', hide, true)
            window.removeEventListener('resize', hide)
          }
        }, [hovered, focused, dismissed])
        const reset = (): void => { suppressed.current = false; setDismissed(false) }
        return h('span', { className: 'trash-action', ref: anchor,
          onMouseEnter: () => setHovered(true), onMouseLeave: () => { setHovered(false); reset() },
          onFocus: () => setFocused(true), onBlur: () => { setFocused(false); reset() },
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            suppressed.current = true
            window.clearTimeout(delay.current)
            delay.current = undefined
            setDismissed(true)
            setPosition(null)
          } },
        h('style', null, css),
        h('button', { type: 'button', className: 'trash-icon', 'aria-label': label,
          'aria-disabled': pending, 'aria-busy': pending,
          'aria-describedby': position ? tooltipId : undefined,
          onClick: () => { void run() } }, h(TrashIcon, null)),
        position && h('span', { id: tooltipId, role: 'tooltip', className: 'trash-tooltip', style: position }, failure ?? label),
        failure && h('span', { role: 'alert', className: 'trash-sr' }, failure))
      }

      return {
        inject: ['slots', 'locale', 'remote', 'remote.workspace', 'workspaces'],
        async apply(ctx: ClientContext) {
          // ./remote is a data export, not an automatically mounted plugin.
          // Waiting for our own namespace before mounting it deadlocks this row.
          const disposeRemote = await ctx.remote.$mount(contribution)
          // Gateway owns the namespace in a separate fiber. Injecting `remote`
          // does not permit property access to `remote.trash`; resolve it only
          // after our mount has completed, without adding a dependency gate.
          const host = ctx.get('remote.trash')
          if (!host) {
            await disposeRemote()
            throw new Error('Trash Remote namespace was not mounted')
          }
          let workspaceSync: WorkspaceSync
          try { workspaceSync = new WorkspaceSync(ctx.workspaces.list, ctx.remote.workspace) }
          catch (error) { await disposeRemote(); throw error }
          ctx.effect(() => () => workspaceSync.dispose(), 'trash: Workspace projection sync')
          ctx.effect(() => ctx.locale.register(namespace, copy), 'trash: dictionaries')
          const load = async (): Promise<TrashEntries> => unwrap(await host.listTrash())
          const write = async <T,>(sessionId: SessionId | undefined,
            invoke: () => Promise<RemoteResult<T>>, publish: () => void): Promise<RemoteResult<T>> => {
            const ticket = trashStore.begin(sessionId)
            workspaceSync.invalidate()
            // Carry the invocation ticket alongside the arriving response;
            // generated wire methods remain positional, with no schema change.
            let arrived: RemoteResult<T>
            try { arrived = await invoke() }
            catch (error) {
              await trashStore.refresh(load, () => true).catch(() => {})
              await workspaceSync.refresh().catch(() => {})
              throw error
            }
            const response = { ticket, result: arrived }
            const { result } = response
            if (result.ok) {
              await trashStore.accept(response.ticket, publish, load)
              await workspaceSync.refresh()
            } else {
              // A batch or record cleanup can partially commit before rejection.
              // Refresh both projections while retaining the original error.
              await trashStore.refresh(load, () => true).catch(() => {})
              await workspaceSync.refresh().catch(() => {})
            }
            return result
          }
          // One operation layer for every slot and panel, including empty's
          // global boundary. A component's own busy flag cannot order peers.
          const trash: TrashRemote = {
            trashSession: id => write(id, () => host.trashSession(id),
              () => trashStore.upsert(id, { trashedAt: Date.now() })),
            restoreSession: id => write(id, () => host.restoreSession(id), () => {
              const record = trashStore.getSnapshot()?.find(([key]) => key === id)?.[1]
              if (record?.deferred) {
                const { deferred: _, ...ordinary } = record
                trashStore.upsert(id, ordinary)
              } else trashStore.remove(id)
            }),
            removeFromTrash: id => write(id, () => host.removeFromTrash(id), () => trashStore.remove(id)),
            emptyTrash: () => write(undefined, () => host.emptyTrash(), () => trashStore.clear()),
            listTrash: async () => {
              await workspaceSync.refresh()
              return host.listTrash()
            },
          }
          const moveToTrash = async (sessionId: SessionId): Promise<void> => {
            unwrap(await trash.trashSession(sessionId))
          }
          ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item', id: 'trash-menu', order: 350,
            locale: namespace, inject: () => ({ moveToTrash }),
          }, MenuItem))
          ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
            name: 'sidebar.workspaces.session.row.action', id: 'trash-action', order: 50,
            locale: namespace, inject: () => ({ moveToTrash }),
          }, RowAction))
          const t = ctx.locale.bind(namespace)
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: 'trash', order: 40, locale: namespace,
            label: () => t('panelTitle'),
          }, TrashPanelIcon))
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: 'trash', locale: namespace,
            inject: () => ({ trash, getLocale: () => ctx.locale.getSnapshot().active }),
          }, TrashPanel))
          return disposeRemote
        },
      }
    },
  })

}
