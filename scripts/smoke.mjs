import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import clientHarness from './client-harness.cjs'
import legacyPurgeSeam from './legacy-purge-seam.cjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { default: TrashService } = await import(manifest.name)
const { TYPERT } = await import(`${manifest.name}/typert`)
const { default: remoteInfo } = await import(`${manifest.name}/remote`)
assert.equal(manifest.name, 'd-trash')
assert.equal(TYPERT.package, manifest.name)
assert.equal(remoteInfo.package, manifest.name)
const methods = ['distillSession', 'emptyTrash', 'listDistillAgents', 'listTrash', 'removeFromTrash', 'restoreSession', 'trashSession']
assert.deepEqual(Object.keys(remoteInfo.methods).sort(), methods.map(method => `trash/${method}`))

const records = new Map()
const archived = new Set()
const operations = []
let opened = 0
let closed = 0
let failArchive = false
const ctx = new Context()
ctx.provide('storageDomain', { open: async spec => {
  assert.equal(spec.name, 'trash', 'package renames must preserve existing marker storage')
  assert.equal(spec.version, 1)
  assert.deepEqual(Object.keys(spec.tables), ['trash'])
  opened++
  return {
    table: () => ({
      get: id => records.get(id),
      put: async (id, value) => { operations.push('put'); records.set(id, value) },
      delete: async id => { operations.push('delete'); return records.delete(id) },
      deleteMany: async ids => ids.reduce((n, id) => n + Number(records.delete(id)), 0),
      entries: () => records.entries(), keys: () => records.keys(),
    }),
    close: async () => { closed++ },
  }
} })
ctx.provide('workspaceRegistry', {
  list: () => [],
  get archivedSessionIds() { return [...archived] },
  archiveSession: async (id, options) => {
    assert.equal(typeof id, 'string')
    assert.equal(options.stopActivity, true)
    operations.push('archive')
    if (failArchive) throw new Error('archive failed')
    archived.add(id)
  },
  unarchiveSession: async id => { operations.push('unarchive'); archived.delete(id) },
})
const trash = new TrashService(ctx)
legacyPurgeSeam(trash)
assert.equal(ctx.trash.name, 'trash')
assert.equal(trash.typertRemote.namespace, 'trash')
assert.equal(opened, 0)
assert.deepEqual(remoteMethods(trash).map(x => x.method).sort(),
  ['distillSession', 'emptyTrash', 'listDistillAgents', 'listTrash', 'removeFromTrash', 'restoreSession', 'trashSession'])
assert.equal(TYPERT.invocations.length, 7)
assert.equal(remoteInfo.descriptors.length, 7)
await Promise.all([trash.listTrash(), trash.listTrash()])
assert.equal(opened, 1)

// Model Gateway's positional namespace -> named wire -> Host dispatch using
// the actual generated parsers, rather than accepting any call shape.
const clientRemote = { trash: Object.fromEntries(remoteInfo.descriptors.map(descriptor => [
  descriptor.method,
  async (...values) => {
    const wire = Object.fromEntries(descriptor.parameters.map((p, i) => [p.wire, values[i]]))
    const parsed = descriptor.input().create().parse(wire)
    const result = await trash[descriptor.method](...descriptor.parameters.map(p => parsed[p.wire]))
    return { ok: true, value: descriptor.result.create().parse(result) }
  },
])) }
const moveDescriptor = remoteInfo.methods['trash/trashSession']
await moveDescriptor.invoke(clientRemote, { sessionId: 'one' })
assert.deepEqual(operations, ['archive', 'put'])
assert.equal(records.has('one'), true)
assert.throws(() => moveDescriptor.input().create().parse({ sessionId: { sessionId: 'wrong' } }))
assert.throws(() => moveDescriptor.input().create().parse({ sessionId: 'one', extra: true }))
const list = (await clientRemote.trash.listTrash()).value
list[0][1].trashedAt = -1
assert.notEqual(records.get('one').trashedAt, -1)
await clientRemote.trash.restoreSession('one')
assert.deepEqual(operations.slice(-2), ['delete', 'unarchive'])
await trash.trashSession('two')
assert.equal((await clientRemote.trash.removeFromTrash('two')).value, true)
await trash.trashSession('three')
assert.equal((await clientRemote.trash.emptyTrash()).value, 1)
failArchive = true
await assert.rejects(trash.trashSession('failure'), /archive failed/)
assert.equal(records.has('failure'), false)
assert.equal(archived.has('failure'), false)
failArchive = false

