import path from 'node:path';
import { execFile } from 'node:child_process';
const run = (executable, args, options, input) => new Promise((resolve, reject) => {
  const child = execFile(executable, args, options, (error, stdout) => error ? reject(error) : resolve({ stdout }));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

// Values travel as base64 JSON, never as interpolated PowerShell source or cmd text.
export async function powershellJson(source, value, execute = run) {
  const data = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; " +
    "$data=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json); " + source;
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }, data);
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  } catch { throw new Error('WINDOWS_SECURITY_CHECK_FAILED'); }
}
const aclHelpers = `
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
function Test-Private($item, $isDirectory) {
  $info=Get-Item -LiteralPath $item -Force;
  if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false };
  $acl=Get-Acl -LiteralPath $item;
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { return $false };
  if ($isDirectory -and !$acl.AreAccessRulesProtected) { return $false };
  $userFull=$false;
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
      if ($rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18')) { return $false };
      if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $userFull=$true };
    }
  };
  return $userFull;
};`;
export async function secureWindowsDirectory(directory, execute) {
  return powershellJson(aclHelpers + `
$info=Get-Item -LiteralPath $data.directory -Force;
if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or !$info.PSIsContainer) { throw 'unsafe directory' };
$old=Get-Acl -LiteralPath $data.directory;
if ($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
  $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent());
  if ($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or !$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'wrong owner' };
};
$acl=[Security.AccessControl.DirectorySecurity]::new();
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
foreach ($owner in @($sid.Value,'S-1-5-18')) {
  $identity=[Security.Principal.SecurityIdentifier]::new($owner);
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
  $acl.AddAccessRule($rule);
};
Set-Acl -LiteralPath $data.directory -AclObject $acl;
if (!(Test-Private $data.directory $true)) { throw 'unsafe ACL' };
@{secured=$true} | ConvertTo-Json -Compress;`, { directory }, execute);
}
export async function secureWindowsFile(filename) {
  return powershellJson(aclHelpers + `
$info=Get-Item -LiteralPath $data.filename -Force;
if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe file' };
$acl=[Security.AccessControl.FileSecurity]::new();
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
foreach ($owner in @($sid.Value,'S-1-5-18')) {
  $identity=[Security.Principal.SecurityIdentifier]::new($owner);
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'));
};
Set-Acl -LiteralPath $data.filename -AclObject $acl;
if (!(Test-Private $data.filename $false)) { throw 'unsafe ACL' };
@{secured=$true} | ConvertTo-Json -Compress;`, { filename });
}
export async function privateWindowsPaths(directory, files = []) {
  const result = await powershellJson(aclHelpers + `
$rootSafe=Test-Private $data.directory $true;
$safeFiles=@();
if ($rootSafe) { foreach ($file in $data.files) { try { if (Test-Private $file $false) { $safeFiles+= $file } } catch {} } };
@{directory=$rootSafe; files=@($safeFiles)} | ConvertTo-Json -Compress;`, { directory, files });
  return result;
}
// Registry access uses .NET and explicit views, avoiding localized reg.exe output.
export async function registryEntries(key) {
  return powershellJson(`
$values=@();
foreach ($view in @('Registry32','Registry64')) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]$view);
  try { $entry=$base.OpenSubKey($data.key); if ($null -ne $entry) { try { $values+=@{view=$view; path=$entry.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} } finally { $entry.Dispose() } } } finally { $base.Dispose() };
};
@{entries=@($values)} | ConvertTo-Json -Compress;`, { key });
}
export async function updateRegistry(key, manifest, remove = false) {
  return powershellJson(`
foreach ($view in @('Registry32','Registry64')) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]$view);
  try {
    $entry=$base.OpenSubKey($data.key); $exists=$null -ne $entry;
    try { if ($exists -and $entry.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ne $data.manifest) { throw 'unrelated host' } } finally { if ($exists) { $entry.Dispose() } };
  } finally { $base.Dispose() };
};
foreach ($view in @('Registry32','Registry64')) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]$view);
  try {
    $entry=$base.OpenSubKey($data.key); $exists=$null -ne $entry;
    try { if ($exists -and $entry.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ne $data.manifest) { throw 'unrelated host' } } finally { if ($exists) { $entry.Dispose() } };
    if ($data.remove) { if ($exists) { $base.DeleteSubKey($data.key,$false) } }
    else { $entry=$base.CreateSubKey($data.key); try { $entry.SetValue('',$data.manifest,[Microsoft.Win32.RegistryValueKind]::String) } finally { $entry.Dispose() } };
  } finally { $base.Dispose() };
};
@{updated=$true} | ConvertTo-Json -Compress;`, { key, manifest, remove });
}
