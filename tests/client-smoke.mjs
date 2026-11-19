/**
 * Dev-only smoke test for the browser half: evaluates client.js against a
 * minimal `window.__ModuleLoader__` + React stub and asserts the slot
 * registrations, locale dictionaries and panel label the plugin produces.
 *
 * Run: node NOTES/client-smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')
const source = readFileSync(clientPath, 'utf8')

let definition = null
const windowStub = {
  localStorage: {
    store: new Map(),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
    setItem(key, value) { this.store.set(key, String(value)) },
    removeItem(key) { this.store.delete(key) },
  },
  __ModuleLoader__: {
    load(next) { definition = next },
  },
}

const reactStub = {
  createElement() { return null },
  useState() { return [undefined, () => {}] },
  useEffect() {},
  useMemo(fn) { return fn() },
  useRef(value) { return { current: value } },
}

const requireStub = specifier => {
  if (specifier === 'react') return reactStub
  throw new Error('unexpected require: ' + specifier)
}

// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(windowStub, requireStub)

assert.ok(definition, 'the module registered a loader definition')
assert.equal(definition.id, 'dsh-movie-workbench', 'loader id equals the package name')
assert.equal(typeof definition.factory, 'function', 'factory is a function')

const plugin = definition.factory(requireStub)
assert.deepEqual(plugin.inject, ['slots', 'locale'], 'declares the slot and locale services')
assert.equal(typeof plugin.apply, 'function', 'returns an apply function')

const registrations = []
const locales = new Map()
const active = { id: 'zh' }
let disposed = 0
const disposer = () => { disposed += 1 }

const ctx = {
  locale: {
    register(ns, locale, dict) {
      locales.set(ns + ':' + locale, dict)
      return disposer
    },
    bind(ns) {
      return (key, params) => {
        const dict = locales.get(ns + ':' + active.id)
        let template = dict[key]
        if (template === undefined) return key
        if (params) template = template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        return template
      }
    },
    getSnapshot() { return { active: active.id, locales: [], revision: 0 } },
  },
  slots: {
    inject(key, callback) {
      callback()
      return disposer
    },
    register(options, component) {
      registrations.push({ options, component })
      return disposer
    },
  },
  effect(callback) {
    const cleanup = callback()
    return () => { cleanup() }
  },
}

plugin.apply(ctx)

const zh = locales.get('movies.workbench:zh')
const en = locales.get('movies.workbench:en')
assert.ok(zh && en, 'registers zh and en dictionaries')
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en dictionaries share one key set')

const panel = registrations.find(entry => entry.options.name === 'sidebar.panellist')
const main = registrations.find(entry => entry.options.name === 'main')
assert.ok(panel, 'registers a sidebar panel icon')
assert.ok(main, 'registers the matching main panel page')
assert.equal(panel.options.id, 'movies-workbench', 'panel id')
assert.equal(main.options.key, panel.options.id, 'main key equals the sidebar panel id')
assert.equal(panel.options.locale, 'movies.workbench', 'panel copy uses the plugin namespace')
assert.equal(panel.options.order, 20, 'panel order')
assert.equal(typeof panel.options.label, 'function', 'label is a thunk so it follows the locale')
assert.equal(panel.options.label(), '影视工作台', 'zh label')
assert.equal(typeof panel.component, 'function', 'icon component')
assert.equal(typeof main.component, 'function', 'page component')
assert.equal(typeof main.options.inject, 'function', 'page receives injected face')
const face = main.options.inject()
assert.equal(typeof face.t, 'function', 'injected translate')
assert.equal(face.t('title'), '影视工作台', 'zh title')
active.id = 'en'
assert.equal(panel.options.label(), 'Movies workbench', 'en label follows the active locale')
assert.equal(face.t('title'), 'Movies workbench', 'en title follows the active locale')

console.log('PASS client smoke:')
console.log('  registrations:', registrations.map(entry => entry.options.name).join(', '))
console.log('  panel id/key:', panel.options.id)
console.log('  locales:', [...locales.keys()].join(', '))
console.log('  label zh/en:', zh.panel, '/', en.panel)
