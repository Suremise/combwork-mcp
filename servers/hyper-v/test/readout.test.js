// MC-1597: no reply past what an MCP client takes in one message. Claude Code drops a stdio server whose one reply
// passes 16 MB; vm_read_out let a reply reach about 85 MB. Through server.js over stdio, against the stub Hyper-V: each
// vm_read_out reply is filled up to REPLY_BUDGET measured as sent (JSON escaping included), a file that doesn't fit
// stops there and says the offset to read on from, a big file is read whole in three pages, and any other reply past
// REPLY_HARD_MAX goes as an error instead. The helper's offset is in caps.test.js, a Linux guest's in linux.test.js.
const test = require('node:test')
const assert = require('assert')
const path = require('path')
const { T, scratch, withPool } = require('./helpers')
const { server } = require('../client')
const { REPLY_BUDGET, REPLY_HARD_MAX, READ_TOTAL_MAX } = require('../helper/core')

const MB = 1024 * 1024
const TITLE = /^--- (\S+) \((?:bytes (\d+)-(\d+) of (\d+))?(?:; read on with offset: (\d+))?(?:; )?(base64)?\) ---\n/

async function running(t, name, extraEnv = {}) {
  const sc = scratch(name)
  const { h } = await withPool(sc, 1)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), ...extraEnv }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('vm_acquire', { minutes: 30 })).text, /Leased hvmcp-/)
  let started = await s.call('vm_start', { build: path.join(sc.builds, 'app') })
  for (let i = 0; i < 60 && /still in progress/.test(started.text); i++) started = await s.call('vm_wait')
  assert.match(started.text, /build copied in/)
  const put = files => sc.patchStub(st => { const vm = Object.values(st.vms).find(v => v.state === 'Running'); for (const [p, b] of Object.entries(files)) vm.disk[`C:\\out\\${p}`] = b.toString('base64') })
  return { sc, s, put }
}

// A reply within the budget, and so well under the 16 MB a message Claude Code takes.
function withinBudget(r) {
  assert.ok(r.bytes <= REPLY_BUDGET, `${r.bytes} bytes sent, over the budget ${REPLY_BUDGET}`)
  assert.ok(REPLY_BUDGET < 16_000_000 && REPLY_HARD_MAX < 16_000_000)
}

test('MC-1597: a big text file is read whole in three pages, each reply within the budget measured as sent, each saying where to read on', async t => {
  const { s, put } = await running(t, 'ro-pages')
  // 64-byte blocks that encode to 66 (a quote and a newline escape to two each; é's two bytes pass as they are).
  const block = Buffer.from(`${'a'.repeat(59)}"\né.`)
  assert.strictEqual(block.length, 64)
  const big = Buffer.concat(Array.from({ length: Math.ceil(25 * MB / 64) }, (_, i) => i % 1000 === 0 ? Buffer.from(String(i).padStart(64, '#')) : block))
  put({ 'big.txt': big })
  const parts = []
  let offset = 0
  for (let page = 0; page < 5 && offset !== null; page++) {
    const r = await s.call('vm_read_out', { paths: ['big.txt'], maxBytes: READ_TOTAL_MAX, maxTotalBytes: READ_TOTAL_MAX, ...(offset ? { offset } : {}) })
    withinBudget(r)
    assert.strictEqual(r.isError, false)
    assert.strictEqual(r.content.length, 1, r.text.slice(0, 300))
    const m = TITLE.exec(r.content[0].text)
    assert.ok(m, r.content[0].text.slice(0, 200))
    assert.strictEqual(Number(m[2]), offset, 'it starts where the last one stopped')
    assert.strictEqual(Number(m[4]), big.length)
    const body = Buffer.from(r.content[0].text.slice(m[0].length), 'utf8')
    assert.strictEqual(Number(m[3]), offset + body.length, 'its title names the bytes it holds')
    parts.push(body)
    offset = m[5] ? Number(m[5]) : null
    if (offset !== null) {
      assert.strictEqual(offset, Number(m[3]))
      assert.ok(r.bytes > REPLY_BUDGET - MB, `a page stopped by the budget is filled to it (${r.bytes})`)
    }
  }
  assert.strictEqual(offset, null, 'the last page says no offset')
  assert.strictEqual(parts.length, 3, 'three pages')
  assert.ok(Buffer.concat(parts).equals(big), 'the pages put together are the file, byte for byte')
})

