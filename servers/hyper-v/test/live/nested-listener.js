#!/usr/bin/env node
/**
 * The nested live proof's test listeners (nested-proof.js): runs INSIDE the outer VM hvnest-proof, started and stopped
 * by the driver as admin. Listens on <address> for each port given and answers each connection with one line, then
 * closes it. Only the 18080 one has a firewall rule; the 18081 one exists so a refused 18081 is the firewall, not an
 * absent service. Bound to the host-mode address only, never 0.0.0.0.
 *   node nested-listener.js 10.137.42.1 18080 18081
 */
'use strict'
const net = require('net')
const [address, ...ports] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+\.\d+$/.test(address || '') || !ports.length) { console.error('usage: nested-listener.js <ipv4> <port>...'); process.exit(2) }
for (const p of ports.map(Number)) {
  net.createServer(s => { s.end(`hvnest-proof listener ${p}\n`); s.on('error', () => {}) })
    .on('error', e => { console.error(`port ${p}: ${e.message}`); process.exit(1) })
    .listen(p, address)
}
