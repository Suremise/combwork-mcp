/**
 * MC-1558: the user-adjustable timings, and (MC-1579) vm_run's output per stream. Each is an env key in the MCP server's
 * entry (Combwork's .combwork/mcp/hyper-v.json, its env block, where combwork-mcp.example.json ships each with its
 * default), which server.js sends to the helper once per connection (set-timing). A lease takes its connection's values
 * when it is acquired; a pool job takes the applying connection's; work with no client behind it (start-up recovery,
 * the quarantine retry) uses the defaults.
 *
 * MC-1579: a value has a default and no range of its own. Any number above 0 is used as given, up to the most it can
 * be where more would break something (`max`, with its reason in `why`): the timings up to Node's timer limit (also
 * hv.ps1's [int] milliseconds), copyIdleMinutes up to 9 (PowerShell Direct's ~10-minute call), outputBytes up to 1 MB
 * (a Linux guest's dispatcher). setup's policy may hold timingCaps, the admin's own highest value for a key, which
 * applies to the default too; setup ships none.
 *
 * The helper's older HYPERV_MCP_*_MS env variables stay as test-only base values (test/timing.json sets them): when one
 * is set it replaces that key's default, and a value sent by a client still applies over it.
 *
 * Pure: no I/O. resolve(supplied, caps, env) -> { values, ms, notes }; derived(ms) the enclosing call bounds.
 */
const MIN = 60_000
const SEC = 1000
// Node's timers can't wait longer than this (about 24.8 days: a longer delay fires at once), and hv.ps1 reads a wait
// as an [int] of milliseconds, which stops at the same number.
const TIMER_MAX_MS = 2 ** 31 - 1
const TIMER_WHY = "Node's timers and hv.ps1's [int] milliseconds stop at about 24.8 days"
const timed = (unit, def, test, what, extra = {}) => ({ unit, def, test, what, max: TIMER_MAX_MS / unit, why: TIMER_WHY, ...extra })
const KEYS = {
  guestReadyMinutes: { env: 'HYPERV_MCP_GUEST_READY_MINUTES', ...timed(MIN, 10, 'HYPERV_MCP_READY_WAIT_MS', 'a started or restored guest answering') },
  restoreMinutes: { env: 'HYPERV_MCP_RESTORE_MINUTES', ...timed(MIN, 10, 'HYPERV_MCP_RESTORE_MS', 'a checkpoint restore once the VM is off') },
  offWaitSeconds: { env: 'HYPERV_MCP_OFF_WAIT_SECONDS', ...timed(SEC, 120, 'HYPERV_MCP_OFF_WAIT_MS', 'a VM reaching Off before a restore') },
  restoreVerifySeconds: { env: 'HYPERV_MCP_RESTORE_VERIFY_SECONDS', ...timed(SEC, 180, 'HYPERV_MCP_RESTORE_VERIFY_MS', 'a restored VM\'s new checkpoint showing') },
  checkpointMinutes: { env: 'HYPERV_MCP_CHECKPOINT_MINUTES', ...timed(MIN, 10, 'HYPERV_MCP_CHECKPOINT_MS', 'taking or removing a checkpoint (removing merges its disk)') },
  queueKeepMinutes: { env: 'HYPERV_MCP_QUEUE_KEEP_MINUTES', ...timed(MIN, 10, 'HYPERV_MCP_KEEP_MS', 'a place in vm_acquire\'s line between calls') },
  logonMinutes: { env: 'HYPERV_MCP_LOGON_MINUTES', ...timed(MIN, 10, 'HYPERV_MCP_LOGON_WAIT_MS', 'an interactive logon at vm_start') },
  shutdownMinutes: { env: 'HYPERV_MCP_SHUTDOWN_MINUTES', ...timed(MIN, 5, 'HYPERV_MCP_SHUTDOWN_MS', 'a guest shutting down cleanly') },
  installMinutes: { env: 'HYPERV_MCP_INSTALL_MINUTES', ...timed(MIN, 90, 'HYPERV_MCP_INSTALL_WAIT_MS', 'Windows setup in a new pool VM') },
  provisionMinutes: { env: 'HYPERV_MCP_PROVISION_MINUTES', ...timed(MIN, 30, 'HYPERV_MCP_PROVISION_WAIT_MS', 'an account\'s first-logon provisioning at build') },
  cloudInitMinutes: { env: 'HYPERV_MCP_CLOUD_INIT_MINUTES', ...timed(MIN, 15, 'HYPERV_MCP_LINUX_CLOUD_INIT_MS', 'cloud-init in a new Linux VM') },
  copyIdleMinutes: {
    env: 'HYPERV_MCP_COPY_IDLE_MINUTES', ...timed(MIN, 5, 'HYPERV_MCP_COPY_IDLE_MS', 'a Windows build copy or vm_sync with no 32 MB part or file finished'),
    max: 9, why: 'PowerShell Direct ends any one call after about 10 minutes, so a copy call must finish within that'
  },
  // MC-1566: a connected start's guest network read back until it is right and has held (a condition); this is only
  // its ceiling, formerly a fixed 90 s.
  networkSeconds: { env: 'HYPERV_MCP_NETWORK_SECONDS', ...timed(SEC, 90, 'HYPERV_MCP_NET_WAIT_MS', "a connected start's guest network being ready and steady (a DHCP address, or host mode's static one)") },
  // MC-1577: the user's guest setup script at build (its run is started, then polled: no one long call).
  guestScriptMinutes: { env: 'HYPERV_MCP_GUEST_SCRIPT_MINUTES', ...timed(MIN, 30, 'HYPERV_MCP_GUEST_SCRIPT_MS', 'the guest setup script a plan names, in each VM it builds') },
  // MC-1579: not a timing, but a per-connection setting sent the same way: how much of each of a vm_run's stdout and
  // stderr comes back (formerly a fixed 16 KB), in bytes.
  outputBytes: {
    env: 'HYPERV_MCP_OUTPUT_BYTES', unit: 1, def: 16 * 1024, test: null, what: "each of a vm_run's stdout and stderr", whole: true,
    max: 1024 * 1024, why: "a Linux guest's dispatcher (guest.py, copied into each VM when it is built) returns at most 1 MB a stream"
  }
}
const unitName = k => KEYS[k].unit === MIN ? 'min' : KEYS[k].unit === SEC ? 's' : 'bytes'
const fmt = (k, v) => `${+v.toFixed(2)} ${unitName(k)}`