test('MC-1597: at the boundary: text that escapes to six bytes a byte stops where the budget ends, on a character, and reads on from there', async t => {
  const { s, put } = await running(t, 'ro-boundary')
  // Control characters (\u0001, six bytes each as sent) with a three-byte character every 7 bytes, so a cut may fall
  // inside one; then a small file after it, named but not sent.
  const unit = Buffer.concat([Buffer.alloc(4, 1), Buffer.from('€')])
  const ctl = Buffer.concat(Array.from({ length: Math.ceil(3.5 * MB / unit.length) }, () => unit))
  put({ 'a.txt': Buffer.from('first'), 'ctl.txt': ctl, 'z.txt': Buffer.from('last') })
  const r = await s.call('vm_read_out', { paths: ['a.txt', 'ctl.txt', 'z.txt'], maxBytes: 6 * MB, maxTotalBytes: 6 * MB })
  withinBudget(r)
  assert.ok(r.bytes > REPLY_BUDGET - MB, `filled to the budget (${r.bytes})`)
  assert.match(r.content[0].text, /^--- a\.txt ---\nfirst$/)
  const m = TITLE.exec(r.content[1].text)
  assert.strictEqual(m[1], 'ctl.txt')
  const body = Buffer.from(r.content[1].text.slice(m[0].length), 'utf8')
  const next = Number(m[5])
  assert.ok(next > 0 && next < ctl.length && next === body.length)
  assert.ok(body.equals(ctl.subarray(0, next)), 'the bytes up to the offset, whole characters only')
  assert.notStrictEqual(ctl[next] & 0xc0, 0x80, 'the offset is at a character\'s start')
  assert.match(r.content.at(-1).text, /This reply is full \(about 12 MB, what one MCP reply may carry\): not read here: z\.txt\. Read it in another call\./)
  // Reading on: the rest, from the offset.
  const r2 = await s.call('vm_read_out', { paths: ['ctl.txt'], offset: next, maxBytes: 6 * MB, maxTotalBytes: 6 * MB })
  withinBudget(r2)
  const m2 = TITLE.exec(r2.content[0].text)
  assert.strictEqual(Number(m2[2]), next)
  assert.ok(Buffer.from(r2.content[0].text.slice(m2[0].length), 'utf8').equals(ctl.subarray(next, Number(m2[3]))))
})

test('MC-1597: binary as base64 is cut on a whole group of three bytes, and read on from there; an image too big for one reply says how to get it', async t => {
  const { s, put } = await running(t, 'ro-base64')
  const bin = Buffer.alloc(11 * MB)
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 7 + 1) % 256
  bin[0] = 0 // binary
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10 * MB)])
  put({ 'blob.bin': bin, 'shot.png': png })
  const got = []
  let offset = 0
  for (let page = 0; page < 3 && offset !== null; page++) {
    const r = await s.call('vm_read_out', { paths: ['blob.bin'], base64: true, maxBytes: READ_TOTAL_MAX, maxTotalBytes: READ_TOTAL_MAX, ...(offset ? { offset } : {}) })
    withinBudget(r)
    const m = TITLE.exec(r.content[0].text)
    assert.strictEqual(m[6], 'base64')
    got.push(Buffer.from(r.content[0].text.slice(m[0].length), 'base64'))
    offset = m[5] ? Number(m[5]) : null
    if (offset !== null) assert.strictEqual(got.at(-1).length % 3, 0)
  }
  assert.strictEqual(got.length, 2)
  assert.ok(Buffer.concat(got).equals(bin), 'the parts are the file')
  // An image of 10 MB is about 13.3 MB as base64: not as an image; with base64, in parts.
  const img = await s.call('vm_read_out', { paths: ['shot.png'], maxBytes: READ_TOTAL_MAX, maxTotalBytes: READ_TOTAL_MAX })
  withinBudget(img)
  assert.match(img.text, /shot\.png: an image of 10485768 bytes, too big for one reply as an image: pass base64: true to read it in parts/)
  assert.ok(!img.content.some(c => c.type === 'image'))
})

test('MC-1597: maxTotalBytes past one reply\'s budget is refused with how to read in parts; and any reply past the most one may carry goes as an error, the server staying up', async t => {
  const { s, put } = await running(t, 'ro-guard')
  const r = await s.call('vm_read_out', { paths: ['x.txt'], maxTotalBytes: READ_TOTAL_MAX + 1 })
  assert.strictEqual(r.isError, true)
  assert.match(r.text, new RegExp(`maxTotalBytes must be 1-${READ_TOTAL_MAX}: the files come back in one MCP reply, which a client takes only up to a size \\(Claude Code drops a server whose reply passes 16 MB\\)\\. Read a big file in parts: paths with just that file, and offset where the last reply stopped`))
  // A listing of C:\out with very long names: past the most one reply may carry.
  const files = {}
  for (let i = 0; i < 1000; i++) files[`${String(i).padStart(4, '0')}-${'n'.repeat(16 * 1024)}.txt`] = Buffer.from('x')
  put(files)
  const list = await s.call('vm_read_out')
  assert.strictEqual(list.isError, true)
  assert.match(list.text, new RegExp(`^The reply was \\d+ bytes, over the ${REPLY_HARD_MAX} one MCP reply may carry, so it wasn't sent: ask for less`))
  assert.ok(list.bytes < 1024)
  assert.match((await s.call('vm_status')).text, /Mode: direct/, 'the server is still there')
})

