#!/usr/bin/env python3
# MC-1551: helper/guest.py's run files and the build's finish, executed (not searched for) on any host Python: Linux,
# or Windows with the few os names Linux has and Windows lacks shimmed. systemd, accounts and process calls are mocked;
# files go to a temp folder. Prints "OK <n>" when every check passes, or raises with the failing one. Run by
# linux-guest-files.test.js. Real Linux permissions are checked in a trial window (MC-1542's next).
import sys
# Round 3: importing guest.py must never write bytecode beside it (helper/ ships whole in the server's zip).
sys.dont_write_bytecode = True
import importlib.util  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
import types  # noqa: E402

GUEST = sys.argv[1]
checks = 0


def ok(cond, what):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(what)


# Names guest.py reads at import that Windows' os lacks (their values only matter on Linux).
for name, value in (('O_NOFOLLOW', 0), ('O_DIRECTORY', 0), ('O_CLOEXEC', 0)):
    if not hasattr(os, name):
        setattr(os, name, value)
if not hasattr(os, 'geteuid'):
    os.geteuid = lambda: 1000
if not hasattr(os, 'fchown'):
    os.fchown = lambda fd, uid, gid: None
if not hasattr(os, 'sync'):
    os.sync = lambda: None
O_NOFOLLOW_MARK = os.O_NOFOLLOW or 0x20000  # on Windows, a distinct bit stands in so the flag can be seen in the call

spec = importlib.util.spec_from_file_location('guest', GUEST)
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

# A fake pwd module (Windows has none): hvuser is uid/gid 1001.
sys.modules['pwd'] = types.SimpleNamespace(getpwnam=lambda n: types.SimpleNamespace(pw_uid=1001, pw_gid=1002) if n == 'hvuser' else (_ for _ in ()).throw(KeyError(n)))

# Every os.open, os.mkdir and os.fchown the dispatcher makes, recorded; the real call still happens.
calls = []
real_open, real_mkdir, real_fchown = os.open, os.mkdir, os.fchown


def rec_open(path, flags, mode=0o777, *a, **k):
    calls.append(('open', os.path.basename(str(path)), flags, mode))
    real = flags & ~O_NOFOLLOW_MARK if not os.O_NOFOLLOW else flags
    return real_open(path, real | getattr(os, 'O_BINARY', 0), mode, *a, **k)  # Windows: bytes as written, as on Linux


def rec_mkdir(path, mode=0o777, *a, **k):
    calls.append(('mkdir', str(path), mode))
    return real_mkdir(path, mode, *a, **k)


fchowns = []
g.os.open = rec_open
g.os.mkdir = rec_mkdir
g.os.fchown = lambda fd, uid, gid: fchowns.append((uid, gid))
if not os.O_NOFOLLOW:
    g.os.O_NOFOLLOW = O_NOFOLLOW_MARK

# The tests' scratch folder (argv[2], HYPERV_TEST_SCRATCH's), else the system's temp folder; removed at the end.
if len(sys.argv) > 2:
    os.makedirs(sys.argv[2], exist_ok=True)
