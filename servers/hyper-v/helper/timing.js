/**
 * MC-1558: the user-adjustable timings. Each is an env key in the MCP server's entry (Combwork's .combwork/mcp/hyper-v.json,
 * its env block), which server.js sends to the helper once per connection (set-timing). The helper keeps each value
 * within [floor, cap]: the cap is setup's policy (timingCaps), else the key's maximum, and applies to the default too.
 * A lease takes its connection's values when it is acquired; a pool job takes the applying connection's; work with no
 * client behind it (start-up recovery, the quarantine retry) uses the defaults.
 *
 * The helper's older HYPERV_MCP_*_MS env variables stay as test-only base values (test/timing.json sets them): when one
 * is set it replaces that key's default, below any floor, and a value sent by a client still applies over it.
 *
 * Pure: no I/O. resolve(supplied, caps, env) -> { values, ms, notes }; derived(ms) the enclosing call bounds.
 */
const MIN = 60_000
const SEC = 1000
const KEYS = {
  guestReadyMinutes: { env: 'HYPERV_MCP_GUEST_READY_MINUTES', unit: MIN, def: 10, floor: 2, max: 60, test: 'HYPERV_MCP_READY_WAIT_MS', what: 'a started or restored guest answering' },
  restoreMinutes: { env: 'HYPERV_MCP_RESTORE_MINUTES', unit: MIN, def: 10, floor: 2, max: 30, test: 'HYPERV_MCP_RESTORE_MS', what: 'a checkpoint restore once the VM is off' },
  offWaitSeconds: { env: 'HYPERV_MCP_OFF_WAIT_SECONDS', unit: SEC, def: 120, floor: 20, max: 600, test: 'HYPERV_MCP_OFF_WAIT_MS', what: 'a VM reaching Off before a restore' },
  restoreVerifySeconds: { env: 'HYPERV_MCP_RESTORE_VERIFY_SECONDS', unit: SEC, def: 180, floor: 30, max: 900, test: 'HYPERV_MCP_RESTORE_VERIFY_MS', what: 'a restored VM\'s new checkpoint showing' },
  checkpointMinutes: { env: 'HYPERV_MCP_CHECKPOINT_MINUTES', unit: MIN, def: 10, floor: 2, max: 60, test: 'HYPERV_MCP_CHECKPOINT_MS', what: 'taking or removing a checkpoint (removing merges its disk)' },
  queueKeepMinutes: { env: 'HYPERV_MCP_QUEUE_KEEP_MINUTES', unit: MIN, def: 10, floor: 2, max: 60, test: 'HYPERV_MCP_KEEP_MS', what: 'a place in vm_acquire\'s line between calls' },
  logonMinutes: { env: 'HYPERV_MCP_LOGON_MINUTES', unit: MIN, def: 10, floor: 5, max: 30, test: 'HYPERV_MCP_LOGON_WAIT_MS', what: 'an interactive logon at vm_start' },
  shutdownMinutes: { env: 'HYPERV_MCP_SHUTDOWN_MINUTES', unit: MIN, def: 5, floor: 2, max: 30, test: 'HYPERV_MCP_SHUTDOWN_MS', what: 'a guest shutting down cleanly' },
  installMinutes: { env: 'HYPERV_MCP_INSTALL_MINUTES', unit: MIN, def: 90, floor: 30, max: 360, test: 'HYPERV_MCP_INSTALL_WAIT_MS', what: 'Windows setup in a new pool VM' },
  provisionMinutes: { env: 'HYPERV_MCP_PROVISION_MINUTES', unit: MIN, def: 30, floor: 15, max: 120, test: 'HYPERV_MCP_PROVISION_WAIT_MS', what: 'an account\'s first-logon provisioning at build' },
  cloudInitMinutes: { env: 'HYPERV_MCP_CLOUD_INIT_MINUTES', unit: MIN, def: 15, floor: 5, max: 60, test: 'HYPERV_MCP_LINUX_CLOUD_INIT_MS', what: 'cloud-init in a new Linux VM' },
  copyIdleMinutes: { env: 'HYPERV_MCP_COPY_IDLE_MINUTES', unit: MIN, def: 5, floor: 1, max: 9, test: 'HYPERV_MCP_COPY_IDLE_MS', what: 'a Windows build copy or vm_sync with no 32 MB part or file finished' }
}
const unitName = k => KEYS[k].unit === MIN ? 'min' : 's'