test('MC-1597 round 2: a read that stops short keeps its last character when it is whole (2, 3 and 4 bytes), leaves only an incomplete one, and one too small for a character says so instead of an offset that never moves', async t => {
  const { s, put } = await running(t, 'ro-utf8')
  put({ 'e2.txt': Buffer.from('éé'), 'e3.txt': Buffer.from('€€'), 'e4.txt': Buffer.from('😀😀') })
  const page = async (file, maxBytes, extra = {}) => {
    const r = await s.call('vm_read_out', { paths: [file], maxBytes, ...extra })
    const m = TITLE.exec(r.content[0].text)
    return { r, m, body: m ? r.content[0].text.slice(m[0].length) : null, next: m?.[5] ? Number(m[5]) : null }
  }
  // At a read boundary, whole characters of each size are kept, and the offset moves past them.
  for (const [file, ch, n] of [['e2.txt', 'é', 2], ['e3.txt', '€', 3], ['e4.txt', '😀', 4]]) {
    const p = await page(file, n)
    assert.deepStrictEqual([p.body, p.next], [ch, n], `${file} read ${n} bytes: ${p.r.text}`)
    const rest = await page(file, n, { offset: p.next })
    assert.deepStrictEqual([rest.body, rest.next, Number(rest.m[2])], [ch, null, n], 'the rest, to the end')
    // One byte more than a character: the incomplete one is left for the next part.
    if (n < 4) continue
    const over = await page(file, n + 1)
    assert.deepStrictEqual([over.body, over.next], [ch, n])
  }
  const mid = await page('e3.txt', 4)
  assert.deepStrictEqual([mid.body, mid.next], ['€', 3], 'a three-byte character and one byte of the next: the whole one, on from 3')
  // Too small for the first character: no non-moving offset; base64 reads the bytes and moves on.
  const small = await s.call('vm_read_out', { paths: ['e3.txt'], maxBytes: 2 })
  assert.match(small.text, /^e3\.txt: the 2 bytes read from 0 end inside a character: read it with a larger maxBytes \(at least 4\), or pass base64: true$/)
  assert.ok(!/offset: 0/.test(small.text))
  const b = await page('e3.txt', 2, { base64: true })
  assert.deepStrictEqual([b.m[6], b.next, Buffer.from(b.body, 'base64').equals(Buffer.from('€€').subarray(0, 2))], ['base64', 2, true])
})

test('MC-1597 round 2: an earlier result and this call\'s together past one reply: this call\'s result is given (never run again), the earlier one kept for vm_wait, each once', async t => {
  const { sc, s, put } = await running(t, 'ro-earlier', { ...T.profile('replyShort'), HYPERV_MCP_OUTPUT_BYTES: String(MB) })
  // A run whose 1 MB of control characters (about 6 MB as sent) settles while nobody waits.
  const run = await s.call('vm_run', { command: 'bigctl 20' })
  assert.match(run.text, /vm_run is still in progress/)
  const text = Buffer.from('t'.repeat(READ_TOTAL_MAX))
  put({ 'full.txt': text })
  const runs = () => Object.values(Object.values(sc.stub().vms).find(v => v.state === 'Running').runs || {}).filter(r => /^bigctl/.test(r.command)).length
  let r
  for (let i = 0; i < 120; i++) {
    r = await s.call('vm_read_out', { paths: ['full.txt'], maxBytes: READ_TOTAL_MAX, maxTotalBytes: READ_TOTAL_MAX })
    if (!/vm_run is still in progress in this session/.test(r.text)) break
    await new Promise(res => setTimeout(res, 250))
  }
  assert.ok(r.bytes <= REPLY_HARD_MAX && r.bytes < 16_000_000, `${r.bytes}`)
  assert.strictEqual(r.isError, false, r.text.slice(0, 400))
  assert.match(r.content[0].text, /^--- full\.txt \(bytes 0-\d+ of 12582912; read on with offset: \d+\) ---\nttt/, 'this call\'s own result')
  assert.match(r.content.at(-1).text, /^Your earlier vm_run finished too, but its result didn't fit in one message beside this one: call vm_wait for it\.$/)
  assert.ok(!r.content.some(c => /^Your earlier vm_run finished:/.test(c.text)))
  const w = await s.call('vm_wait')
  assert.ok(w.bytes <= REPLY_HARD_MAX)
  assert.match(w.text, /^vm_run finished \(\d+ s after it was called\):\nExit code 0\./)
  assert.ok(w.text.includes('\u0001'.repeat(1000)), 'with its output')
  assert.match((await s.call('vm_wait')).text, /Nothing is in progress/, 'given once')
  assert.ok(!/Your earlier/.test((await s.call('vm_status')).text), 'and not again')
  assert.strictEqual(runs(), 1, 'the run ran once')
})