let definition
const timers = new Map()
const timerDelays = new Map()
const listeners = new Set()
let timerId = 0
const browser = {
  innerWidth: 1024,
  __ModuleLoader__: { load(value) { definition = value } },
  setTimeout(callback, delay) { timers.set(++timerId, callback); timerDelays.set(timerId, delay); return timerId },
  clearTimeout(id) { timers.delete(id); timerDelays.delete(id) },
  addEventListener(name, fn) { listeners.add(fn) },
  removeEventListener(name, fn) { listeners.delete(fn) },
}
new vm.Script(readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')).runInNewContext({ window: browser, AbortController })
assert.equal(definition.id, manifest.name)
const { React, mount, find } = clientHarness((...args) => translate(...args))
const plugin = definition.factory(id => { assert.equal(id, 'react'); return React })
assert.ok(plugin.inject.includes('remote'))
assert.ok(!plugin.inject.includes('remote.trash'), 'the plugin must mount its namespace before waiting for it')
const entries = new Map()
let dictionaries
let calls = 0
let rejectMove = false
let language = 'en'
let remoteMounted = false
const panelCalls = []
const panelFailures = {}
const clientArchived = new Set()
const clientArchiveCalls = []
const clientArchiveControl = {}
let releaseMount
const mountBarrier = new Promise(resolve => { releaseMount = resolve })
// Use a real plugin Context and a separately owned namespace service. The
// transport is in memory; Cordis performs the same inject checks as Gateway.
const uiContext = new Context()
const workspaceListeners = new Set()
const workspaceProjection = {
  getSnapshot: () => ({ archivedSessionIds: [...clientArchived], pinnedSessionIds: [] }),
  subscribe(listener) { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener) },
  replaceArchived(ids) {
    clientArchived.clear(); ids.forEach(id => clientArchived.add(id))
    queueMicrotask(() => workspaceListeners.forEach(listener => listener()))
  },
  replacePinned() {},
}
uiContext.provide('workspaces', { list: workspaceProjection })
uiContext.provide('locale', { register(ns, copy) {
  assert.equal(ns, 'trash'); dictionaries = copy
  return () => { dictionaries = null }
}, bind() { return (key, values) => translate(key, values) }, getSnapshot() { return { active: language } } })
uiContext.provide('slots', {
  inject(name, callback) { callback() },
  register(options, component) { entries.set(options.name === 'main' ? 'trash-main' : options.id, { options, component }) },
})
class TestRemote extends Service {
  constructor(ctx) { super(ctx, 'remote') }
  get trash() { return this.ctx['remote.trash'] }
  get workspace() { return this.ctx['remote.workspace'] }
  async $mount(contribution) {
    assert.equal(contribution.package, manifest.name)
    assert.equal(contribution.descriptors.length, 7)
    const wire = contribution.methods['trash/trashSession'].input().create().parse({ sessionId: 'probe' })
    assert.equal(wire.sessionId, 'probe')
    await mountBarrier
    const provider = uiContext.plugin({ apply(ctx) {
      ctx.provide('remote.trash', { async trashSession(id) {
        assert.equal(remoteMounted, true)
        calls++
        if (rejectMove) return { ok: false, error: { message: 'denied' } }
        return clientRemote.trash.trashSession(id)
      }, async listDistillAgents() {
        panelCalls.push(['listDistillAgents'])
        if (panelFailures.listDistillAgents) return { ok: false, error: { message: 'preset loading failed' } }
        return { ok: true, value: [{ id: 'preset-one', name: 'Preset One' }, { id: '__manual__', name: '' }] }
      }, async distillSession(id, preset) {
        panelCalls.push(['distillSession', id, preset])
        if (panelFailures.distillSession) return { ok: false, error: { message: 'Distill [agent]: injected failure' } }
        return { ok: true, value: { path: `/synthetic/${id}-distill.md`, summary: 'Saved summary', mode: preset === '__manual__' ? 'prompt' : 'agent' } }
      }, ...Object.fromEntries(['listTrash', 'restoreSession', 'removeFromTrash', 'emptyTrash'].map(method => [method, async (...args) => {
        panelCalls.push([method, ...args])
        if (panelFailures[method] === 'throw') throw new Error(`transport ${method}`)
        if (panelFailures[method]) return { ok: false, error: { message: `denied ${method}` } }
        const result = await clientRemote.trash[method](...args)
        return result
      }])) })
    } })
    await provider
    remoteMounted = true
    return async () => { await provider.dispose(); remoteMounted = false }
  }
}
uiContext.provide('remote.workspace', { async *follow(signal) {
  clientArchiveCalls.push('read-baseline')
  if (clientArchiveControl.fail) throw new Error('Workspace refresh transport')
  signal.throwIfAborted()
  yield { type: 'baseline', value: { archivedSessionIds: [...archived], pinnedSessionIds: [] } }
} })
new TestRemote(uiContext)
assert.equal(uiContext.get('remote.trash'), undefined)
let pluginContext
const mounting = uiContext.plugin({ ...plugin, async apply(ctx) {
  pluginContext = ctx
  return plugin.apply(ctx)
} })
assert.equal(entries.size, 0, 'slots must wait for the Remote namespace to mount')
assert.equal(dictionaries, undefined)
releaseMount()
await mounting
assert.throws(() => pluginContext.remote.trash,
  { message: 'cannot get property "remote.trash" without inject' })
