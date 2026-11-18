#!/usr/bin/env node
/**
 * The nested live proof's in-VM half (nested-proof.js): runs INSIDE the outer VM hvnest-proof, as proofuser over SSH,
 * and bridges the host-side driver to one server.js session (client.js), so a lease lives as long as this process.
 * Line protocol on stdio: { id, tool, args } in, { id, text, isError } out; { end: true } closes the session.
 * A reply that says "still in progress" is followed by vm_wait until it settles (MC-1553), so the driver sees results.
 * argv[2]: base64 JSON of extra env, HYPERV_MCP_* keys only (a timing setting, for MC-1561).
 */
'use strict'
const { createInterface } = require('readline')
const { server } = require('../../client')

const extra = process.argv[2] ? JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8')) : {}
const env = { ...process.env, HYPERV_MCP_ENABLED: '1' }
for (const [k, v] of Object.entries(extra)) if (/^HYPERV_MCP_[A-Z_]+$/.test(k) && k !== 'HYPERV_MCP_MODE' && k !== 'HYPERV_MCP_PIPE') env[k] = String(v)
const srv = server(env, { roots: process.env.USERPROFILE ? [process.env.USERPROFILE] : undefined })
const out = m => process.stdout.write(JSON.stringify(m) + '\n')
const MAX_WAITS = 480 // vm_wait waits up to 45 s each: about 6 hours, beyond any bound of the helper's

let queue = Promise.resolve()
createInterface({ input: process.stdin }).on('line', line => {
  let m
  try { m = JSON.parse(line) } catch { return }
  queue = queue.then(async () => {
    if (m.end) { await srv.close(); process.exit(0) }
    try {
      let r = await srv.call(m.tool, m.args || {})
      for (let i = 0; i < MAX_WAITS && !r.isError && /is still in progress after \d+ s/.test(r.text); i++) r = await srv.call('vm_wait')
      out({ id: m.id, text: r.text, isError: r.isError })
    } catch (e) { out({ id: m.id, text: e.message, isError: true }) }
  })
}).on('close', () => { queue.then(() => srv.close()).then(() => process.exit(0)) })
