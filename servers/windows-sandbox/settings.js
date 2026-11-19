/**
 * The server's settings from its environment, read once, shared by the server, its watchdog and confine.js. Every one
 * is in combwork-mcp.example.json with its default and in the README (Configuration).
 *
 * A number setting left empty, or set to something that isn't a number or is below its least value, uses its default.
 * None has an upper limit of its own: a value only counts as less where a larger one would break something, and then
 * the reason is written beside it.
 */

// Node's timers can't wait longer than this (about 24.8 days): a longer delay fires at once.
const TIMER_MAX_MS = 2 ** 31 - 1

function numberSetting(name, def, { min = 0 } = {}) {
  const raw = String(process.env[name] ?? '').trim()
  const n = raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= min ? n : def
}
const whole = (name, def, min = 1) => Math.floor(numberSetting(name, def, { min }))

module.exports = {
  TIMER_MAX_MS,
  // How long `wsb start` may take to say the Sandbox started.
  START_WAIT_MS: whole('WSB_START_WAIT_MS', 180_000),
  // How long after the start the Sandbox may take to run its first command (checked every 250 ms).
  READY_WAIT_MS: whole('WSB_READY_WAIT_MS', 60_000),
  // How long after connecting the user session may take to come up (checked every second).
  SESSION_WAIT_MS: whole('WSB_SESSION_WAIT_MS', 90_000),
  // The longest lifetime sandbox_start may ask for (maxMinutes).
  MAX_MINUTES: numberSetting('WSB_MAX_MINUTES', 240, { min: Number.MIN_VALUE }),
  // How much of each of a command's stdout and stderr sandbox_run returns.
  OUTPUT_BYTES: whole('WSB_OUTPUT_BYTES', 16 * 1024, 0),
  // The most sandbox_collect may ask for per file (maxBytes) and per call (maxTotalBytes); also a screenshot's size.
  COLLECT_MAX_BYTES: whole('WSB_COLLECT_MAX_BYTES', 8 * 1024 * 1024),
  COLLECT_MAX_TOTAL_BYTES: whole('WSB_COLLECT_MAX_TOTAL_BYTES', 16 * 1024 * 1024),
  // A listing of the out folder: files, entries looked at (also when finding one name in a folder), and folder depth.
  LIST_MAX_FILES: whole('WSB_LIST_MAX_FILES', 1000),
  LIST_MAX_ENTRIES: whole('WSB_LIST_MAX_ENTRIES', 10_000),
  LIST_MAX_DEPTH: whole('WSB_LIST_MAX_DEPTH', 16, 0),
  // A stop: how many `wsb stop` tries, each confirmed by `wsb list`, and the pause between them.
  STOP_ATTEMPTS: whole('WSB_STOP_ATTEMPTS', 3),
  STOP_RETRY_MS: Math.min(TIMER_MAX_MS, whole('WSB_STOP_RETRY_MS', 3000, 0)),
  // The watchdog: how often it checks the server and the deadline, and how many rounds of stops it makes (each
  // STOP_ATTEMPTS tries, WATCHDOG_CHECK_MS * 15 apart) before it gives up.
  WATCHDOG_CHECK_MS: Math.min(TIMER_MAX_MS / 15, whole('WSB_WATCHDOG_CHECK_MS', 2000)),
  WATCHDOG_ROUNDS: whole('WSB_WATCHDOG_ROUNDS', 20)
}