/** Problems with policy.timingCaps (an object of key -> number), for policy.problems. */
function capsProblems(caps) {
  if (caps === undefined || caps === null) return []
  if (typeof caps !== 'object' || Array.isArray(caps)) return ['timingCaps must be an object']
  const out = []
  for (const [k, v] of Object.entries(caps)) {
    const d = KEYS[k]
    if (!d) { out.push(`timingCaps.${k} isn't a known timing (${Object.keys(KEYS).join(', ')})`); continue }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < d.floor || v > d.max) out.push(`timingCaps.${k} must be a number from ${d.floor} to ${d.max} (${unitName(k)})`)
  }
  return out
}

/**
 * The effective values. supplied: { key: number } from a client (anything else is ignored, with a note); caps:
 * policy.timingCaps; env: the helper's environment (test-only bases). values are in each key's unit, ms in ms.
 */
function resolve(supplied = {}, caps = null, env = process.env) {
  const values = {}
  const ms = {}
  const notes = []
  for (const [k, d] of Object.entries(KEYS)) {
    const cap = caps && typeof caps[k] === 'number' ? caps[k] : d.max
    const s = supplied ? supplied[k] : undefined
    if (s !== undefined && (typeof s !== 'number' || !Number.isFinite(s))) notes.push(`${k} must be a number: ignored`)
    if (typeof s === 'number' && Number.isFinite(s)) {
      const v = Math.min(Math.max(s, d.floor), cap)
      if (v !== s) notes.push(`${k} ${s} ${unitName(k)} is outside ${d.floor}-${cap}: ${v} used`)
      values[k] = v; ms[k] = Math.round(v * d.unit)
      continue
    }
    const base = env && env[d.test] !== undefined && env[d.test] !== '' ? Number(env[d.test]) : NaN
    if (Number.isFinite(base) && base > 0) { ms[k] = Math.min(base, cap * d.unit); values[k] = ms[k] / d.unit; continue }
    const v = Math.min(d.def, cap)
    values[k] = v; ms[k] = v * d.unit
  }
  return { values, ms, notes }
}

/** The enclosing call bounds, derived so an inner phase never outlasts its call (s13). */
function derived(ms) {
  return {
    restoreCallMs: ms.offWaitSeconds + ms.restoreMinutes, // the restore op: the off-wait inside it, then Restore-VMSnapshot
    shutdownCallMs: ms.shutdownMinutes + MIN, // guest-shutdown's call: its wait inside, plus PowerShell
    makeCleanCallMs: ms.shutdownMinutes + 10 * MIN // make-clean: the shutdown wait, removing snapshots, the checkpoint
  }
}

/** The values a client sent, from env (server.js): only keys that are set and are numbers. */
function fromEnv(env = process.env) {
  const out = {}
  for (const [k, d] of Object.entries(KEYS)) {
    const raw = env[d.env]
    if (raw === undefined || String(raw).trim() === '') continue
    const n = Number(raw)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

/** One line for vm_status: the values that differ from the defaults, and the derived restore call. */
function describe(r) {
  const diff = Object.keys(KEYS).filter(k => r.values[k] !== KEYS[k].def).map(k => `${k} ${+r.values[k].toFixed(2)} ${unitName(k)}`)
  const d = derived(r.ms)
  return `${diff.length ? diff.join(', ') : 'the defaults'}; restore call ${Math.round(d.restoreCallMs / 1000)} s`
}

module.exports = { KEYS, MIN, SEC, capsProblems, resolve, derived, fromEnv, describe }
