#!/usr/bin/python3
# hyper-v MCP: the guest dispatcher of a Linux guest (MC-1501; design: docs/linux-guests.md §3, §5).
#
# Installed by the build's cloud-init seed as /usr/local/libexec/hvmcp/dispatch (root:root 0755). The helper reaches it
# only through SSH's forced command for hvadmin (`restrict,command="sudo -n /usr/local/libexec/hvmcp/dispatch"`), so
# it runs as root, with one JSON request as the first line of stdin (a sync's file bytes follow it), and answers one
# line on stdout: HVJSON:{"result": ...} or HVJSON:{"error": "..."}. Nothing it is sent is run by a shell except a run's
# own command, which is written to a file and run by bash or sh as data. Python 3 standard library only.
#
# Paths under /build and /out are always walked one component at a time from a directory fd, with O_NOFOLLOW: a
# symlink on the way is never entered (refused, or removed as itself when it is in the way and delete is allowed).
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys

# Tests only: an unprivileged run may move the folders under HVMCP_TEST_ROOT. As root (the only way the helper runs it,
# through sudo, which resets the environment anyway) the variable is ignored.
ROOT = os.environ.get('HVMCP_TEST_ROOT', '') if os.geteuid() != 0 else ''
BUILD = ROOT + '/build'
OUT = ROOT + '/out'
HVMCP = ROOT + '/hvmcp'
RUNS = HVMCP + '/runs'
STAGING = HVMCP + '/staging'
DISPATCH = '/usr/local/libexec/hvmcp/dispatch'
USER = 'hvuser'
CAP_DEFAULT = 16 * 1024
MAX_FILES = 200000
MAX_LIST = 1000
NOFOLLOW_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
DIAG_KEYS = ('stage', 'vmbus', 'hv_sock_driver', 'hv_sock_modinfo', 'vsock_listen', 'sshd_config_ok', 'sshd_error', 'kernel')


class Refused(Exception):
    pass


