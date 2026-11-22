// Minimal hook renderer shared by isolated integration probes. It does not
// substitute business state or transports; render explicitly after settling.
module.exports = function clientHarness(translate) {
let hooks
const React = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
  useState(value) {
    const owner = hooks; const i = owner.cursor++; owner.values[i] ??= { value }
    return [owner.values[i].value, v => {
      if (owner.disposed) owner.lateUpdates++
      else owner.values[i].value = v
    }]
  },
  useRef(value) { const i = hooks.cursor++; return hooks.values[i] ??= { current: value } },
  useId() { const i = hooks.cursor++; return `trash-test-${i}` },
  useEffect(effect, deps) {
    const i = hooks.cursor++
    const old = hooks.values[i]
    if (old && deps.every((v, n) => v === old.deps[n])) return
    old?.cleanup?.()
    hooks.values[i] = { deps, cleanup: null }
    const owner = hooks
    hooks.effects.push(() => { owner.values[i].cleanup = effect() })
  },
}

function mount(entry, extra = {}) {
  const states = new Map()
  const props = { sessionId: 'ui-session', t: translate, ...entry.options.inject?.(), ...extra }
  function renderComponent(component, input, path) {
    const state = states.get(path) ?? { cursor: 0, values: [], effects: [], disposed: false, lateUpdates: 0 }
    states.set(path, state)
    hooks = state; state.cursor = 0; state.effects = []
    const tree = component(input)
    for (const effect of state.effects) effect()
    return expand(tree, path)
  }
  function expand(tree, path) {
    if (!tree || typeof tree !== 'object') return tree
    if (typeof tree.type === 'function') return renderComponent(tree.type, tree.props, `${path}/component`)
    return { ...tree, children: tree.children?.map((child, i) => expand(child, `${path}/${child?.props?.key ?? i}`)) }
  }
  const render = () => {
    return renderComponent(entry.component, props, 'root')
  }
  return {
    render,
    get lateUpdates() { return [...states.values()].reduce((n, state) => n + state.lateUpdates, 0) },
    unmount() {
      for (const state of states.values()) {
        state.disposed = true
        for (const item of state.values) item?.cleanup?.()
      }
    },
  }
}
function find(tree, test) {
  if (!tree || typeof tree !== 'object') return undefined
  if (test(tree)) return tree
  return tree.children?.map(child => find(child, test)).find(Boolean)
}

return { React, mount, find }
}
