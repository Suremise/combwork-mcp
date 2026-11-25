#!/usr/bin/env python3
# The Linux dispatcher (helper/guest.py) run for real, unprivileged, on a temp root with real symlinks (MC-1501).
# Run by guest-py.test.js under a Linux Python (WSL, or HYPERV_TEST_LINUX_PYTHON); prints "OK <n>" when every check
# passes, or raises with the failing check. Runs (systemd-run) aren't covered here: they need a real guest (the trial).
import hashlib
import json
import os
import subprocess
import sys
import tempfile

GUEST = sys.argv[1]
checks = 0


def call(root, req, data=b''):
    p = subprocess.run([sys.executable, GUEST], input=json.dumps(req).encode() + b'\n' + data,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, 'HVMCP_TEST_ROOT': root}, timeout=60)
    line = [l for l in p.stdout.decode().splitlines() if l.startswith('HVJSON:')][-1]
    return json.loads(line[7:])


def ok(cond, what):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(what)


def sync(root, files, remove=(), full=False, delete=True, gen=1, corrupt=None):
    entries, data = [], b''
    for path, body in files:
        b = body.encode() if isinstance(body, str) else body
        entries.append({'path': path, 'size': len(b), 'sha256': hashlib.sha256(b).hexdigest()})
        data += b
    if corrupt:
        data = corrupt(data)
    return call(root, {'op': 'sync', 'files': entries, 'remove': list(remove), 'full': full, 'delete': delete, 'gen': gen}, data)


def tree(root):
    out = {}
    base = os.path.join(root, 'build')
    for dp, dns, fns in os.walk(base):
        for n in dns + fns:
            p = os.path.join(dp, n)
            rel = os.path.relpath(p, base)
            if os.path.islink(p):
                out[rel] = 'link:' + os.readlink(p)
            elif os.path.isdir(p):
                out[rel] = 'dir'
            else:
                with open(p, 'rb') as f:
                    out[rel] = f.read().decode()
    return out


def fresh():
    root = tempfile.mkdtemp(prefix='hvmcp-guest-')
    for d in ('build', 'out', 'hvmcp/staging', 'hvmcp/runs'):
        os.makedirs(os.path.join(root, d))
    outside = os.path.join(root, 'outside')
    os.makedirs(outside)
    with open(os.path.join(outside, 'keep.txt'), 'w') as f:
        f.write('host secret')
    return root, outside


# A first full copy, then an incremental sync: changed and added files only, removals, executable bits.
root, outside = fresh()
r = sync(root, [('a.txt', 'one'), ('sub/run.sh', '#!/bin/sh\necho hi\n'), ('sub/data.bin', '\x7fELF....')], full=True)
ok(r.get('result') == {'copied': 3, 'removed': 0}, 'full copy: %r' % r)
ok(tree(root) == {'a.txt': 'one', 'sub': 'dir', 'sub/run.sh': '#!/bin/sh\necho hi\n', 'sub/data.bin': '\x7fELF....'}, 'full copy tree %r' % tree(root))
ok(oct(os.stat(os.path.join(root, 'build/sub/run.sh')).st_mode & 0o777) == '0o755', 'a #! file is executable')
ok(oct(os.stat(os.path.join(root, 'build/sub/data.bin')).st_mode & 0o777) == '0o755', 'an ELF file is executable')
ok(oct(os.stat(os.path.join(root, 'build/a.txt')).st_mode & 0o777) == '0o644', 'other files are not')
r = sync(root, [('a.txt', 'two'), ('new/b.txt', 'b')], remove=['sub/data.bin'], gen=2)
ok(r.get('result') == {'copied': 2, 'removed': 1}, 'incremental: %r' % r)
ok(tree(root) == {'a.txt': 'two', 'sub': 'dir', 'sub/run.sh': '#!/bin/sh\necho hi\n', 'new': 'dir', 'new/b.txt': 'b'}, 'incremental tree %r' % tree(root))
ok(os.listdir(os.path.join(root, 'hvmcp/staging')) == [], 'staging cleared')

# A hash that doesn't match: nothing changes.
before = tree(root)
r = sync(root, [('a.txt', 'three')], gen=3, corrupt=lambda d: b'x' + d[1:])
ok('another hash' in r.get('error', ''), 'a corrupted file refused: %r' % r)
ok(tree(root) == before, 'nothing changed after a refused sync')

# Symlinks: on the way to a file (in the way: removed as itself with delete, never entered), refused without delete,
# a link as a removal's target removed as itself, a link as /build itself refused, and a full clear never entering one.
os.symlink(outside, os.path.join(root, 'build/evil'))
before = tree(root)
r = sync(root, [('evil/keep.txt', 'pwned')], delete=False, gen=4)
ok('in the way' in r.get('error', ''), 'a link on the way, delete false: refused: %r' % r)
ok(tree(root) == before and open(os.path.join(outside, 'keep.txt')).read() == 'host secret', 'nothing changed, nothing outside touched')
r = sync(root, [('evil/keep.txt', 'mine')], gen=5)
ok(r.get('result', {}).get('copied') == 1, 'with delete, the link is removed and a real folder made: %r' % r)
ok(tree(root).get('evil') == 'dir' and open(os.path.join(outside, 'keep.txt')).read() == 'host secret', 'the link was never entered')
os.symlink(outside, os.path.join(root, 'build/evil2'))
r = sync(root, [], remove=['evil2'], gen=6)
ok(r.get('result', {}).get('removed') == 1 and 'evil2' not in tree(root) and os.path.exists(os.path.join(outside, 'keep.txt')), 'a link removed as itself')
os.symlink(outside, os.path.join(root, 'build/evil3'))
r = sync(root, [], full=True, gen=7)
ok(tree(root) == {} and os.path.exists(os.path.join(outside, 'keep.txt')), 'a full clear removes links as themselves')
r = sync(root, [], remove=['evil3/keep.txt'], gen=8)
ok(r.get('result', {}).get('removed') == 0 and os.path.exists(os.path.join(outside, 'keep.txt')), 'a removal through a missing path does nothing')
os.symlink(outside, os.path.join(root, 'build/evil4'))
r = sync(root, [], remove=['evil4/keep.txt'], gen=9)
ok('in the way' in r.get('error', '') and os.path.exists(os.path.join(outside, 'keep.txt')), 'a removal through a link is refused: %r' % r)

