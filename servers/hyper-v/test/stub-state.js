/**
 * MC-1594: the stubs' state file (HYPERV_MCP_STUB_STATE), shared by every stub process (stub-hv.js, stub-guest.js: one
 * per call, and the helper runs calls on different VMs at once, as Hyper-V allows) and by the tests (helpers.js
 * patchStub). A plain read, change and write of the whole file would put back what another writer changed meanwhile
 * (one VM's restore undone by the other's save: "state is Running, not Off", the VM quarantined, MC-1594). So:
 *
 * - Every write is made holding one lock (withLock).
 * - A stub's save writes only what its own call changed since its last load or save over the file as it is now
 *   (merge): the rest stays the other writers'. Two writers changing the same field still end last-writer-wins; the
 *   helper never runs two calls on one VM at once (its per-VM lock).
 *
 * The lock, ownership-safe, with no deleting of a lock anyone may hold: it is a folder, <file>.lock. To take it, a
 * process creates it (mkdir: one wins), makes it its current directory, and claims it by creating an "owner" file in
 * it (exclusive create: one wins, should two ever be in the same folder). On Windows a folder that is a live process's
 * current directory can't be renamed or removed; a process that dies lets go of it at once. A lock whose owner is gone
 * is cleared by renaming the whole folder aside, which fails on any live holder (EBUSY), so a stale-lock clearer can
 * never take away a live owner's lock, however its observations interleave with other contenders'. A folder just made
 * (STALE_MS) is left alone: its maker may be between the mkdir and the chdir. Nothing in it is deleted in place, so an
 * owner file is only ever gone with its folder. Windows only, as the hyper-v tests are.
 */
const fs = require('fs')
const crypto = require('crypto')

const STALE_MS = 1000 // a lock folder younger than this may be one its maker hasn't entered yet
const LOCK_WAIT_MS = 60_000 // a lock still held after this is a bug (critical sections take milliseconds): say so
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * One look at a lock folder that exists: { cleared, ageMs } (ageMs: its age as this look read it, null if it was
 * gone). Cleared: moved out of the way (then removed), as no live process held it and it wasn't new; not cleared if it
 * is held, new, or gone.
 */
function staleCheck(dir) {
  let st
  try { st = fs.statSync(dir) } catch { return { cleared: false, ageMs: null } }
  const ageMs = Date.now() - st.birthtimeMs
  if (ageMs < STALE_MS) return { cleared: false, ageMs }
  const aside = `${dir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  try { fs.renameSync(dir, aside) } catch { return { cleared: false, ageMs } } // held (EBUSY), or another clearer moved it first
  try { fs.rmSync(aside, { recursive: true, force: true }) } catch { /* a leftover beside the state: harmless */ }
  return { cleared: true, ageMs }
}
/** Moves a lock folder no live process holds out of the way. False if it is held, too new, or gone. */
const breakStale = dir => staleCheck(dir).cleared

/**
 * Runs fn holding the state file's lock (sync). For the tests: onRefused(n, check) is called each time an attempt
 * finds the lock there and doesn't clear it (n from 1), before it waits and tries again (a sign that this process
 * tried and was kept out); onCheck(check) for every look at a lock found there (staleCheck's { cleared, ageMs }).
 */
function withLock(file, fn, { onRefused = null, onCheck = null } = {}) {
  let refused = 0
  const dir = `${file}.lock`
  const home = process.cwd()
  const t0 = Date.now()
  for (;;) {
    let made = false
    try { fs.mkdirSync(dir); made = true } catch (e) { if (e.code !== 'EEXIST') throw e }
    if (made) {
      let entered = false
      try { process.chdir(dir); entered = true } catch { /* cleared before it was entered: try again */ }
      if (entered) {
        let owned = false
        // In the folder this process now holds (its current directory), whatever has happened at the path meanwhile.
        try { fs.writeFileSync('owner', String(process.pid), { flag: 'wx' }); owned = true } catch { /* another's folder */ }
        if (owned) {
          try { return fn() } finally { release(dir, home) }
        }
        process.chdir(home)
      }
    } else {
      const check = staleCheck(dir)
      if (onCheck) onCheck(check)
      if (!check.cleared && onRefused) onRefused(++refused, check)
    }
    if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error(`the stub state's lock (${dir}) stays held`)
    sleepMs(2)
  }
}

/** Lets go (back to the earlier directory), then moves the folder aside and removes it; left for a clearer if it can't be. */
function release(dir, home) {
  process.chdir(home)
  const aside = `${dir}.done-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  try { fs.renameSync(dir, aside) } catch { return } // someone is in it for a moment (they back out): it goes stale
  try { fs.rmSync(aside, { recursive: true, force: true }) } catch { /* harmless */ }
}

/** A read that catches a write mid-way (a torn file) is retried, never taken as an empty state. */
function read(file) {
  for (let i = 0; i < 50; i++) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { return {} }
    try { return JSON.parse(text) } catch { sleepMs(10) }
  }
  throw new Error('the stub state stays unreadable')
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v))
/** ours over theirs, field by field: what ours changed since base wins; an array only appended to keeps both appends. */
function merge(base, ours, theirs) {
  if (same(ours, base)) return theirs
  if (isObj(base) && isObj(ours) && isObj(theirs)) {
    const out = { ...theirs }
    for (const k of new Set([...Object.keys(base), ...Object.keys(ours)])) {
      if (same(ours[k], base[k])) continue
      const v = k in ours ? merge(base[k], ours[k], theirs[k]) : undefined
      if (v === undefined) delete out[k]; else out[k] = v
    }
    return out
  }
  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs) && same(ours.slice(0, base.length), base) && same(theirs.slice(0, base.length), base)) return theirs.concat(ours.slice(base.length))
  return ours
}

/** One stub process's view of the state: load() reads it; save(s) writes this process's changes since its last load or save. */
function stubState(file) {
  let base = null
  return {
    load() { const s = read(file); base ??= clone(s); return s },
    save(s) {
      withLock(file, () => {
        const out = base ? merge(base, s, read(file)) : s
        fs.writeFileSync(file, JSON.stringify(out, null, 1))
      })
      base = clone(s)
    }
  }
}

/** The tests' change of the state (patchStub): read, changed and written all under the lock. */
function patch(file, fn) {
  withLock(file, () => { const s = read(file); fn(s); fs.writeFileSync(file, JSON.stringify(s)) })
}

module.exports = { stubState, patch, withLock, breakStale, merge, read, STALE_MS }