tmp = tempfile.mkdtemp(prefix='hvmcp-unit-', dir=sys.argv[2] if len(sys.argv) > 2 else None)
try:
    # ---- private_file: a new file, never through a link, 0600, owned by the run's account when root ----
    p = os.path.join(tmp, 'pf')
    g.os.geteuid = lambda: 0
    calls.clear(); fchowns.clear()
    g.private_file(p, (1001, 1002), 'hello\n')
    with open(p) as f:
        ok(f.read() == 'hello\n', 'private_file writes its text')
    op = [c for c in calls if c[0] == 'open' and c[1] == 'pf'][0]
    ok(op[2] & os.O_EXCL and op[2] & os.O_CREAT, 'private_file creates a new file (O_CREAT|O_EXCL)')
    ok(op[2] & g.os.O_NOFOLLOW, 'private_file never follows a link (O_NOFOLLOW)')
    ok(op[3] == 0o600, 'private_file asks for 0600, got %o' % op[3])
    ok(fchowns == [(1001, 1002)], 'private_file gives the file to its owner as root: %r' % fchowns)
    try:
        g.private_file(p, (0, 0), 'again')
        ok(False, 'private_file over an existing file must fail')
    except FileExistsError:
        ok(True, '')
    g.os.geteuid = lambda: 1000
    fchowns.clear()
    g.private_file(os.path.join(tmp, 'pf2'), (1001, 1002), '')
    ok(fchowns == [], 'not root (a test root): no chown')

    # ---- run_owner ----
    ok(g.run_owner('admin') == (0, 0), 'an admin run is root\'s')
    ok(g.run_owner('user') == (1001, 1002), 'a user run is hvuser\'s')

    # ---- op_run_start / op_run_poll, admin and user, with systemd mocked ----
    g.RUNS = os.path.join(tmp, 'hvmcp', 'runs')
    g.OUT = os.path.join(tmp, 'out')
    g.BUILD = '/build'
    g.boot_id = lambda: 'boot-1'
    started = []
    props = {}
    g.unit_props = lambda n: props.get(n, {})
    g.run = lambda argv, timeout=60, input_bytes=None: (started.append(argv) or (0, '', ''))
    g.os.geteuid = lambda: 0
    for n, as_ in ((1, 'admin'), (2, 'user')):
        calls.clear(); fchowns.clear()
        r = g.op_run_start({'n': n, 'command': 'echo %s' % as_, 'as': as_}, None)
        ok(r.get('started') is True and r.get('unit') == 'hvmcp-run-%d' % n, 'run %d started' % n)
        d = os.path.join(g.RUNS, str(n))
        ok(sorted(os.listdir(d)) == ['cmd.sh', 'err', 'out'], 'run %d folder holds cmd.sh, out, err: %r' % (n, os.listdir(d)))
        with open(os.path.join(d, 'cmd.sh')) as f:
            ok(f.read() == 'echo %s\n' % as_, 'run %d script' % n)
        mk = [c for c in calls if c[0] == 'mkdir' and c[1].replace('\\', '/') == d.replace('\\', '/')]
        ok(mk and mk[0][2] == 0o711, 'run %d folder is 0711 (traversable, not listable): %r' % (n, mk))
        made = {c[1]: c for c in calls if c[0] == 'open'}
        for name in ('cmd.sh', 'out', 'err'):
            ok(name in made and made[name][3] == 0o600 and made[name][2] & os.O_EXCL, 'run %d %s is a new 0600 file' % (n, name))
        want = (0, 0) if as_ == 'admin' else (1001, 1002)
        ok(fchowns == [want] * 3, 'run %d files belong to the run\'s account %r: %r' % (n, want, fchowns))
        argv = started[-1]
        ok('--property=StandardOutput=truncate:' + os.path.join(d, 'out').replace('\\', '/') in [a.replace('\\', '/') for a in argv], 'run %d stdout goes to its folder: %r' % (n, argv))
        ok('--property=StandardError=truncate:' + os.path.join(d, 'err').replace('\\', '/') in [a.replace('\\', '/') for a in argv], 'run %d stderr goes to its folder' % n)
        ok(argv[-1].replace('\\', '/') == os.path.join(d, 'cmd.sh').replace('\\', '/'), 'run %d runs its own script' % n)
        ok(('--uid=hvuser' in argv) == (as_ == 'user'), 'run %d --uid only for a user run' % n)
        ok(not os.listdir(g.OUT), '/out holds nothing of run %d: %r' % (n, os.listdir(g.OUT)))
    # A second start of a loaded run is refused; a folder from an earlier boot is replaced.
    props[1] = {'LoadState': 'loaded'}
    try:
        g.op_run_start({'n': 1, 'command': 'x'}, None)
        ok(False, 'a loaded run number must be refused')
    except g.Refused:
        ok(True, '')
    props[1] = {}
    with open(os.path.join(g.RUNS, '1', 'stale'), 'w') as f:
        f.write('old boot')
    g.op_run_start({'n': 1, 'command': 'echo again'}, None)
    ok('stale' not in os.listdir(os.path.join(g.RUNS, '1')), 'an earlier boot\'s folder is replaced')
    # Poll reads the same files start named, capped.
    with open(os.path.join(g.RUNS, '2', 'out'), 'w') as f:
        f.write('x' * 50)
    with open(os.path.join(g.RUNS, '2', 'err'), 'w') as f:
        f.write('oops')
    props[2] = {'LoadState': 'loaded', 'ExecMainExitTimestampMonotonic': '123', 'SubState': 'exited', 'ExecMainCode': '1', 'ExecMainStatus': '3'}
    r = g.op_run_poll({'n': 2, 'cap': 10}, None)
    ok(r['done'] and r['exitCode'] == 3, 'poll: done, exit 3: %r' % r)
    ok(r['stdout'] == 'x' * 10 and r['stdoutCut'] is True, 'poll: stdout from the run folder, capped')
    ok(r['stderr'] == 'oops' and r['stderrCut'] is False, 'poll: stderr from the run folder')
    props[2]['ExecMainCode'] = '2'; props[2]['ExecMainStatus'] = '9'
    ok(g.op_run_poll({'n': 2}, None)['exitCode'] == 137, 'poll: killed by signal 9 reads 137')

    # ---- op_finish: cloud-init off, other host keys gone, the cached seed removed, links not followed ----
    etc = os.path.join(tmp, 'etc-ssh'); os.mkdir(etc)
    for k in ('ssh_host_ed25519_key', 'ssh_host_ed25519_key.pub', 'ssh_host_rsa_key', 'ssh_host_rsa_key.pub'):
        with open(os.path.join(etc, k), 'w') as f:
            f.write(k)
    cloud = os.path.join(tmp, 'var-lib-cloud'); os.makedirs(os.path.join(cloud, 'instances', 'i-1'))
    with open(os.path.join(cloud, 'instances', 'i-1', 'user-data.txt'), 'w') as f:
        f.write('PRIVATE KEY')
    keep = os.path.join(tmp, 'keep'); os.mkdir(keep)
    with open(os.path.join(keep, 'precious'), 'w') as f:
        f.write('must stay')
    os.symlink(keep, os.path.join(cloud, 'instance'), target_is_directory=True)  # a link to somewhere else
    g.CLOUD_DISABLED = os.path.join(tmp, 'cloud-init.disabled')
    g.ETC_SSH = etc
    g.CLOUD_CACHE = (os.path.join(cloud, 'instance'), os.path.join(cloud, 'instances'))
    r = g.op_finish({}, None)
    ok(r == {'finished': True, 'seedCacheLeft': []}, 'finish: nothing left: %r' % r)
    ok(os.path.exists(g.CLOUD_DISABLED), 'finish: cloud-init turned off')
    ok(sorted(os.listdir(etc)) == ['ssh_host_ed25519_key', 'ssh_host_ed25519_key.pub'], 'finish: only the ed25519 host key stays: %r' % os.listdir(etc))
    ok(not os.path.lexists(os.path.join(cloud, 'instance')) and not os.path.lexists(os.path.join(cloud, 'instances')), 'finish: the cached seed is gone')
    ok(os.path.exists(os.path.join(keep, 'precious')), 'finish: a link is removed, its target untouched')
    # instances itself a link: unlinked, its target kept.
    os.symlink(keep, os.path.join(cloud, 'instances'), target_is_directory=True)
    os.unlink(g.CLOUD_DISABLED)
    r = g.op_finish({}, None)
    ok(r['seedCacheLeft'] == [] and os.path.exists(os.path.join(keep, 'precious')), 'finish: an instances link is unlinked, its target kept')
    # What it couldn't remove is listed.
    os.makedirs(os.path.join(cloud, 'instances', 'i-2'))
    real_rmtree = g.shutil.rmtree
    g.shutil.rmtree = lambda p, *a, **k: None
    try:
        r = g.op_finish({}, None)
    finally:
        g.shutil.rmtree = real_rmtree
    ok(r['seedCacheLeft'] == [os.path.join(cloud, 'instances')], 'finish: a cache it couldn\'t remove is listed: %r' % r)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print('OK %d' % checks)