root2, outside2 = fresh()
os.rmdir(os.path.join(root2, 'build'))
os.symlink(outside2, os.path.join(root2, 'build'))
r = sync(root2, [('x.txt', 'x')], full=True)
ok('not a real folder' in r.get('error', ''), '/build as a link refused: %r' % r)
ok(sorted(os.listdir(outside2)) == ['keep.txt'], 'nothing written through it')

# A folder in the way of a file, a file in the way of a folder, and their delete: false refusals.
root, outside = fresh()
sync(root, [('d/x.txt', 'x'), ('f', 'file')], full=True)
before = tree(root)
r = sync(root, [('d', 'now a file'), ('f/y.txt', 'y')], delete=False, gen=2)
ok('in the way' in r.get('error', '') and tree(root) == before, 'delete false: blockers refused, nothing changed: %r' % r)
r = sync(root, [('d', 'now a file'), ('f/y.txt', 'y')], gen=3)
ok(tree(root) == {'d': 'now a file', 'f': 'dir', 'f/y.txt': 'y'}, 'with delete, both replaced: %r' % tree(root))

# Bad manifests: escapes, duplicates, a file and something inside it.
for files, why in ((['../x'], 'bad component'), (['a/./b'], 'bad component'), (['a', 'a'], 'named twice'), (['a', 'a/b'], 'inside it')):
    r = sync(root, [(f, 'x') for f in files], gen=9)
    ok(why in r.get('error', ''), '%r refused (%s): %r' % (files, why, r))

# Read-out: a listing that skips links, reads capped, nothing through a link.
os.makedirs(os.path.join(root, 'out/logs'))
with open(os.path.join(root, 'out/logs/a.log'), 'w') as f:
    f.write('0123456789')
os.symlink(os.path.join(outside, 'keep.txt'), os.path.join(root, 'out/leak.txt'))
os.symlink(outside, os.path.join(root, 'out/leakdir'))
r = call(root, {'op': 'list'})['result']
ok(r['files'] == [{'path': 'logs/a.log', 'size': 10}] and sorted(r['skipped']) == ['leak.txt', 'leakdir'], 'listing %r' % r)
r = call(root, {'op': 'read', 'paths': ['logs/a.log', 'leak.txt', 'leakdir/keep.txt'], 'maxBytes': 4, 'maxTotalBytes': 100})['result']
ok(len(r['files']) == 1 and r['files'][0]['cut'] and r['files'][0]['size'] == 10, 'read capped, links never read: %r' % r)
import base64
ok(base64.b64decode(r['files'][0]['data']) == b'0123', 'the first 4 bytes')
# MC-1597: the first path from an offset, maxBytes counted from the file's start; each file names its offset.
with open(os.path.join(root, 'out/logs/b.log'), 'w') as f:
    f.write('abc')
r = call(root, {'op': 'read', 'paths': ['logs/a.log', 'logs/b.log'], 'offset': 3, 'maxBytes': 8, 'maxTotalBytes': 100})['result']
ok([(x['path'], x['offset'], x['cut'], base64.b64decode(x['data'])) for x in r['files']] == [('logs/a.log', 3, True, b'34567'), ('logs/b.log', 0, False, b'abc')], 'read from an offset: %r' % r)
r = call(root, {'op': 'read', 'paths': ['logs/a.log'], 'offset': 7, 'maxBytes': 100, 'maxTotalBytes': 2})['result']
ok([(x['offset'], x['cut'], base64.b64decode(x['data'])) for x in r['files']] == [(7, True, b'78')], 'an offset, cut by the total: %r' % r)
r = call(root, {'op': 'read', 'paths': ['logs/a.log'], 'offset': 10, 'maxBytes': 100, 'maxTotalBytes': 100})['result']
ok([(x['offset'], x['cut'], x['data']) for x in r['files']] == [(10, False, '')], 'at the end: nothing: %r' % r)
for bad in (-1, True, '3', 1.5):
    ok('bad read arguments' in call(root, {'op': 'read', 'paths': ['logs/a.log'], 'offset': bad, 'maxBytes': 4, 'maxTotalBytes': 100}).get('error', ''), 'offset %r refused' % (bad,))
os.remove(os.path.join(root, 'out/logs/b.log'))

# Unknown operations and arguments.
ok('unknown operation' in call(root, {'op': 'shell'}).get('error', ''), 'an unknown op refused')

print('OK %d' % checks)
