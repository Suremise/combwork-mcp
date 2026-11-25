# hyper-v: configuration and limits

Every env setting, the timings, versions, and the limits. Part of the [hyper-v docs](../README.md#more).

## Configuration (`env`)

Every setting is in the shipped `combwork-mcp.example.json`'s `env`, with its default, so Combwork's MCP editor shows
each one (`.combwork/mcp/hyper-v.json`). A number setting has a default and no range of its own: a value is held back
only where a larger one would break something, and the reason is given here.

| Variable | Meaning |
|---|---|
| `HYPERV_MCP_ENABLED` | Must be `1`, or every tool refuses (`vm_status` still answers). A kill switch, not authentication. |
| `HYPERV_MCP_MODE` | `direct` for direct mode (see [Direct mode](setup.md#direct-mode-no-service-weaker-read-this-first)); otherwise service mode. |
| `HYPERV_MCP_ALLOWED_ROOTS`, `HYPERV_MCP_ROOTS_FROM_CWD` | Where builds may come from, for clients that send no roots (see [Multiple projects](tools.md#multiple-projects-mcp-roots)). |
| `HYPERV_MCP_MAX_BUILD_MB` | A cap this server applies before streaming a build (default 2048, no upper limit). The policy's `maxBuildMB` is the helper's own cap. |
| `HYPERV_MCP_PIPE` | Optional. The pipe's name (default `hyperv-mcp`). |
| `HYPERV_MCP_REPLY_MS` | How long a slow tool, or `vm_wait`, waits before replying "still in progress" (default 45000, at least 1000; see [Slow operations](tools.md#slow-operations)). Keep it under your MCP client's tool-call timeout. At most about 24.8 days: Node's timers fire at once past that. |
| `HYPERV_MCP_OUTPUT_BYTES` | How much of each of a `vm_run`'s stdout and stderr comes back (default 16384). At most 1 MB: a Linux guest's dispatcher (`guest.py`, copied into each VM when it is built) returns no more. Sent to the helper like the timings, so a lease keeps its connection's value. |
| `HYPERV_MCP_COMMAND_CHARS` | How long a `vm_run` command may be, in characters (default 8000, formerly fixed; MC-1588). At most 4194304: the command reaches the helper inside one request line of at most 4 MB (the service host's line limit), so a command with many characters JSON escapes (`\uXXXX`) is refused by that limit sooner. A long command reaches a Windows guest in 1 MB pieces and a Linux guest as bytes after its request, so no guest call carries it whole. A Linux VM built before MC-1588 takes at most 8000 characters (its `guest.py`): rebuild it for longer ones, and the reply says so. Sent to the helper like the timings, so a lease keeps its connection's value. |
| `HYPERV_MCP_*_MINUTES`, `HYPERV_MCP_*_SECONDS` | How long the helper waits for slow work (see [Timings](#timings) below). |

### Timings

How long the helper waits before it gives up on slow work (MC-1558). The defaults are generous, sized for a slow or busy
PC rather than a fast one. Change one if your PC needs it: in Combwork, in this server's `env` (the MCP editor,
`.combwork/mcp/hyper-v.json`), where each is listed with its default. This server sends them to the helper each time it
connects. vm_status shows the values in effect for your connection.

Any value above 0 is used as given (fractions too); 0 or less, or not a number, is ignored with a note and the default
used. There is no range (MC-1579), except where a larger value breaks something:
- `HYPERV_MCP_COPY_IDLE_MINUTES` is at most 9: PowerShell Direct ends any one call after about 10 minutes (below).
- Every timing is at most about 24.8 days (35791 minutes): Node's timers, and `hv.ps1`'s `[int]` milliseconds, stop
  there. A call whose bound adds several timings is held to that too.
A value over its most is used at its most, with a note saying why.

| Key | Default | What it bounds |
|---|---|---|
| `HYPERV_MCP_GUEST_READY_MINUTES` | 10 | a started or restored guest answering (and a new Linux VM's first boot) |
| `HYPERV_MCP_RESTORE_MINUTES` | 10 | a checkpoint restore once the VM is off |
| `HYPERV_MCP_OFF_WAIT_SECONDS` | 120 | a VM reaching Off before a restore. The restore's call allows this plus the restore |
| `HYPERV_MCP_RESTORE_VERIFY_SECONDS` | 180 | a restored VM's new checkpoint showing, read fresh after the restore |
| `HYPERV_MCP_CHECKPOINT_MINUTES` | 10 | taking a checkpoint, or removing one (removing merges its disk) |
| `HYPERV_MCP_QUEUE_KEEP_MINUTES` | 10 | a place in vm_acquire's line between two calls |
| `HYPERV_MCP_LOGON_MINUTES` | 10 | an interactive logon at vm_start |
| `HYPERV_MCP_SHUTDOWN_MINUTES` | 5 | a guest shutting down cleanly (its call allows 1 min more; the clean checkpoint's, 10) |
| `HYPERV_MCP_INSTALL_MINUTES` | 90 | Windows setup in a new pool VM |
| `HYPERV_MCP_PROVISION_MINUTES` | 30 | each account's first-logon provisioning at build |
| `HYPERV_MCP_CLOUD_INIT_MINUTES` | 15 | cloud-init in a new Linux VM |
| `HYPERV_MCP_COPY_IDLE_MINUTES` | 5 | a Windows build copy or vm_sync with no 32 MB part or file finished (below); at most 9 |
| `HYPERV_MCP_NETWORK_SECONDS` | 90 | a connected start's guest network: read back until it is right (a DHCP address, its route and DNS; or host mode's static address) and has held, then it goes on at once. This is only the ceiling (MC-1566) |
| `HYPERV_MCP_GUEST_SCRIPT_MINUTES` | 30 | the guest setup script a plan names, in each VM it builds (see [Guest setup script](pool.md#guest-setup-script)) |

- **Whose values apply.** A lease keeps the values its connection had when it was acquired: for everything done for it,
  its restore at release, disconnect or deadline included (which then runs to its own bound, but never runs guest work
  after the lease ended). A pool job keeps the values of the connection that applied it. Work with no client behind it
  (start-up recovery, retrying a quarantined VM) uses the defaults. A place in line uses the waiting connection's.
- **Setup's caps.** policy.json may hold `timingCaps`, `{ key: highest value }` with the keys above in their camelCase
  form (`guestReadyMinutes`, `offWaitSeconds`, `outputBytes`, ...): an admin's own limit, which setup doesn't set (none
  ships). Each must be above 0 and at most the key's most (above). A cap lowers the default too. An invalid one
  stops the helper from starting, saying why. policy.json is only writable by Administrators.
- **Windows copies.** A build's copy-in and vm_sync go in calls of at most 64 MB and 500 files, a file over 32 MB as 32 MB
  parts, each appended in the guest at once. The copy fails only when a call finishes no part or file within
  `HYPERV_MCP_COPY_IDLE_MINUTES`: a large copy at a slow but steady rate never meets a whole-copy limit. A call cut off
  after finishing some goes on with only what the guest hasn't committed, never resending the rest; one that finished
  nothing new fails. Each append is marked before it starts, so one cut off inside a part is rolled back to the part's
  start rather than resumed half-way. Progress is counted in whole parts or files, not bytes. The cap
  of 9 minutes stays under PowerShell Direct's own limit of about 10 minutes per call.
- **Linux copies** go over SSH, which has no such limit, in one call bounded by size, not progress: 30 minutes plus one
  per 100 MB.
- **Fixed waits**, the same for every client: the service host kills a helper that doesn't answer its heartbeat for 5
  minutes (every lease then ends); a VM's turn-off after a failed online step 3 min; a run's poll at least 30 s and its
  kill's cleanup 60 s; removing a VM 10 min; the client's roots/list answer 30 s; setup waits up to 30 min for the helper
  to start (saying so after 5) and 5 min for the service to stop. The build's guest setup is one call of up to 8
  minutes, retried once after a timeout or a lost connection (its script can run twice), never after another error.
  The build presses Enter for 60 s for the "Press any key to boot from CD or DVD" prompt: a fixed window, not a check
  that the VM booted.

Test-only:
- `HYPERV_MCP_PS_STUB`, `HYPERV_MCP_STUB_STATE`: a fake `hv.ps1`;
- `HYPERV_MCP_CRASH_AT`: crash injection;
- `HYPERV_MCP_STATE_DIR`;
- timing: the `HYPERV_MCP_*_MS` variables in `test\timing.json` (its defaults, narrow values and named profiles; each
  replaces a default), plus
  `HYPERV_MCP_MINUTE_MS`, `HYPERV_MCP_COPY_PART_BYTES` and the service host's `HYPERV_MCP_HOST_HEARTBEAT_MS`;
- `HYPERV_MCP_MIN_ISO_BYTES`.

The service's environment is set by its host, which users can't change.

### Server and helper versions

The server and the helper speak a numbered protocol, and since protocol 3 the helper also names its added features
(`vm_status` shows the helper's protocol). A server uses a feature when the helper speaks **at least** its protocol, or
names it, so a newer helper keeps serving older servers:
- protocol 2: `vm_renew`, `vm_sync`, `vm_reset`;
- protocol 3: `vm_start`'s `interactive` and `vm_run`'s `session`;
- feature `projects` (protocol 3): projects, `vm_acquire`'s `wait` and a project's own build folders;
- feature `images` (protocol 3): image groups, `vm_acquire`'s `os` and `image`, shares by OS, a project's image list.
  The server sends no `vm_acquire` at all for an `image`, or an OS other than Windows, to a helper without it.
- feature `multi-vm` (protocol 3): several leases per connection, every lease op's `vm`, and the `leases` op. A helper
  without it would ignore a `vm` it doesn't know and act on its one VM, so the server refuses `vm` to it, sending
  nothing (MC-1580); without `vm`, one VM per session works as before. A second `vm_acquire` is refused by that helper
  itself ("one VM per connection", no lease changed); the server adds that it needs the newer helper.
- feature `network-modes` (protocol 3): the network modes as strings (`none`, `host`, `internet`, `internet-lan`) in
  `vm_start`, `vm_reset` and `pool_plan`. A helper without it would read any of them, `none` included, as networking
  on, so the server refuses each with "run setup again" and sends nothing; the old booleans (`true` host, `false`
  none) still go to it as before (MC-1570).

The helper stays at protocol 3 for these features because an earlier server (MC-1503's) asks for exactly hyperv-mcp/3 before an
interactive run: it keeps working with this helper. An older helper refuses each newer feature with "run setup again"
rather than quietly ignoring it. A newer feature also needs the newer server: an agent's server loads at its start, so
update the server (and restart the agent) as well as the helper.

## Limits

### Limits that are settings

Nothing here is a fixed limit of the server's own (MC-1579): each is a setting with a default, and a ceiling is left
only where a larger value breaks something, named with its reason.
- **In the server's `env`** (see [Configuration](#configuration-env)): the timings, `vm_run`'s output (`HYPERV_MCP_OUTPUT_BYTES`) and
  its command's length (`HYPERV_MCP_COMMAND_CHARS`, default 8000, formerly fixed), the build size this server streams
  and the reply wait.
- **In setup's policy** (an admin's, see [Setup](../README.md#setup)): VMs, cores, memory and disk with no ceiling of setup's (formerly 64
  VMs, 64 cores, 1 TB, 4 TB). Hyper-V's own maximums depend on its version ([Microsoft's table](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/maximum-scale-limits)
  lists Windows Server's, not Windows 11's), so Hyper-V itself refuses a VM past them, by name, when it is created. A
  disk is at least 64 GB (Windows 11 needs it). Leases and work sessions have no ceiling (formerly 24 h): a deadline
  past Node's 24.8-day timer is waited for in steps, and a session ends no later than the last date JavaScript can hold
  (the year 275760); `maxBuildMB` with no upper limit; any number of projects, of folders and
  build roots, and of images in a project (formerly 16); and the checkpoint settings, `maxLeaseCheckpoints` (default
  3) and `maxCheckpointsPerVm` (default 4), which together may be at most 48: Hyper-V keeps at most 50 checkpoints of
  a VM (on every version Microsoft lists), and its clean checkpoint, with a second one while it is refreshed, takes 2. `minFreeGBForCheckpoint` (default
  20) may be 0.
- **Images** have no size cap (formerly 16 GB for an ISO, 4 GB for a qcow2). A Linux image's disk is held to its
  virtual size, at most `maxDiskGBPerVm` (and VHD's own 2040 GB, the format it is converted through). The build's
  check of an ISO's hash allows 10 minutes and 1 more per GB.
- **Kept, with their reasons:** `HYPERV_MCP_COPY_IDLE_MINUTES` at most 9 (PowerShell Direct's ~10-minute call);
  `HYPERV_MCP_OUTPUT_BYTES` at most 1 MB (`guest.py`); a request to the helper at most 4 MB (the service host's line
  limit), and so `HYPERV_MCP_COMMAND_CHARS` at most 4194304.
- **`vm_run`'s `timeoutSec`** has no ceiling (formerly 3600): a run is started in one short call and then polled, so no
  call is held for it. `HYPERV_MCP_GUEST_SCRIPT_MINUTES` (MC-1577) has no range either (formerly 1-360), for the same
  reason.
- **Settled by MC-1588:** three limits that went to or from the guest in one call. None travels in one call now, so
  what one call carries no longer limits them. A PowerShell Direct call refuses an object over PowerShell remoting's
  `MaximumReceivedObjectSizeMB` (10 MB by default; not measured on a real VM for PowerShell Direct), so every piece
  stays under it even counted at two bytes a character.
  - A `vm_run` command: a setting, `HYPERV_MCP_COMMAND_CHARS` (default 8000), at most 4194304 (the helper's 4 MB
    request line; see [Configuration](#configuration-env)). Over 256K characters, it reaches a Windows guest in 1 MB pieces (base64), as
    the account that runs it, and the start refuses it unless the staged file holds exactly the bytes sent. Over 8000,
    it reaches a Linux guest as bytes after the request line; `guest.py` no longer caps its length. Neither the cmd.exe
    line limit (8191) nor the Windows command line (32767) applies: the command is written to a script file in the
    guest and run from there (a single line of a `.cmd` over 8191 characters is still cmd's own error).
  - The guest setup script: at most 536870887 bytes (about 512 MB; formerly 1 MB). The helper reads it as text, and
    Node holds a string of at most 536870888 characters (`buffer.constants.MAX_STRING_LENGTH`), one of which a `.ps1`'s
    byte order mark takes. It goes to the guest as a long command does.
  - `vm_read_out`: `maxBytes` has no cap of its own (formerly 16 MB); `maxTotalBytes` at most 12582912 (12 MB;
    MC-1597, formerly about 85 MB). The files come back in one MCP reply, and a client takes only so much in one
    message: Claude Code drops a stdio server whose reply passes 16 MB, and the session loses its VM tools and its lease
    until `/mcp` reconnects it. So each reply is filled up to about 12 MB measured as sent: a text file's quotes and
    newlines are written as two bytes, its other control characters as six (`\u00XX`), binary as base64 (4/3). A file
    that doesn't fit stops there, on a whole character, and its title says `read on with offset: N`; call again with
    `paths` naming just that file and `offset: N` (`maxBytes` then counts from the offset). Files after it are named,
    not sent. An image too big for one reply as an image says to pass `base64: true`, which reads it in parts. A
    Windows guest's files are read in calls of at most 2 MB, each going on where the last stopped; a Linux guest's in
    one call. A Linux VM built before MC-1597 has a dispatcher with no offset: the helper reads it from the file's start
    and drops the front, up to 96 MB in; past that, rebuild the VM. Any other reply past 15 MB (none is known to reach
    it) is sent as an error saying so, never whole.

### Other limits

- A cold start of a VM boots Windows: tens of seconds. A start from a checkpoint taken while running would be faster,
  but the clean baseline is taken powered off, so that "clean" is exact.
- `vm_run` returns 16 KB per stream by default (`HYPERV_MCP_OUTPUT_BYTES`, up to 1 MB; see [Configuration](#configuration-env)), and `vm_read_out` at 256 KB per file and 1 MB per call by default (up to 12 MB a call, about 12 MB a reply as sent).
  Write big results to a file in `C:\out` and read it in parts (`offset`). `vm_run`'s two streams stay within one
  reply: 1 MB each at most, about 6 MB each as sent even if all control characters.
- Commands run over PowerShell Direct in session 0, as the admin, or as the standard user in its own PowerShell Direct
  session. For that, the guest's admin adds the user to the guest's Remote Management Users group first, inside that
  throwaway guest only. A desktop session needs `vm_start`'s `interactive`: one guest restart, and only the account it
  logged on can run there. There are no screenshots.
- An interactive run that times out restores the VM (see [The interactive session](security.md#security-model)): give such runs a generous
  `timeoutSec`.
- **Long runs:** since the September 2025 Windows updates, PowerShell Direct ends any single call after 10 minutes, with
  "The Hyper-V socket target process has ended" ([PowerShell #26176](https://github.com/PowerShell/PowerShell/issues/26176)).
  So no run holds a call open: it is started (or, in the interactive session, published to the session's watcher) in
  one short call, then its exit file is polled with short calls (every second at first, then every few seconds) until
  it's there or `timeoutSec` passes. A poll that fails is retried within that same deadline. A process started from a
  call goes on after the call ends. Windows copies (`vm_start`'s build copy and `vm_sync`) go in bounded calls of at most
  64 MB each (MC-1558, see [Timings](#timings)), so a big build on a slow host never meets that limit; a copy that stops making
  progress fails, and `C:\build` is then untrusted until a full sync or a reset. `maxBuildMB` limits bytes, not time.
- Windows guests from an x64 ISO with `sources\install.wim`, run so far on Windows 11; Linux guests from a qcow2 cloud
  image with cloud-init, systemd, OpenSSH and `hv_sock`, run so far on Debian 13 and Ubuntu 26.04 (see [The image](pool.md#the-image) and
  [Linux guests](linux.md#linux-guests)). An evaluation VM lasts about 90 days from its activation at build (see [Windows licences](pool.md#windows-licences)).
  Building from a ready-made VHDX isn't supported: an own copy comes from an ISO.
- A sync tracks only what the helper copied into `C:\build`. A run that changes `C:\build` itself isn't seen; a
  file renamed only in case on the host keeps its old spelling in the guest. `full: true` or `vm_reset` puts either
  right. State across a guest reboot within a session isn't specially kept (a reboot is the guest's own business).