def answer(obj):
    sys.stdout.write('HVJSON:' + json.dumps(obj, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def boot_id():
    with open('/proc/sys/kernel/random/boot_id') as f:
        return f.read().strip()


def run(argv, timeout=60, input_bytes=None):
    p = subprocess.run(argv, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')


# ---------- paths ----------

def segments(p):
    if not isinstance(p, str) or not p or len(p) > 4096 or '\0' in p:
        raise Refused('a bad path')
    parts = [s for s in re.split(r'[\\/]', p) if s != '']
    if not parts:
        raise Refused('an empty path')
    for s in parts:
        if s in ('.', '..') or len(s.encode('utf-8')) > 255:
            raise Refused('the path %r has a bad component' % p)
    return parts


def kind_at(dirfd, name):
    """'dir', 'file', 'link', 'other', or None (absent), never following a link."""
    try:
        st = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(st.st_mode):
        return 'link'
    if stat.S_ISDIR(st.st_mode):
        return 'dir'
    if stat.S_ISREG(st.st_mode):
        return 'file'
    return 'other'


def open_root(path):
    """The root folder (/build, /out) as a directory fd: a symlink there is refused."""
    try:
        return os.open(path, NOFOLLOW_DIR)
    except OSError as e:
        raise Refused('%s is not a real folder (%s)' % (path, e.strerror))


def remove_tree_at(dirfd, name):
    """Removes name under dirfd: a link or file is unlinked as itself; a real folder is emptied (never entering a
    link) and removed."""
    k = kind_at(dirfd, name)
    if k is None:
        return
    if k != 'dir':
        os.unlink(name, dir_fd=dirfd)
        return
    fd = os.open(name, NOFOLLOW_DIR, dir_fd=dirfd)
    try:
        for e in os.scandir(fd):
            remove_tree_at(fd, e.name)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=dirfd)


def walk_dirs(rootfd, parts, create=False):
    """The directory fd of parts (all real folders), or None when one is missing (create=False). A link or a file on the
    way is refused. The caller closes the fd (never rootfd)."""
    fd = rootfd
    for s in parts:
        k = kind_at(fd, s)
        if k is None:
            if not create:
                if fd != rootfd:
                    os.close(fd)
                return None
            os.mkdir(s, 0o755, dir_fd=fd)
        elif k != 'dir':
            if fd != rootfd:
                os.close(fd)
            raise Refused('%s is in the way (a %s, not a folder)' % ('/'.join(parts), k))
        nfd = os.open(s, NOFOLLOW_DIR, dir_fd=fd)
        if fd != rootfd:
            os.close(fd)
        fd = nfd
    return fd


# ---------- sync (and a start's copy) ----------

def read_exact(stream, n):
    out = bytearray()
    while len(out) < n:
        chunk = stream.read(min(n - len(out), 1024 * 1024))
        if not chunk:
            raise Refused('the stream ended early')
        out += chunk
    return bytes(out)


def executable(head):
    return head.startswith(b'#!') or head.startswith(b'\x7fELF')


def op_sync(req, stream):
    files = req.get('files') or []
    remove = req.get('remove') or []
    full = bool(req.get('full'))
    delete = req.get('delete', True) is not False
    gen = req.get('gen')
    if not isinstance(gen, int) or gen < 0 or gen > 10 ** 9:
        raise Refused('a bad generation')
    if not isinstance(files, list) or not isinstance(remove, list) or len(files) > MAX_FILES or len(remove) > MAX_FILES:
        raise Refused('bad lists')
    plan = []
    seen = set()
    for f in files:
        parts = segments(f.get('path'))
        size = f.get('size')
        digest = f.get('sha256')
        if not isinstance(size, int) or size < 0 or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise Refused('a bad file entry')
        key = '/'.join(parts)
        if key in seen:
            raise Refused('%s is named twice' % key)
        seen.add(key)
        plan.append((parts, size, digest))
    keys = sorted(seen)
    for a, b in zip(keys, keys[1:]):
        if b.startswith(a + '/'):
            raise Refused('%s and something inside it are both named' % a)
    rm = [segments(p) for p in remove]
    # Stage every file first, checking its size and hash as it arrives: nothing in /build changes before all are here.
    stage = '%s/%d' % (STAGING, gen)
    if os.path.lexists(stage):
        shutil.rmtree(stage)
    os.makedirs(stage, mode=0o700)
    staged = []
    try:
        for i, (parts, size, digest) in enumerate(plan):
            data = read_exact(stream, size)
            if hashlib.sha256(data).hexdigest() != digest:
                raise Refused('%s arrived with another hash' % '/'.join(parts))
            p = '%s/%d' % (stage, i)
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            with os.fdopen(fd, 'wb') as out:
                out.write(data)
            os.chmod(p, 0o755 if executable(data[:4]) else 0o644)
            staged.append(p)
        root = open_root(BUILD)
        try:
            # Check everything before changing anything (guest-sync.ps1's rules, in POSIX terms).
            blockers = []
            if not full:
                for parts, _, _ in plan:
                    fd = root
                    for j, s in enumerate(parts[:-1]):
                        k = kind_at(fd, s)
                        if k is None:
                            break
                        if k != 'dir':
                            blockers.append('/'.join(parts[:j + 1]))
                            break
                        nfd = os.open(s, NOFOLLOW_DIR, dir_fd=fd)
                        if fd != root:
                            os.close(fd)
                        fd = nfd
                    else:
                        if kind_at(fd, parts[-1]) in ('dir', 'link', 'other'):
                            blockers.append('/'.join(parts))
                    if fd != root:
                        os.close(fd)
                if blockers and not delete:
                    raise Refused('with delete false, these are in the way and were left alone (nothing was changed): %s' % ', '.join(sorted(set(blockers))))
            removed = 0
            if full:
                for e in os.scandir(root):
                    remove_tree_at(root, e.name)
                    removed += 1
            else:
                for parts in rm:
                    fd = walk_dirs(root, parts[:-1])
                    if fd is None:
                        continue
                    try:
                        if kind_at(fd, parts[-1]) is not None:
                            remove_tree_at(fd, parts[-1])
                            removed += 1
                    finally:
                        if fd != root:
                            os.close(fd)
                for b in sorted(set(blockers), key=lambda x: -x.count('/')):
                    bp = b.split('/')
                    fd = walk_dirs(root, bp[:-1])
                    if fd is not None:
                        try:
                            remove_tree_at(fd, bp[-1])
                        finally:
                            if fd != root:
                                os.close(fd)
            for (parts, _, _), src in zip(plan, staged):
                fd = walk_dirs(root, parts[:-1], create=True)
                try:
                    if kind_at(fd, parts[-1]) == 'dir':
                        remove_tree_at(fd, parts[-1])
                    os.rename(src, parts[-1], dst_dir_fd=fd)
                finally:
                    if fd != root:
                        os.close(fd)
            return {'copied': len(plan), 'removed': removed}
        finally:
            os.close(root)
    finally:
        shutil.rmtree(stage, ignore_errors=True)


# ---------- runs ----------

def unit_of(n):
    return 'hvmcp-run-%d' % n


def unit_props(n):
    code, out, _ = run(['systemctl', 'show', unit_of(n), '-p', 'LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,ExecMainExitTimestampMonotonic'])
    props = {}
    for line in out.splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            props[k] = v
    return props


def read_capped(path, cap):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return '', False
    with os.fdopen(fd, 'rb') as f:
        data = f.read(cap + 1)
    return data[:cap].decode('utf-8', 'replace'), len(data) > cap


def run_number(req):
    n = req.get('n')
    if not isinstance(n, int) or n < 1 or n > 10 ** 9:
        raise Refused('a bad run number')
    return n


def op_run_start(req, _):
    n = run_number(req)
    command = req.get('command')
    shell = req.get('shell', 'bash')
    as_ = req.get('as', 'admin')
    cwd = req.get('cwd') or BUILD
    if not isinstance(command, str) or not command.strip() or len(command) > 8000 or '\0' in command:
        raise Refused('a bad command')
    if shell not in ('bash', 'sh'):
        raise Refused('shell must be bash or sh')
    if as_ not in ('admin', 'user'):
        raise Refused('as must be admin or user')
    if not isinstance(cwd, str) or not cwd.startswith('/') or len(cwd) > 1024 or re.search(r'[\0-\x1f]', cwd):
        raise Refused('cwd must be an absolute guest folder such as /build')
    d = '%s/%d' % (RUNS, n)
    # A run of this number in this boot is refused; a folder left by an earlier boot (a checkpoint taken after a run,
    # then started from by another lease, whose run numbers start again) is that boot's, and is replaced.
    if unit_props(n).get('LoadState') == 'loaded':
        raise Refused('run %d already exists' % n)
    if os.path.lexists(d):
        shutil.rmtree(d)
    os.makedirs(RUNS, mode=0o711, exist_ok=True)
    os.mkdir(d, 0o755)
    script = d + '/cmd.sh'
    fd = os.open(script, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(command)
        f.write('\n')
    os.makedirs(OUT, exist_ok=True)
    out = '%s/.run-%d.out' % (OUT, n)
    err = '%s/.run-%d.err' % (OUT, n)
    argv = ['systemd-run', '--unit=' + unit_of(n), '--quiet', '--no-block', '--service-type=exec',
            '--property=RemainAfterExit=yes', '--working-directory=' + cwd,
            '--property=StandardOutput=truncate:' + out, '--property=StandardError=truncate:' + err,
            '--property=StandardInput=null', '--setenv=HOME=' + ('/root' if as_ == 'admin' else '/home/' + USER)]
    if as_ == 'user':
        argv += ['--uid=' + USER, '--gid=' + USER]
    argv += ['/bin/' + shell, script]
    code, _, e = run(argv, timeout=30)
    if code != 0:
        raise Refused('the run could not be started: %s' % e.strip()[:400])
    return {'started': True, 'unit': unit_of(n), 'boot': boot_id()}


def op_run_poll(req, _):
    n = run_number(req)
    cap = req.get('cap', CAP_DEFAULT)
    if not isinstance(cap, int) or cap < 1 or cap > 1024 * 1024:
        raise Refused('a bad cap')
    p = unit_props(n)
    if p.get('LoadState') != 'loaded':
        raise Refused('no run %d' % n)
    exited = p.get('ExecMainExitTimestampMonotonic', '0') not in ('', '0')
    done = exited and p.get('SubState') in ('exited', 'failed', 'dead')
    stdout, so_cut = read_capped('%s/.run-%d.out' % (OUT, n), cap)
    stderr, se_cut = read_capped('%s/.run-%d.err' % (OUT, n), cap)
    r = {'done': done, 'pending': False, 'stdout': stdout, 'stdoutCut': so_cut, 'stderr': stderr, 'stderrCut': se_cut}
    if done:
        # ExecMainCode 1: exited with ExecMainStatus; otherwise killed by the signal ExecMainStatus (128 + it, as a shell
        # reports it).
        status = int(p.get('ExecMainStatus') or 0)
        r['exitCode'] = status if p.get('ExecMainCode') == '1' else 128 + status
    return r


def op_run_kill(req, _):
    n = run_number(req)
    if req.get('boot') and req.get('boot') != boot_id():
        return {'killed': False, 'why': 'the guest has restarted since the run started'}
    p = unit_props(n)
    if p.get('LoadState') != 'loaded' or p.get('ExecMainExitTimestampMonotonic', '0') not in ('', '0'):
        return {'killed': False, 'gone': True}
    # The run's whole cgroup: everything it started dies with it.
    run(['systemctl', 'kill', '--signal=SIGKILL', unit_of(n)], timeout=15)
    run(['systemctl', 'stop', unit_of(n)], timeout=30)
    p = unit_props(n)
    gone = p.get('ActiveState') in ('inactive', 'failed') or p.get('LoadState') != 'loaded'
    return {'killed': gone, 'gone': gone}


# ---------- read-out ----------

def op_list(req, _):
    root = open_root(OUT)
    files, skipped = [], []

    def walk(fd, rel):
        for e in sorted(os.scandir(fd), key=lambda x: x.name):
            if len(files) >= MAX_LIST:
                return
            path = rel + '/' + e.name if rel else e.name
            k = kind_at(fd, e.name)
            if k == 'link':
                skipped.append(path)
            elif k == 'dir':
                sub = os.open(e.name, NOFOLLOW_DIR, dir_fd=fd)
                try:
                    walk(sub, path)
                finally:
                    os.close(sub)
            elif k == 'file':
                files.append({'path': path, 'size': os.stat(e.name, dir_fd=fd, follow_symlinks=False).st_size})
    try:
        walk(root, '')
    finally:
        os.close(root)
    return {'files': files, 'skipped': skipped[:50]}


def op_read(req, _):
    paths = req.get('paths') or []
    max_bytes = req.get('maxBytes')
    max_total = req.get('maxTotalBytes')
    if not isinstance(paths, list) or len(paths) > 200 or not isinstance(max_bytes, int) or not isinstance(max_total, int):
        raise Refused('bad read arguments')
    root = open_root(OUT)
    out, total = [], 0
    try:
        for p in paths:
            parts = segments(p)
            try:
                fd = walk_dirs(root, parts[:-1])
            except Refused:
                continue
            if fd is None:
                continue
            try:
                if kind_at(fd, parts[-1]) != 'file':
                    continue
                f = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                with os.fdopen(f, 'rb') as fh:
                    size = os.fstat(fh.fileno()).st_size
                    take = max(0, min(size, max_bytes, max_total - total))
                    if take <= 0 and size > 0:
                        break
                    data = fh.read(take)
            finally:
                if fd != root:
                    os.close(fd)
            total += len(data)
            out.append({'path': '/'.join(parts), 'size': size, 'cut': len(data) < size, 'data': base64.b64encode(data).decode('ascii')})
            if total >= max_total:
                break
    finally:
        os.close(root)
    return {'files': out}


# ---------- build checks and diagnostics ----------

def os_release():
    r = {}
    try:
        with open('/etc/os-release') as f:
            for line in f:
                m = re.match(r'^([A-Z_]+)=("?)(.*)\2$', line.strip())
                if m:
                    r[m.group(1)] = m.group(3)
    except OSError:
        pass
    return r


def build_serial():
    try:
        with open('/etc/cloud/build.info') as f:
            for line in f:
                if line.startswith('serial:'):
                    return line.split(':', 1)[1].strip()
    except OSError:
        pass
    return None


def addresses():
    """Every address other than loopback and IPv6 link-local, by interface."""
    code, out, _ = run(['ip', '-j', 'addr'])
    found = []
    try:
        for link in json.loads(out or '[]'):
            for a in link.get('addr_info', []):
                local = a.get('local', '')
                if a.get('scope') == 'host' or local.startswith('127.') or local == '::1' or local.lower().startswith('fe80:'):
                    continue
                found.append('%s %s' % (link.get('ifname'), local))
    except ValueError:
        found.append('unreadable')
    return found


def listeners():
    """TCP and UDP listeners on anything but loopback."""
    code, out, _ = run(['ss', '-H', '-l', '-n', '-t', '-u'])
    found = []
    for line in out.splitlines():
        cols = line.split()
        if len(cols) < 5:
            continue
        local = cols[4]
        host = local.rsplit(':', 1)[0].strip('[]')
        if host.startswith('127.') or host in ('::1',) or host.endswith('%lo'):
            continue
        found.append('%s %s' % (cols[0], local))
    return found


def unit_state(name):
    _, active, _ = run(['systemctl', 'is-active', name])
    _, enabled, _ = run(['systemctl', 'is-enabled', name])
    return {'active': active.strip(), 'enabled': enabled.strip()}


def op_verify(req, _):
    rel = os_release()
    _, ci, _ = run(['cloud-init', 'status'], timeout=60)
    m = re.search(r'status:\s*(\w+)', ci)
    try:
        with open('/etc/ssh/ssh_host_ed25519_key.pub') as f:
            host_key = ' '.join(f.read().split()[:2])
    except OSError:
        host_key = None
    other_host_keys = sorted(x for x in os.listdir('/etc/ssh') if x.startswith('ssh_host_') and x.endswith('_key') and x != 'ssh_host_ed25519_key')
    try:
        with open('/home/hvadmin/.ssh/authorized_keys') as f:
            authorized = [l.strip() for l in f if l.strip()]
    except OSError:
        authorized = None
    try:
        with open('/etc/sudoers.d/hvmcp') as f:
            sudoers = f.read()
    except OSError:
        sudoers = None
    code, sshd_err = sshd_check()
    modes = {}
    for p in (BUILD, OUT, HVMCP):
        try:
            st = os.lstat(p)
            modes[p] = {'mode': oct(stat.S_IMODE(st.st_mode)), 'uid': st.st_uid, 'dir': stat.S_ISDIR(st.st_mode)}
        except OSError:
            modes[p] = None
    return {
        'id': rel.get('ID'), 'versionId': rel.get('VERSION_ID'), 'serial': build_serial(), 'kernel': os.uname().release,
        'cloudInit': m.group(1) if m else 'unknown', 'hostKey': host_key, 'otherHostKeys': other_host_keys,
        'authorizedKeys': authorized, 'sudoers': sudoers, 'sshdConfigOk': code == 0, 'sshdConfigError': sshd_err[:200] or None,
        'socket': unit_state('hvmcp-sshd.socket'), 'ssh': unit_state('ssh.service'), 'sshSocket': unit_state('ssh.socket'),
        'addresses': addresses(), 'listeners': listeners(), 'hvSockDriver': os.path.isdir('/sys/bus/vmbus/drivers/hv_sock'),
        'cloudInitDisabled': os.path.exists('/etc/cloud/cloud-init.disabled'), 'paths': modes, 'boot': boot_id()
    }


def op_finish(req, _):
    """The build's last guest step: cloud-init never runs again (no key regeneration at a later boot), and no other host
    key is left."""
    with open('/etc/cloud/cloud-init.disabled', 'w') as f:
        f.write('hyper-v MCP: built; cloud-init stays off\n')
    for x in os.listdir('/etc/ssh'):
        if x.startswith('ssh_host_') and not x.startswith('ssh_host_ed25519_key'):
            os.unlink('/etc/ssh/' + x)
    os.sync()
    return {'finished': True}


def sshd_check():
    """sshd's own check of our config: (exit code, its first error line). MC-1544: /run/sshd is made first, as each
    connection's unit makes it (the distro's ssh.service, which would, is masked), so a missing privilege-separation
    folder is never reported as a config that doesn't parse."""
    os.makedirs('/run/sshd', mode=0o755, exist_ok=True)
    code, out, err = run(['sshd', '-t', '-f', '/etc/ssh/hvmcp_sshd_config'])
    first = next((l.strip() for l in (err + '\n' + out).splitlines() if l.strip()), '')
    return code, ('' if code == 0 else first)


def diag_facts(stage):
    def ok(b):
        return 'present' if b else 'absent'
    code, _, _ = run(['modinfo', 'hv_sock'])
    _, active, _ = run(['systemctl', 'is-active', 'hvmcp-sshd.socket'])
    sc, sshd_err = sshd_check()
    facts = {
        'stage': stage, 'vmbus': ok(os.path.isdir('/sys/bus/vmbus')), 'hv_sock_driver': ok(os.path.isdir('/sys/bus/vmbus/drivers/hv_sock')),
        'hv_sock_modinfo': ok(code == 0), 'vsock_listen': re.sub(r'[^A-Za-z0-9._+-]', '', active.strip())[:64] or 'unknown',
        'sshd_config_ok': 'yes' if sc == 0 else 'no', 'kernel': re.sub(r'[^A-Za-z0-9._+-]', '', os.uname().release)[:64]
    }
    if sshd_err:
        # The diagnostics' alphabet: spaces become underscores, anything else outside it is dropped; 64 characters.
        facts['sshd_error'] = re.sub(r'[^A-Za-z0-9._+-]', '', sshd_err.replace(' ', '_'))[:64] or 'unknown'
    return facts


def op_diag(stage):
    """Writes HVMCP-DIAG lines to the first serial port (the build's COM1 pipe): a fixed set of keys and values only."""
    if not re.fullmatch(r'[a-z-]{1,32}', stage or ''):
        stage = 'unknown'
    facts = diag_facts(stage)
    line = 'HVMCP-DIAG ' + ' '.join('%s=%s' % (k, facts[k]) for k in DIAG_KEYS if k in facts) + '\n'
    try:
        with open('/dev/ttyS0', 'w') as tty:
            tty.write(line)
    except OSError:
        pass
    return facts


def op_poweroff(req, _):
    run(['systemctl', 'poweroff', '--no-block'], timeout=15)
    return {'poweringOff': True}


OPS = {
    'ready': lambda req, _: {'ready': True, 'boot': boot_id()},
    'sync': op_sync, 'run-start': op_run_start, 'run-poll': op_run_poll, 'run-kill': op_run_kill,
    'list': op_list, 'read': op_read, 'verify': op_verify, 'finish': op_finish, 'poweroff': op_poweroff
}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--diag':
        op_diag(sys.argv[2])
        return 0
    if len(sys.argv) != 1:
        answer({'error': 'the dispatcher takes no arguments'})
        return 2
    stream = sys.stdin.buffer
    line = stream.readline(1024 * 1024 * 64)
    try:
        req = json.loads(line.decode('utf-8'))
        if not isinstance(req, dict) or req.get('op') not in OPS:
            raise Refused('an unknown operation')
        answer({'result': OPS[req['op']](req, stream)})
        return 0
    except Refused as e:
        answer({'error': str(e)})
    except Exception as e:  # noqa: BLE001 - every failure is answered, never a traceback on stdout
        answer({'error': '%s: %s' % (type(e).__name__, e)})
    return 1


if __name__ == '__main__':
    sys.exit(main())
