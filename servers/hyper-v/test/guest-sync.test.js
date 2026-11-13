// guest-sync.ps1, the guest side of vm_sync, run for real with Windows PowerShell 5.1 (as the guest runs it) on host temp
// trees: junctions (mklink /J, no elevation needed) as the root, on the way, inside a removed folder and in a full clear;
// file<->folder transitions; escapes and duplicates refused; delete:false blockers refused with nothing changed. On a
// Windows host these must run: a failure to make a junction fails the test, it never skips it.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scratch } = require('./helpers')
const { ps51Env } = require('../helper/hv')

const windows = process.platform === 'win32'
const SCRIPT = path.join(__dirname, '..', 'helper', 'guest-sync.ps1')
const RUNNER = '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; try { $r = & $env:GS_SCRIPT $j; [Console]::Out.WriteLine(\'OK:\' + (ConvertTo-Json -InputObject $r -Compress)) } catch { [Console]::Out.WriteLine(\'ERR:\' + $_.Exception.Message) }'

/** Runs guest-sync.ps1 with input j; resolves { ok, result } or { ok: false, error }. */
function gs(j) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RUNNER], {
    input: JSON.stringify(j), encoding: 'utf8', env: { ...ps51Env(), GS_SCRIPT: SCRIPT }, windowsHide: true, timeout: 60_000
  })
  const line = String(r.stdout).split(/\r?\n/).find(l => l.startsWith('OK:') || l.startsWith('ERR:'))
  if (!line) throw new Error(`no answer from guest-sync.ps1 (exit ${r.status}): ${r.stdout}\n${r.stderr}`)
  return line.startsWith('OK:') ? { ok: true, result: JSON.parse(line.slice(3)) } : { ok: false, error: line.slice(4) }
}

function junction(link, target) {
  const r = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { encoding: 'utf8', windowsHide: true })
  assert.strictEqual(r.status, 0, `mklink /J failed: ${r.stdout}${r.stderr}`)
}

/** A tree: { 'a/b.txt': 'text', 'dir/': null } (a trailing / makes a folder). */
function tree(root, spec) {
  fs.mkdirSync(root, { recursive: true })
  for (const [rel, data] of Object.entries(spec)) {
    const p = path.join(root, ...rel.split('/').filter(Boolean))
    if (rel.endsWith('/')) fs.mkdirSync(p, { recursive: true })
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
  }
}

/** Every file and folder under root, as sorted relative paths ('/' for folders), never entering a junction. */
function list(root) {
  const out = []
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = fs.lstatSync(path.join(d, e.name))
      if (st.isSymbolicLink()) out.push(`${r}@`)
      else if (st.isDirectory()) { out.push(`${r}/`); walk(path.join(d, e.name), r) } else out.push(`${r}=${fs.readFileSync(path.join(d, e.name), 'utf8')}`)
    }
  }
  walk(root, '')
  return out.sort()
}

function setup(name) {
  const sc = scratch(name)
  const base = path.join(sc.dir, 'gs')
  const root = path.join(base, 'build')
  const stage = path.join(base, 'stage')
  const target = path.join(base, 'target')
  tree(target, { 'precious.txt': 'KEEP' })
  return { base, root, stage, target }
}
const apply = (t, over) => gs({ action: 'apply', root: t.root, stage: t.stage, files: [], remove: [], delete: true, full: false, ...over })

test('guest-sync: copies changed files, removes gone ones and prunes the folders they leave empty', { skip: !windows }, () => {
  const t = setup('gs-basic')
  tree(t.root, { 'keep.txt': 'same', 'old/deep/gone.txt': 'x', 'mod.txt': 'v1' })
  tree(t.stage, { 'mod.txt': 'v2', 'new/sub/n.txt': 'n' })
  const r = apply(t, { files: ['mod.txt', 'new/sub/n.txt'], remove: ['old/deep/gone.txt'] })
  assert.ok(r.ok, r.error)
  assert.deepStrictEqual(r.result, { copied: 2, removed: 1, blockersRemoved: 0 })
  assert.deepStrictEqual(list(t.root), ['keep.txt=same', 'mod.txt=v2', 'new/', 'new/sub/', 'new/sub/n.txt=n'])
  assert.ok(!fs.existsSync(t.stage), 'the stage is removed')
})

test('guest-sync: prepare makes a fresh stage, and refuses a junction as its parent', { skip: !windows }, () => {
  const t = setup('gs-prepare')
  tree(t.stage, { 'leftover.txt': 'x' })
  assert.ok(gs({ action: 'prepare', stage: t.stage }).ok)
  assert.deepStrictEqual(fs.readdirSync(t.stage), [])
  const jparent = path.join(t.base, 'jparent')
  junction(jparent, t.target)
  const r = gs({ action: 'prepare', stage: path.join(jparent, 'sync-1') })
  assert.match(r.error, /link or junction/)
  assert.deepStrictEqual(list(t.target), ['precious.txt=KEEP'])
})