assert.ok(pluginContext.get('remote.trash'), 'ctx.get is legal inside the real plugin fiber')
assert.equal(remoteMounted, true)
assert.equal(entries.size, 4)
assert.deepEqual([...entries.keys()].sort(), ['trash', 'trash-action', 'trash-main', 'trash-menu'])
assert.equal(entries.get('trash-main').options.key, 'trash')
for (const entry of entries.values()) assert.equal(entry.options.locale, 'trash')
assert.equal(entries.get('trash-menu').options.name, 'sidebar.workspaces.session.menu.item')
assert.equal(entries.get('trash-menu').options.order, 350)
assert.equal(entries.get('trash-action').options.name, 'sidebar.workspaces.session.row.action')
assert.equal(entries.get('trash-action').options.order, 50)
for (const lang of ['en', 'zh']) {
  const resource = JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')).trash
  assert.deepEqual(JSON.parse(JSON.stringify(dictionaries[lang])), resource)
}
const translate = (key, values = {}) => Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), dictionaries[language][key])
const tick = () => new Promise(resolve => setImmediate(resolve))
let dismissed = false
const menu = mount(entries.get('trash-menu'), { useMenuOpenState: () => [true, open => { dismissed = !open }] })
let tree = menu.render()
let button = find(tree, x => x.type === 'button')
button.props.onClick(); button.props.onClick()
await tick()
assert.equal(calls, 1)
assert.equal(dismissed, true)
assert.equal(records.has('ui-session'), true)
menu.unmount()
rejectMove = true
dismissed = false
const failedMenu = mount(entries.get('trash-menu'), { useMenuOpenState: () => [true, open => { dismissed = !open }] })
find(failedMenu.render(), x => x.type === 'button').props.onClick()
await tick()
assert.equal(dismissed, false)
assert.match(find(failedMenu.render(), x => x.props.role === 'alert').children.join(''), /denied/)
language = 'zh'
assert.match(find(failedMenu.render(), x => x.props.role === 'alert').children.join(''), /收进回收站失败/)
failedMenu.unmount()
rejectMove = false
const row = mount(entries.get('trash-action'))
tree = row.render()
assert.equal(find(tree, x => x.type === 'button').props['aria-label'], '收进回收站')
tree.props.ref.current = { getBoundingClientRect: () => ({ bottom: 100, right: 250 }) }
tree.props.onMouseEnter()
row.render()
for (const callback of timers.values()) callback()
tree = row.render()
assert.equal(find(tree, x => x.props.role === 'tooltip').children[0], '收进回收站')
// Escape hides an already visible tooltip through focus/hover changes.
tree.props.onKeyDown({ key: 'Escape' })
tree = row.render()
assert.equal(find(tree, x => x.props.role === 'tooltip'), undefined)
tree.props.onFocus()
row.render()
assert.equal(timers.size, 0)
tree.props.onMouseLeave()
tree.props.onBlur()
tree = row.render()
tree.props.onMouseEnter()
row.render()
assert.equal(timers.size, 1)
// Press Escape during the delay, before React commits another render.
tree.props.onKeyDown({ key: 'Escape' })
assert.equal(timers.size, 0, 'Escape must synchronously cancel the pending timer')
tree = row.render()
for (const callback of timers.values()) callback()
assert.equal(find(row.render(), x => x.props.role === 'tooltip'), undefined)
tree.props.onFocus()
row.render()
assert.equal(timers.size, 0, 'focus must not revive a dismissed hover cycle')
tree.props.onMouseLeave()
tree.props.onBlur()
tree = row.render()
tree.props.onFocus()
row.render()
assert.equal(timers.size, 1, 'a new focus cycle may show a tooltip')
for (const callback of timers.values()) callback()
tree = row.render()
assert.ok(find(tree, x => x.props.role === 'tooltip'))
find(tree, x => x.type === 'button').props.onClick()
await tick()
assert.equal(calls, 3)
row.unmount()
assert.equal(timers.size, 0)
assert.equal(listeners.size, 0)
await (await import('./client-panel-regressions.mjs')).runPanelRegressions({
  entries, mount, find, tick, records, archived, panelCalls, panelFailures,
  browser, timers, timerDelays,
  clientArchived, clientArchiveCalls, clientArchiveControl, hostRemote: uiContext.get('remote.trash'),
  setLanguage(value) { language = value },
})
await mounting.dispose()
assert.equal(remoteMounted, false)
assert.equal(uiContext.get('remote.trash'), undefined)
await assert.rejects(plugin.apply({
  remote: { async $mount() { throw new Error('mount failed') } },
  effect() { assert.fail('locale must not register after a failed Remote mount') },
  slots: { inject() { assert.fail('slots must not register after a failed Remote mount') } },
}), /mount failed/)
let capabilityRemoteDisposed = false
await assert.rejects(plugin.apply({
  remote: { async $mount() { return async () => { capabilityRemoteDisposed = true } }, workspace: {} },
  get() { return clientRemote.trash }, workspaces: { list: {} },
  effect() { assert.fail('missing capability must fail before registering UI effects') },
}), /requires Workspace/)
assert.equal(capabilityRemoteDisposed, true, 'missing capability must release the mounted Remote')
assert.equal(dictionaries, null)
await uiContext.fiber.dispose()
await ctx.fiber.dispose()
assert.equal(closed, 1)
console.log('PASS: Host registration/lifecycle, 7 Remote codecs, named wire dispatch, real Cordis Client inject checks and menu/hover calls, bilingual copy, failures, duplicate clicks, tooltip cleanup')

await import('./host-regressions.mjs')
await import('./generator-regressions.mjs')

await import('./platform-regressions.mjs')
await import('./system-trash-regressions.mjs')
await import('./phase4-regressions.mjs')
await import('./ghost-regressions.mjs')
await import('./operation-log-regressions.mjs')
await import('./deferred-regressions.mjs')
await import('./reappear-regressions.mjs')

await import('./distill-regressions.mjs')
