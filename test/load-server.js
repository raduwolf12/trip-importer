'use strict'
// Loads server/index.js unchanged in a vm context so tests can reach its top-level helper
// functions (function declarations become context globals) and its route handlers.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

module.exports = function loadServer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8')
  const sandbox = {
    module: { exports: {} },
    require: id => id === 'trek-plugin-sdk' ? { definePlugin: def => def } : require(id),
    console, process, setTimeout, clearTimeout, URL, AbortController, fetch, Intl, Buffer,
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'server/index.js' })
  const plugin = sandbox.module.exports
  const ctx = { log: { info() {}, warn() {}, error() {} } }
  async function call(routePath, body) {
    const route = plugin.routes.find(r => r.path === routePath)
    if (!route) throw new Error('no route ' + routePath)
    const res = await route.handler({ body }, ctx)
    return JSON.parse(res.body)
  }
  return { fn: sandbox, plugin, call }
}
