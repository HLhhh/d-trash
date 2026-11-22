import assert from 'node:assert/strict'

export async function runPanelRegressions({ entries, mount, find, tick, records, archived,
  panelCalls, panelFailures, setLanguage, clientArchived, clientArchiveCalls, clientArchiveControl, hostRemote }) {
  const sidebar = entries.get('trash')
  const panel = entries.get('trash-main')
  assert.equal(sidebar.options.name, 'sidebar.panellist')
  assert.equal(panel.options.name, 'main')
  assert.equal(sidebar.options.id, 'trash')
  assert.equal(panel.options.key, sidebar.options.id)
  assert.equal(panel.options.locale, 'trash')
  setLanguage('en')
  assert.equal(sidebar.options.label(), 'Trash')
  setLanguage('zh')
  assert.equal(sidebar.options.label(), '回收站', 'label thunk must read the current language')
  const icon = mount(sidebar, { size: 22, active: true })
  assert.equal(find(icon.render(), x => x.type === 'svg').props.width, 22)
  icon.unmount()
  setLanguage('en')

  const summaries = {}
  const selectorIds = []
  const useSessions = selector => selector({ byId: new Proxy(summaries, {
    get(target, id) { selectorIds.push(id); return target[id] },
  }) })
  const workspaces = [{ workspaceId: 'work-one', title: 'Workspace One', sessionIds: ['snapshot', 'live-menu'] }]
  let archiveSnapshot = []
  const useWorkspaces = selector => {
    const next = [...clientArchived]
    if (next.length !== archiveSnapshot.length || next.some((id, i) => id !== archiveSnapshot[i])) archiveSnapshot = next
    return selector({ archivedSessionIds: archiveSnapshot, items: workspaces })
  }
  const setup = () => mount(panel, { useSessions, useWorkspaces })
  const all = (tree, test) => {
    if (!tree || typeof tree !== 'object') return []
    return [...(test(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => all(child, test))]
  }
  const text = tree => {
    if (tree === null || tree === undefined || tree === false) return ''
    if (typeof tree !== 'object') return String(tree)
    return (tree.children ?? []).map(text).join(' ')
  }
  const button = (tree, label) => {
    const result = find(tree, x => x.type === 'button' && text(x) === label)
    assert.ok(result, `missing button ${label}`)
    return result
  }
  const row = (tree, title) => {
    const result = find(tree, x => x.type === 'li' && text(x).includes(title))
    assert.ok(result, `missing row ${title}`)
    return result
  }
  const group = tree => {
    const result = find(tree, x => x.props.role === 'group')
    assert.ok(result, 'confirmation must appear')
    return result
  }
  const callsOf = method => panelCalls.filter(call => call[0] === method)
  const assertAlert = (tree, pattern) => assert.match(text(find(tree, x => x.props.role === 'alert')), pattern)
  const seed = (id, record = {}) => {
    records.set(id, { trashedAt: 1_700_000_000_000, ...record }); archived.add(id)
    clientArchived.add(id)
  }

  records.clear()
  panelCalls.length = 0
  let view = setup()
  assert.match(text(view.render()), /(?:Loading trash…|Working…)/)
  await tick()
  let tree = view.render()
  assert.match(text(tree), /Trash is empty/)
  assert.equal(button(tree, 'Empty trash').props.disabled, true)
  assert.deepEqual(panelCalls, [['listTrash']])
  setLanguage('zh')
  assert.match(text(view.render()), /回收站是空的/)
  view.unmount()
  setLanguage('en')

  // Both entry points publish into every already mounted panel, without a
  // remount or list call. A delayed mount baseline must not erase the move.
  view = setup(); view.render(); await tick()
  const remote = panel.options.inject().trash
  const initialList = remote.listTrash
  let finishBaseline
  remote.listTrash = () => new Promise(resolve => { finishBaseline = resolve })
  const observer = setup(); observer.render()
  const move = entries.get('trash-menu').options.inject().moveToTrash
  let archiveCalls = clientArchiveCalls.length
  for (const [slot, id] of [['trash-menu', 'live-menu'], ['trash-action', 'live-hover']]) {
    const action = mount(entries.get(slot), { sessionId: id, useMenuOpenState: () => [true, () => {}] })
    find(action.render(), x => x.type === 'button').props.onClick()
    await tick()
    assert.ok(row(view.render(), id), 'an open panel must receive a successful move')
    assert.ok(row(observer.render(), id), 'all subscribers must update')
    assert.equal(clientArchived.has(id), true, 'the Client archive snapshot must be synchronized')
    assert.ok(clientArchiveCalls.length > archiveCalls, 'move must read a Workspace baseline')
    archiveCalls = clientArchiveCalls.length
    action.unmount()
  }
  finishBaseline({ ok: true, value: [] }); await tick()
  assert.ok(row(observer.render(), 'live-menu'), 'stale mount list must not undo a move')
  assert.ok(row(observer.render(), 'live-hover'))
  remote.listTrash = initialList

  // Reproduce response reordering through the real registered move closure
  // and Host service, rather than calling store.upsert/remove in the test.
  const originalHostMove = hostRemote.trashSession
  for (const slot of ['trash-menu', 'trash-action']) {
    for (const destructive of ['Delete forever', 'Empty trash']) {
      let releaseResponse, signalCommit
      const committed = new Promise(resolve => { signalCommit = resolve })
      const response = new Promise(resolve => { releaseResponse = resolve })
      const id = `race-${slot}-${destructive}`
      await move(id)
      hostRemote.trashSession = async sessionId => {
        const result = await originalHostMove(sessionId)
        signalCommit()
        await response
        return result
      }
      const late = entries.get(slot).options.inject().moveToTrash(id)
      await committed
      if (destructive === 'Delete forever') button(row(view.render(), id.slice(0, 12)), destructive).props.onClick()
      else button(view.render(), destructive).props.onClick()
      button(group(view.render()), destructive).props.onClick(); await tick()
      assert.equal(records.has(id), false)
      const reads = callsOf('listTrash').length
      releaseResponse(); await late; await tick()
      assert.ok(callsOf('listTrash').length > reads, 'old write response must reload authority')
      for (const target of [view, observer]) assert.equal(all(target.render(), node =>
        node.type === 'h2' && node.props.title === id).length, 0, 'old response cannot revive a row')
      hostRemote.trashSession = originalHostMove
    }
  }
  // Empty above intentionally removed the earlier rows; restore the live
  // fixtures used by the rest of the panel lifecycle regressions.
  await move('live-menu'); await move('live-hover')
  archiveCalls = clientArchiveCalls.length

  // Failed Host calls publish nothing and never issue a Workspace write.
  const originalTrash = remote.trashSession
  remote.trashSession = async () => ({ ok: false, error: { message: 'host denied' } })
  await assert.rejects(move('failed-host'), /host denied/)
  assert.equal(clientArchiveCalls.length, archiveCalls)
  assert.doesNotMatch(text(view.render()), /failed-host/)
  remote.trashSession = originalTrash

  // A failed read-only refresh cannot undo an already committed Host marker. Retry
  // is safe and the shared cache still contains only one row for the id.
  clientArchiveControl.fail = true
  await assert.rejects(move('echo-retry'), /Workspace refresh transport/)
  assert.equal(records.has('echo-retry'), true)
  assert.doesNotMatch(text(view.render()), /echo-retry/, 'a marker without a Client archive must stay hidden until refresh/follow')
  delete clientArchiveControl.fail
  await move('echo-retry')
  assert.equal(all(view.render(), x => x.type === 'li' && text(x).includes('echo-retry')).length, 1)

  // Native buttons and other plugins only change the archive authority; they
  // do not publish to trashStore. Both panels must hide the cached row anyway.
  for (const id of ['native-unarchive', 'other-plugin-unarchive']) {
    await move(id)
    assert.ok(row(view.render(), id.slice(0, 12)))
    assert.ok(row(observer.render(), id.slice(0, 12)))
    const staleRecord = structuredClone(records.get(id))
    const before = panelCalls.length
    archived.delete(id)
    clientArchived.delete(id)
    assert.equal(records.has(id), true, 'UI filtering must not write Host storage')
    assert.doesNotMatch(text(view.render()), new RegExp(id.slice(0, 12)))
    assert.doesNotMatch(text(observer.render()), new RegExp(id.slice(0, 12)))
    assert.equal(panelCalls.length, before, 'native unarchive needs no trash mutation or list response to hide')

    // Even an old response arriving after unarchive stays invisible.
    let finishStale
    remote.listTrash = () => new Promise(resolve => { finishStale = resolve })
    button(view.render(), 'Refresh').props.onClick()
    await tick()
    finishStale({ ok: true, value: [[id, staleRecord], ...records].filter(([key], i) => key !== id || i === 0) })
    await tick()
    assert.doesNotMatch(text(view.render()), new RegExp(id.slice(0, 12)))
    assert.doesNotMatch(text(observer.render()), new RegExp(id.slice(0, 12)))
    remote.listTrash = initialList
    button(view.render(), 'Refresh').props.onClick(); await tick()
    assert.equal(records.has(id), false, 'next real Host list must persist reconciliation')
  }
  console.log('PASS: unarchive panels filter native/plugin changes immediately, retain Host ownership, and reject stale response visibility')

  // Mutation success updates subscribers before its authoritative reload
  // resolves. Even a reload failure must not resurrect the removed row.
  let finishReload
  remote.listTrash = () => new Promise(resolve => { finishReload = resolve })
  button(row(view.render(), 'live-menu'), 'Restore').props.onClick()
  await tick()
  assert.doesNotMatch(text(view.render()), /live-menu/)
  assert.doesNotMatch(text(observer.render()), /live-menu/)
  finishReload({ ok: false, error: { message: 'reload denied' } }); await tick()
  assert.doesNotMatch(text(view.render()), /live-menu/)
  assertAlert(view.render(), /Could not load trash/)

  button(row(view.render(), 'live-hover'), 'Delete forever').props.onClick()
  button(group(view.render()), 'Delete forever').props.onClick()
  await tick()
  assert.doesNotMatch(text(view.render()), /live-hover/)
  assert.doesNotMatch(text(observer.render()), /live-hover/)
  finishReload({ ok: true, value: [...records] }); await tick()

  button(view.render(), 'Empty trash').props.onClick()
  button(group(view.render()), 'Empty trash').props.onClick()
  await tick()
  assert.equal(all(view.render(), x => x.type === 'li').length, 0)
  assert.equal(all(observer.render(), x => x.type === 'li').length, 0)
  finishReload({ ok: true, value: [] }); await tick()
  remote.listTrash = initialList
  observer.unmount()
  await move('after-unmount')
  assert.equal(observer.lateUpdates, 0, 'unsubscribed panel must never receive cache updates')
  button(view.render(), 'Refresh').props.onClick(); await tick()
  const synced = find(row(view.render(), 'after-unmoun'), x => x.type === 'time')
  assert.equal(synced.props.dateTime, new Date(records.get('after-unmount').trashedAt).toISOString(),
    'list baseline must reconcile the authoritative Host timestamp')
  view.unmount()
  records.clear()
  panelCalls.length = 0

  // Isolate the Client guard from Host filtering: even an entirely stale
  // baseline must produce the empty state and disable destructive actions.
  remote.listTrash = async () => ({ ok: true, value: [['active-only', { trashedAt: 1 }]] })
  view = setup(); view.render(); await tick(); tree = view.render()
  assert.match(text(tree), /Trash is empty/)
  assert.equal(all(tree, x => x.type === 'li').length, 0)
  assert.equal(button(tree, 'Empty trash').props.disabled, true)
  view.unmount()
  remote.listTrash = initialList

  seed('snapshot', { titleSnapshot: 'Saved title', workspaceId: 'work-one', trashedAt: 1_700_000_000_100 })
  seed('catalog-title')
  seed('catalog-display')
  seed('missing-session-1234567890')
  summaries.snapshot = { title: 'New title', displayTitle: 'New title' }
  summaries['catalog-title'] = { title: 'Live title', displayTitle: 'Other display' }
  summaries['catalog-display'] = { title: ' ', displayTitle: 'Display title' }
  view = setup(); view.render(); await tick(); tree = view.render()
  assert.equal(all(tree, x => x.type === 'li').length, 4)
  assert.match(text(tree), /Saved title/)
  assert.doesNotMatch(text(tree), /New title/)
  assert.match(text(tree), /Live title/)
  assert.match(text(tree), /Display title/)
  assert.match(text(tree), /missing-sess/)
  assert.match(text(tree), /Workspace: Workspace One/)
  const time = find(row(tree, 'Saved title'), x => x.type === 'time')
  assert.equal(time.props.dateTime, new Date(1_700_000_000_100).toISOString())
  assert.equal(all(tree, x => x.type === 'li')[0].children[0].children[0], 'Saved title')
  assert.ok(selectorIds.includes('catalog-title'))
  summaries['catalog-title'].title = 'Renamed title'
  assert.match(text(view.render()), /Renamed title/)

  let listCalls = callsOf('listTrash').length
  button(row(tree, 'Saved title'), 'Restore').props.onClick()
  button(row(tree, 'Saved title'), 'Restore').props.onClick()
  assert.equal(button(view.render(), 'Refresh').props.disabled, true)
  await tick(); tree = view.render()
  assert.deepEqual(callsOf('restoreSession'), [['restoreSession', 'snapshot']])
  assert.equal(records.has('snapshot'), false)
  assert.equal(archived.has('snapshot'), false)
  assert.equal(callsOf('listTrash').length, ++listCalls)
  assert.doesNotMatch(text(tree), /Saved title/)

  button(row(tree, 'Renamed title'), 'Delete forever').props.onClick()
  assert.equal(callsOf('removeFromTrash').length, 0, 'first click must only ask for confirmation')
  tree = view.render()
  group(tree).props.onKeyDown({ key: 'Escape' })
  assert.equal(find(view.render(), x => x.props.role === 'group'), undefined)
  button(row(view.render(), 'Renamed title'), 'Delete forever').props.onClick()
  button(group(view.render()), 'Cancel').props.onClick()
  assert.equal(callsOf('removeFromTrash').length, 0)
  button(row(view.render(), 'Renamed title'), 'Delete forever').props.onClick()
  tree = view.render()
  assert.match(text(group(tree)), /Physical deletion.*cannot be undone/)
  button(group(tree), 'Delete forever').props.onClick()
  button(group(tree), 'Delete forever').props.onClick()
  await tick(); tree = view.render()
  assert.deepEqual(callsOf('removeFromTrash'), [['removeFromTrash', 'catalog-title']])
  assert.equal(records.has('catalog-title'), false)
  assert.equal(archived.has('catalog-title'), false, 'physical deletion clears native archive')
  assert.equal(callsOf('listTrash').length, ++listCalls)

  button(tree, 'Empty trash').props.onClick()
  assert.equal(callsOf('emptyTrash').length, 0)
  button(group(view.render()), 'Cancel').props.onClick()
  assert.equal(callsOf('emptyTrash').length, 0)
  button(view.render(), 'Empty trash').props.onClick()
  group(view.render()).props.onKeyDown({ key: 'Escape' })
  assert.equal(find(view.render(), x => x.props.role === 'group'), undefined)
  button(view.render(), 'Empty trash').props.onClick()
  tree = view.render()
  button(group(tree), 'Empty trash').props.onClick()
  button(group(tree), 'Empty trash').props.onClick()
  await tick(); tree = view.render()
  assert.deepEqual(callsOf('emptyTrash'), [['emptyTrash']])
  assert.equal(records.size, 0)
  assert.equal(archived.has('catalog-display'), false)
  assert.equal(callsOf('listTrash').length, ++listCalls)
  assert.match(text(tree), /Trash is empty/)
  view.unmount()

  // Each operation must surface both RemoteResult and transport failures,
  // retain its row/confirmation for retry, and reload partial Host commits after rejection.
  for (const [method, label, failurePattern] of [
    ['restoreSession', 'Restore', /Could not restore session/],
    ['removeFromTrash', 'Delete forever', /Could not physically delete session/],
    ['emptyTrash', 'Empty trash', /Could not empty trash/],
  ]) {
    for (const failure of [true, 'throw']) {
      records.clear(); seed('retry', { titleSnapshot: 'Retry title' })
      view = setup(); view.render(); await tick(); tree = view.render()
      panelFailures[method] = failure
      listCalls = callsOf('listTrash').length
      button(tree, label).props.onClick()
      if (method !== 'restoreSession') button(group(view.render()), label).props.onClick()
      await tick(); tree = view.render()
      assertAlert(tree, failurePattern)
      assertAlert(tree, failure === 'throw' ? /transport/ : /denied/)
      assert.equal(records.has('retry'), true)
      assert.equal(callsOf('listTrash').length, listCalls + 1)
      setLanguage('zh')
      assertAlert(view.render(), /失败/)
      setLanguage('en')
      delete panelFailures[method]
      button(method === 'restoreSession' ? tree : group(tree), label).props.onClick()
      await tick()
      assert.equal(records.has('retry'), false)
      assert.equal(find(view.render(), x => x.props.role === 'alert'), undefined)
      view.unmount()
    }
  }

  records.clear()
  panelFailures.listTrash = true
  view = setup(); view.render(); await tick(); tree = view.render()
  assertAlert(tree, /Could not load trash: denied listTrash/)
  assert.doesNotMatch(text(tree), /Trash is empty/, 'a load failure is not an empty list')
  delete panelFailures.listTrash
  button(tree, 'Refresh').props.onClick(); await tick()
  assert.match(text(view.render()), /Trash is empty/)
  view.unmount()

  seed('refresh-failure', { titleSnapshot: 'Stale title' })
  view = setup(); view.render(); await tick(); tree = view.render()
  panelFailures.listTrash = 'throw'
  button(tree, 'Restore').props.onClick(); await tick(); tree = view.render()
  assert.equal(records.has('refresh-failure'), false)
  assert.doesNotMatch(text(tree), /Stale title/, 'successful restore is immediate despite reload failure')
  assertAlert(tree, /Could not load trash: .*transport listTrash/)
  assert.doesNotMatch(text(tree), /Could not restore session/)
  delete panelFailures.listTrash
  button(tree, 'Refresh').props.onClick(); await tick()
  assert.match(text(view.render()), /Trash is empty/)
  view.unmount()

  // A record-cleanup failure may already have removed the native archive.
  // The diagnostic receipt must stay visible and cannot offer a bogus restore.
  const listBeforePending = remote.listTrash
  remote.listTrash = async () => ({ ok: true, value: [['pending-deletion', { trashedAt: 1, purgePending: true }]] })
  view = setup(); view.render(); await tick(); tree = view.render()
  assert.match(text(tree), /Deletion is unfinished/)
  assert.equal(button(row(tree, 'pending-dele'), 'Restore').props.disabled, true)
  setLanguage('zh')
  assert.match(text(view.render()), /删除尚未完成/)
  button(view.render(), '彻底删除').props.onClick()
  assert.match(text(group(view.render())), /物理删除.*不可恢复/)
  setLanguage('en')
  assert.match(text(group(view.render())), /Physically delete.*cannot be undone/)
  view.unmount()
  remote.listTrash = listBeforePending

  // Delayed mount responses and operation completion cannot revive an
  // unmounted panel or trigger a subsequent request.
  let resolveList
  const injected = panel.options.inject()
  const originalList = injected.trash.listTrash
  injected.trash.listTrash = () => new Promise(resolve => { resolveList = resolve })
  view = setup(); view.render(); view.unmount()
  resolveList({ ok: true, value: [['late', { trashedAt: 0 }]] }); await tick()
  injected.trash.listTrash = originalList
  assert.equal(view.lateUpdates, 0, 'unmounted response must not update state')
  seed('pending-restore', { titleSnapshot: 'Pending restore' })
  let resolveRestore
  const originalRestore = injected.trash.restoreSession
  injected.trash.restoreSession = () => new Promise(resolve => { resolveRestore = resolve })
  view = setup(); view.render(); await tick()
  button(view.render(), 'Restore').props.onClick()
  view.unmount()
  listCalls = callsOf('listTrash').length
  resolveRestore({ ok: true, value: undefined }); await tick()
  assert.equal(callsOf('listTrash').length, listCalls, 'unmounted mutation must not reload')
  assert.equal(view.lateUpdates, 0, 'unmounted mutation must not update state')
  injected.trash.restoreSession = originalRestore
  console.log('PASS: Phase 3 shared live panels, menu/hover move publication, Workspace read-only refresh/retry, stale baseline merge, immediate mutation removal, paired slots, titles, confirmations, bilingual failures and unmount')
}
