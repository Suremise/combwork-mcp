/**
 * The unattended install's media: autounattend.xml for Windows Setup (found on the second DVD), for a Generation 2 VM
 * with Secure Boot and a vTPM. It partitions disk 0 for UEFI, installs the image index the approved plan bound (images.js
 * picks one edition per ISO), with the pool's product key for a non-evaluation image when the plan says so, creates a guest admin and a standard user with the helper's random passwords, skips OOBE, and keeps
 * Windows Update off (the VM has no network anyway). The media sits in the VM's own folder and is deleted once the
 * clean checkpoint is taken; guest-setup deletes Setup's copies inside the guest.
 */
const fs = require('fs')
const { join } = require('path')

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const NAME_RE = /^[A-Z][A-Z0-9-]{0,14}$/
const USER_RE = /^[a-z][a-z0-9]{2,19}$/
const KEY_RE = /^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$/

const component = (name, pass, body) =>
  `    <component name="${name}" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">\n${body}\n    </component>`

/** The answer file's text. */
function autounattend({ computerName, creds, timeZone = 'UTC', imageIndex = 1, productKey = null }) {
  if (!NAME_RE.test(computerName)) throw new Error('bad computer name')
  if (!Number.isInteger(imageIndex) || imageIndex < 1 || imageIndex > 64) throw new Error('bad image index')
  if (productKey !== null && !KEY_RE.test(productKey)) throw new Error('bad product key')
  for (const k of ['admin', 'user']) if (!USER_RE.test(creds[k].user) || !creds[k].password) throw new Error(`bad ${k} account`)
  const account = (a, group) => `          <LocalAccount wcm:action="add">
            <Name>${esc(a.user)}</Name>
            <Group>${group}</Group>
            <Password><Value>${esc(a.password)}</Value><PlainText>true</PlainText></Password>
          </LocalAccount>`
  const run = (n, cmd) => `        <RunSynchronousCommand wcm:action="add"><Order>${n}</Order><Path>${esc(cmd)}</Path></RunSynchronousCommand>`
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
${component('Microsoft-Windows-International-Core-WinPE', 'windowsPE', `      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
      <InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>`)}
${component('Microsoft-Windows-Setup', 'windowsPE', `      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>${imageIndex}</Value></MetaData></InstallFrom>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
        </OSImage>
      </ImageInstall>
      <UserData><AcceptEula>true</AcceptEula>${productKey ? `<ProductKey><Key>${esc(productKey)}</Key><WillShowUI>Never</WillShowUI></ProductKey>` : ''}</UserData>`)}
  </settings>
  <settings pass="specialize">
${component('Microsoft-Windows-Shell-Setup', 'specialize', `      <ComputerName>${esc(computerName)}</ComputerName>
      <TimeZone>${esc(timeZone)}</TimeZone>`)}
${component('Microsoft-Windows-Deployment', 'specialize', `      <RunSynchronous>
${run(1, 'reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU /v NoAutoUpdate /t REG_DWORD /d 1 /f')}
${run(2, 'reg add HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f')}
${run(3, 'powercfg /hibernate off')}
      </RunSynchronous>`)}
  </settings>
  <settings pass="oobeSystem">
${component('Microsoft-Windows-International-Core', 'oobeSystem', '      <InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>')}
${component('Microsoft-Windows-Shell-Setup', 'oobeSystem', `      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
${account(creds.admin, 'Administrators')}
${account(creds.user, 'Users')}
        </LocalAccounts>
      </UserAccounts>`)}
  </settings>
</unattend>
`
}

/** Writes the media folder: autounattend.xml, made into an ISO by hv.ps1 'make-iso'. */
function writeMedia(dir, opts) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'autounattend.xml'), autounattend(opts))
}

module.exports = { autounattend, writeMedia, KEY_RE }
