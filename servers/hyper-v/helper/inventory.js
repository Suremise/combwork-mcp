/**
 * MC-1557: the helper's recorded inventory, a plain-text file in its state folder (inventory.txt) rewritten on every
 * journalled change and at each start. It lists what the hyper-v MCP has put on this PC, each item with a manual step
 * to remove it, for a person to read and type if the uninstaller itself can't run. Nothing ever runs its text: the
 * uninstaller verifies every item live before it deletes anything (setup\uninstall.ps1, setup\teardown.ps1).
 *
 * render(facts) is pure. facts: { at (ISO time), version, stateDir, installDir, diskFolders: [path], vms: [{ vmName,
 * vmId, folder, os, image, checkpoints: [name] }], images: [file], hostSwitch: { name } | null, legacySwitch: { name,
 * switchId } | null }.
 */
const FILE = 'inventory.txt'
const ENTRY_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HyperVMcp'
const STATE_KEY = 'HKLM:\\SOFTWARE\\hyperv-mcp'
const GCS_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Virtualization\\GuestCommunicationServices\\00000016-facb-11e6-bd58-64006a7986d3'
const q = s => `'${String(s).replace(/'/g, "''")}'`

function render(f) {
  const out = []
  const item = (what, step) => { out.push(`- ${what}`); out.push(`    to remove by hand: ${step}`) }
  out.push('hyper-v MCP: the helper\'s recorded inventory')
  out.push(`As of ${f.at} (helper ${f.version || 'unknown'}). The uninstaller verifies each item live before it deletes`)
  out.push('anything, and never runs this text. The manual steps are for a person to read and type, in an admin')
  out.push('Windows PowerShell, only if the uninstaller can\'t run. Remove the VMs first, then the rest in the order listed.')
  out.push('')
  out.push('The usual way: Settings > Apps > Installed apps > "Hyper-V MCP helper and test VMs" > Uninstall, or in an admin')
  out.push(`PowerShell: powershell -NoProfile -ExecutionPolicy Bypass -File ${q(`${f.installDir}\\uninstall\\uninstall.ps1`)}`)
  out.push('')
  out.push(`VMs (${f.vms.length}):`)
  if (!f.vms.length) out.push('- none')
  for (const v of f.vms) {
    const cps = v.checkpoints.length ? `; checkpoints: ${v.checkpoints.join(', ')}` : ''
    item(`${v.vmName} (id ${v.vmId}; ${v.os}${v.image ? `, image ${v.image}` : ''}); folder ${v.folder}${cps}`,
      `Stop-VM -Id ${v.vmId} -TurnOff -Force; Remove-VM -Id ${v.vmId} -Force; Remove-Item -LiteralPath ${q(v.folder)} -Recurse -Force`)
  }
  out.push('')
  out.push(`Cached images (${f.images.length}):`)
  if (!f.images.length) out.push('- none')
  for (const i of f.images) item(i, `Remove-Item -LiteralPath ${q(i)} -Force (it goes with its disk folder too)`)
  out.push('')
  out.push('Networking:')
  if (f.hostSwitch) item(`setup's host-mode switch ${f.hostSwitch.name}, with this PC's address on it`, `Remove-VMSwitch -Name ${q(f.hostSwitch.name)} -Force`)
  if (f.legacySwitch) item(`an older pool's switch ${f.legacySwitch.name}${f.legacySwitch.switchId ? ` (id ${f.legacySwitch.switchId})` : ''}`, `Get-VMSwitch -Id ${f.legacySwitch.switchId || '<its id>'} | Remove-VMSwitch -Force`)
  if (!f.hostSwitch && !f.legacySwitch) out.push('- none')
  out.push('')
  out.push('Folders:')
  for (const d of f.diskFolders) item(`disk folder ${d} (the pool's VMs and images)`, `Remove-Item -LiteralPath ${q(d)} -Recurse -Force`)
  item(`state folder ${f.stateDir} (the helper's journal, policy, keys and this file)`, `Remove-Item -LiteralPath ${q(f.stateDir)} -Recurse -Force`)
  item(`install folder ${f.installDir} (the helper's code and its uninstaller)`, `Remove-Item -LiteralPath ${q(f.installDir)} -Recurse -Force`)
  out.push('')
  out.push('Windows settings:')
  item('the service HyperVMcp', 'Stop-Service HyperVMcp -Force; sc.exe delete HyperVMcp')
  item('NT SERVICE\\HyperVMcp in Hyper-V Administrators', "Remove-LocalGroupMember -SID 'S-1-5-32-578' -Member 'NT SERVICE\\HyperVMcp'")
  item('the local group "Hyper-V MCP Users"', "Remove-LocalGroup -Name 'Hyper-V MCP Users'")
  item(`the registry key ${STATE_KEY} (setup's storage records)`, `Remove-Item -LiteralPath ${q(STATE_KEY)} -Recurse`)
  item(`the Installed apps entry ${ENTRY_KEY}`, `Remove-Item -LiteralPath ${q(ENTRY_KEY)}`)
  item('the Linux guests\' vsock port registration (when setup made it)', `Remove-Item -LiteralPath ${q(GCS_KEY)}`)
  out.push('')
  out.push('Not part of the MCP, so not removed: anything set up beside it, such as Ollama\'s settings, or a firewall rule')
  out.push("you added for host mode (setup prints them named 'hyper-v MCP host mode: *'; Get-NetFirewallRule -DisplayName")
  out.push("'hyper-v MCP host mode: *' lists them). Undo those as you were told when they were made.")
  return out.join('\r\n') + '\r\n'
}

module.exports = { FILE, render }
