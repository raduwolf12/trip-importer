'use strict'
// Loads server/index.js unchanged in a vm context so tests can reach its top-level helper
// functions (function declarations become context globals) and its route handlers.
//
// opts.fakeClock: simulated time instead of real waiting. Every setTimeout under 2s (the file's
// sleep() calls) advances the clock and fires at once, so /import's 6s budget runs out on
// simulated sleeps exactly like it would for real — in milliseconds. Timers of 2s+ are the
// file's fetch-abort guards (2500/3000ms) and never fire here.
// opts.fetch: replaces global fetch (reverse geocoding, cover photos).
const fs = require('fs')
const path = require('path')
const vm = require('vm')

module.exports = function loadServer(opts = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8')
  const sandbox = {
    module: { exports: {} },
    require: id => id === 'trek-plugin-sdk' ? { definePlugin: def => def } : require(id),
    console, process, setTimeout, clearTimeout, URL, AbortController, Intl, Buffer,
    fetch: opts.fetch || fetch,
  }
  if (opts.fakeClock) {
    let now = Date.UTC(2026, 0, 1)
    sandbox.Date = class extends Date { static now() { return now } }
    sandbox.setTimeout = (fn, ms) => {
      if (ms >= 2000) return 0
      now += ms || 0
      queueMicrotask(fn)
      return 0
    }
    sandbox.clearTimeout = () => {}
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'server/index.js' })
  const plugin = sandbox.module.exports
  const defaultCtx = { log: { info() {}, warn() {}, error() {} } }
  async function call(routePath, body, ctx = defaultCtx) {
    const route = plugin.routes.find(r => r.path === routePath)
    if (!route) throw new Error('no route ' + routePath)
    const res = await route.handler({ body }, ctx)
    return JSON.parse(res.body)
  }
  return { fn: sandbox, plugin, call }
}