test('guest-sync: a junction as the root, or on the way to a file or a removal, is refused before anything changes', { skip: !windows }, () => {
  const t = setup('gs-junctions')
  tree(t.root, { 'a.txt': 'a' })
  tree(t.stage, { 'link/evil.txt': 'evil', 'b.txt': 'b' })
  junction(path.join(t.root, 'link'), t.target)
  let r = apply(t, { files: ['b.txt', 'link/evil.txt'] })
  assert.match(r.error, /link or junction: refused/)
  r = apply(t, { remove: ['link/precious.txt'] })
  assert.match(r.error, /link or junction: refused/)
  assert.deepStrictEqual(list(t.target), ['precious.txt=KEEP'], 'nothing written or removed through the junction')
  assert.ok(!fs.existsSync(path.join(t.root, 'b.txt')), 'nothing copied: checks come first')
  assert.ok(fs.existsSync(path.join(t.root, 'a.txt')))
  // The root itself a junction.
  const jroot = path.join(t.base, 'jroot')
  junction(jroot, t.target)
  r = gs({ action: 'apply', root: jroot, stage: t.stage, files: ['b.txt'], remove: [], delete: true, full: false })
  assert.match(r.error, /build folder .* link or junction/)
  r = gs({ action: 'apply', root: jroot, stage: t.stage, files: [], remove: [], delete: true, full: true })
  assert.match(r.error, /build folder .* link or junction/)
  assert.deepStrictEqual(list(t.target), ['precious.txt=KEEP'])
})

test('guest-sync: removing a folder or a link never enters a junction (link-safe), also in a full clear', { skip: !windows }, () => {
  const t = setup('gs-remove-links')
  tree(t.root, { 'gone/x.txt': 'x' })
  junction(path.join(t.root, 'gone', 'inner'), t.target)
  junction(path.join(t.root, 'toplink'), t.target)
  let r = apply(t, { remove: ['gone', 'toplink'] })
  assert.ok(r.ok, r.error)
  assert.deepStrictEqual(list(t.root), [])
  assert.deepStrictEqual(list(t.target), ['precious.txt=KEEP'], 'the junctions went, their target stayed')
  tree(t.root, { 'd/y.txt': 'y' })
  junction(path.join(t.root, 'd', 'j'), t.target)
  tree(t.stage, { 'fresh.txt': 'f' })
  r = apply(t, { full: true, files: ['fresh.txt'] })
  assert.ok(r.ok, r.error)
  assert.deepStrictEqual(list(t.root), ['fresh.txt=f'])
  assert.deepStrictEqual(list(t.target), ['precious.txt=KEEP'])
})

test('guest-sync: file -> folder and folder -> file transitions (delete:true removes the blocker)', { skip: !windows }, () => {
  const t = setup('gs-transitions')
  tree(t.root, { 'a': 'was a file', 'b/inner.txt': 'was a folder', 'c/untracked.txt': 'guest-made' })
  junction(path.join(t.root, 'd'), t.target)
  tree(t.stage, { 'a/child.txt': 'now a folder', 'b': 'now a file', 'c': 'file over a guest folder', 'd': 'file over a link' })
  const r = apply(t, { files: ['a/child.txt', 'b', 'c', 'd'], remove: ['a', 'b/inner.txt'] })
  assert.ok(r.ok, r.error)
  assert.deepStrictEqual(list(t.root), ['a/', 'a/child.txt=now a folder', 'b=now a file', 'c=file over a guest folder', 'd=file over a link'])
  assert.deepStrictEqual(list(t.target), ['precious.txt=KEEP'], 'the link in the way was removed, not entered')
})

test('guest-sync: delete:false refuses blockers and changes nothing', { skip: !windows }, () => {
  const t = setup('gs-delete-false')
  tree(t.root, { 'a': 'file', 'b/x.txt': 'folder' })
  tree(t.stage, { 'a/child.txt': '1', 'b': '2', 'ok.txt': '3' })
  for (const files of [['ok.txt', 'a/child.txt'], ['ok.txt', 'b']]) {
    const r = apply(t, { files, delete: false })
    assert.match(r.error, /with delete false, these are in the way/)
  }
  assert.deepStrictEqual(list(t.root), ['a=file', 'b/', 'b/x.txt=folder'])
  assert.ok(fs.existsSync(path.join(t.stage, 'ok.txt')), 'not even the unblocked file moved')
})

test('guest-sync: escapes, odd paths, duplicates by canonical identity and file-plus-descendant are refused', { skip: !windows }, () => {
  const t = setup('gs-paths')
  tree(t.root, { 'k.txt': 'k' })
  tree(t.stage, { 'a.txt': 'a', 'A/b.txt': 'b' })
  for (const [over, re] of [
    [{ files: ['../escape.txt'] }, /segment '\.\.'/],
    [{ files: ['C:\\Windows\\x'] }, /characters not allowed/],
    [{ files: ['\\\\server\\share\\x'] }, /not relative/],
    [{ remove: ['..\\..\\target\\precious.txt'] }, /segment '\.\.'/],
    [{ remove: ['/abs'] }, /not relative/],
    [{ files: ['a.txt:stream'] }, /characters not allowed/],
    [{ files: ['trail. '] }, /segment/],
    [{ files: ['a.txt', 'A.TXT'] }, /listed twice/],
    [{ files: ['a.txt', 'sub\\..\\a.txt'] }, /segment '\.\.'/],
    [{ files: ['A', 'a/b.txt'] }, /is a file and also a folder/]
  ]) {
    const r = apply(t, over)
    assert.ok(!r.ok, `${JSON.stringify(over)} should be refused`)
    assert.match(r.error, re, JSON.stringify(over))
  }
  assert.deepStrictEqual(list(t.root), ['k.txt=k'])
  assert.deepStrictEqual(list(t.target), ['precious.txt=KEEP'])
})

test('guest-sync: a staged file that is missing or a junction is refused', { skip: !windows }, () => {
  const t = setup('gs-stage')
  tree(t.root, {})
  tree(t.stage, {})
  let r = apply(t, { files: ['missing.txt'] })
  assert.match(r.error, /missing or not a plain file/)
  junction(path.join(t.stage, 'via'), t.target)
  r = apply(t, { files: ['via/precious.txt'] })
  assert.match(r.error, /link or junction/)
  assert.deepStrictEqual(list(t.target), ['precious.txt=KEEP'])
})
