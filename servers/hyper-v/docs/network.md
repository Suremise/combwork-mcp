# hyper-v: network modes in full

Each mode, how it is set up and checked, and host mode with your firewall. Part of the [hyper-v docs](../README.md#more).

## Network modes

Each run has a network mode (MC-1556). There are two caps, as with CPUs, memory and disk:
- **setup's policy**, the highest mode any pool may have: `-MaxNetwork None|Host|Internet|InternetLan`. A new install
  is `None`; a rerun keeps the current value (an older install's `-AllowNetwork $true` becomes `Host`);
- **the pool's mode**, chosen in the plan you approve (`pool_plan`'s `network`). An agent describes the options when
  the pool is planned; every create and resize plan states it, and changing it is a resize you approve.

A run asks for a mode at or below the pool's (`vm_start` or `vm_reset`'s `network`, default `none`). A run already
going when the pool's mode is lowered keeps its mode until its next start, reset or restore, which is checked against
both caps then and refused above either. A Linux checkpoint restarts the VM: above a cap, it restarts with network
`none` and says so.

| Mode | The VM reaches | How |
|---|---|---|
| `none` (default) | nothing | the adapter is disconnected |
| `host` | only this PC, at its host-mode address, and only on the ports this PC's firewall allows | setup's internal switch `hvmcp-host` on `-HostSubnet` (default `10.137.42.0/24`: this PC is `.1`, VMs `.10` up). The helper gives the guest its address at start; the adapter's rules allow only this PC's address and block everything else, other VMs and IPv6 included |
| `internet` | the internet; not your LAN | Windows' Default Switch (its own NAT: nothing new on your network). The guest's traffic leaves this PC under its address. The adapter's rules block private address ranges (except the switch's gateway, which the guest needs for DHCP and DNS) and IPv6 |
| `internet-lan` | the internet and your LAN | the Default Switch; only IPv6 is blocked |

In every connected mode the order is fixed: the VM is off and disconnected, its rules are added and read back, and only
then is it connected and started. Then the guest's network is read back until it holds steady: the address on the
VM's own adapter (host: exactly its address, no gateway; internet: a DHCP address, a default route, DNS and one lookup
that answers). If any step fails, the VM is restored to clean and the start fails. Stop, release and recovery
disconnect the VM, then remove its rules. The clean checkpoint is always offline.

**Host mode and your firewall.** Setup makes the switch and this PC's address on it, and refuses a subnet that
overlaps anything else on this PC (a VPN, another network). A host-mode start checks the same again. Setup changes no
firewall rule: a VM can reach a service on this PC only if you let it. Setup prints the lines, for example for Ollama:
```
New-NetFirewallRule -DisplayName 'hyper-v MCP host mode: TCP 11434' -Direction Inbound -Protocol TCP -LocalPort 11434 -LocalAddress 10.137.42.1 -RemoteAddress 10.137.42.0/24 -Action Allow
```
and the service must listen beyond localhost (for Ollama, `OLLAMA_HOST` set to `10.137.42.1:11434` or `0.0.0.0:11434`).
Open a port only for a service you're happy for test code to call.

**Internet modes.** Test code in the VM can download things and talk to any internet service, as you could from this
PC. Use them for builds that need it, and still keep real sign-ins and tokens out of the VM.

Linux guests get their address from a fixed script of the helper's own, run as root through the same path as a run:
systemd-networkd, when it runs, is given a runtime network file for the VM's adapter; otherwise `ip` (host mode) or
the image's DHCP client (internet modes). Nothing of it survives a restore.
