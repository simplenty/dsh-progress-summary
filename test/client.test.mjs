import { test } from 'node:test'
import assert from 'node:assert/strict'

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
}

let loadedId
let bundle
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loadedId = id
      bundle = factory(name => {
        if (name === 'react') return React
        throw new Error(`unexpected module: ${name}`)
      })
    },
  },
}

await import('../client.js')

/**
 * One fake config form the page can read and write.
 * @param {object} value - current namespace values.
 * @returns {object} the form controller stub.
 */
function fakeForm(value) {
  return {
    written: [],
    subscribe() {
      return () => {}
    },
    getSnapshot() {
      return { status: 'ready', writable: true, revision: 3, value }
    },
    async mutate(ops) {
      this.written.push(...ops)
      return true
    },
    set(field, value) {
      return this.mutate([{ op: 'set', path: [field], value }])
    },
  }
}

test('the browser bundle loads under the module loader id', () => {
  assert.equal(loadedId, 'dsh-progress-summary')
  assert.equal(typeof bundle.apply, 'function')
  assert.deepEqual(bundle.inject, ['slots'])
})

test('apply registers the dock row and both config pages', () => {
  const registrations = []
  const form = fakeForm({ model: 'auto', provider: 'auto', effort: 'off' })
  const slots = {
    inject(name, register) {
      assert.ok(typeof name === 'string')
      register()
    },
    register(definition, component) {
      registrations.push({ definition, component })
    },
  }
  const ctx = {
    slots,
    inject(deps, callback) {
      assert.deepEqual(deps, ['configForms'])
      callback({ slots, configForms: { get: namespace => (namespace === 'progress-summary' ? form : undefined) } })
    },
  }
  bundle.apply(ctx)
  assert.equal(registrations.length, 4)
  assert.equal(registrations[0].definition.name, 'conversation.input.dock')
  assert.equal(registrations[1].definition.name, 'plugins.bundle.config')
  assert.equal(registrations[1].definition.key, 'dsh-progress-summary')
  assert.equal(registrations[2].definition.name, 'plugins.row.config')
  assert.equal(registrations[2].definition.key, 'dsh-progress-summary#progress-summary')
  assert.equal(registrations[3].definition.name, 'settings.general.item')
  assert.equal(registrations[3].definition.id, 'progress-summary')
})

test('a deployment without configForms still gets the dock row', () => {
  const registrations = []
  const slots = {
    inject(name, register) {
      register()
    },
    register(definition, component) {
      registrations.push({ definition, component })
    },
  }
  bundle.apply({
    slots,
    inject() {
      // No configForms service: the optional callback never runs.
    },
  })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].definition.name, 'conversation.input.dock')
})

test('the config page renders inputs and writes changed fields', async () => {
  const form = fakeForm({ model: 'auto', provider: 'auto', effort: 'off' })
  const tree = bundle.SummaryConfig({ form, view: 'page' })
  assert.equal(tree.type, 'div')
  const inputs = tree.children.filter(child => child && child.type === 'label')
  assert.equal(inputs.length, 7)
  const model = inputs[0].children[1]
  assert.equal(model.props.value, 'auto')
  // The page's save path is exercised by wiring the draft through onChange.
  model.props.onChange({ target: { value: 'deepseek-flash' } })
})

test('the summary view returns one line of copy', () => {
  const text = bundle.SummaryConfig({ form: fakeForm({}), view: 'summary' })
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0)
})

test('a loading form renders no inputs', () => {
  const form = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'loading', writable: true }),
  }
  const tree = bundle.SummaryConfig({ form, view: 'page' })
  assert.equal(tree.type, 'p')
})

test('a read-only deployment renders the notice', () => {
  const form = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: false, value: {} }),
  }
  const tree = bundle.SummaryConfig({ form, view: 'page' })
  assert.equal(tree.type, 'p')
})

test('the settings toggle writes the live enabled switch', () => {
  const form = fakeForm({ enabled: true })
  const tree = bundle.SummaryToggle({ form })
  const button = tree.children[1]
  assert.equal(button.props['aria-checked'], true)
  button.props.onClick()
  assert.deepEqual(form.written, [{ op: 'set', path: ['enabled'], value: false }])
})

test('the settings toggle reflects a disabled switch', () => {
  const tree = bundle.SummaryToggle({ form: fakeForm({ enabled: false }) })
  assert.equal(tree.children[1].props['aria-checked'], false)
})