/** Problems with policy.timingCaps (an object of key -> number), for policy.problems. */
function capsProblems(caps) {
  if (caps === undefined || caps === null) return []
  if (typeof caps !== 'object' || Array.isArray(caps)) return ['timingCaps must be an object']
  const out = []
  for (const [k, v] of Object.entries(caps)) {
    const d = KEYS[k]
    if (!d) { out.push(`timingCaps.${k} isn't a known timing (${Object.keys(KEYS).join(', ')})`); continue }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > d.max) out.push(`timingCaps.${k} must be a number above 0, at most ${fmt(k, d.max)} (${d.why})`)
  }
  return out
}

/** A key's value as used: whole bytes for outputBytes, at least 1; whole milliseconds for a timing, at least 1. */
const toMs = (d, v) => Math.max(1, d.whole ? Math.floor(v) : Math.round(v * d.unit))

/**
 * The effective values. supplied: { key: number } from a client (anything else is ignored, with a note); caps:
 * policy.timingCaps; env: the helper's environment (test-only bases). values are in each key's unit, ms in ms (bytes
 * for outputBytes).
 */
function resolve(supplied = {}, caps = null, env = process.env) {
  const values = {}
  const ms = {}
  const notes = []
  for (const [k, d] of Object.entries(KEYS)) {
    const capped = caps && typeof caps[k] === 'number'
    const cap = capped ? Math.min(caps[k], d.max) : d.max
    const s = supplied ? supplied[k] : undefined
    if (s !== undefined && (typeof s !== 'number' || !Number.isFinite(s))) notes.push(`${k} must be a number: ignored`)
    else if (typeof s === 'number' && s <= 0) notes.push(`${k} must be above 0: ignored`)
    if (typeof s === 'number' && Number.isFinite(s) && s > 0) {
      const v = Math.min(s, cap)
      if (v !== s) notes.push(`${k} ${fmt(k, s)} is over ${capped ? "setup's cap" : 'the most it can be'}, ${fmt(k, cap)}${capped ? '' : ` (${d.why})`}: ${fmt(k, v)} used`)
      ms[k] = toMs(d, v); values[k] = ms[k] / d.unit
      continue
    }
    const base = d.test && env && env[d.test] !== undefined && env[d.test] !== '' ? Number(env[d.test]) : NaN
    if (Number.isFinite(base) && base > 0) { ms[k] = Math.min(base, toMs(d, cap)); values[k] = ms[k] / d.unit; continue }
    const v = Math.min(d.def, cap)
    ms[k] = toMs(d, v); values[k] = ms[k] / d.unit
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
  const diff = Object.keys(KEYS).filter(k => r.values[k] !== KEYS[k].def).map(k => `${k} ${fmt(k, r.values[k])}`)
  const d = derived(r.ms)
  return `${diff.length ? diff.join(', ') : 'the defaults'}; restore call ${Math.round(d.restoreCallMs / 1000)} s`
}

module.exports = { KEYS, MIN, SEC, TIMER_MAX_MS, capsProblems, resolve, derived, fromEnv, describe }
