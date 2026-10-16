import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let cachedUserSid = null;

function systemToolPath(name) {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  return systemRoot ? join(systemRoot, 'System32', name) : null;
}

function currentUserSid(output) {
  // whoami /user /fo csv /nh returns one quoted name,SID record. Read the
  // identity field, not a SID-shaped display name or an assumed authority.
  return (
    String(output)
      .trim()
      .match(/^"(?:[^"]|"")*","(S-\d+(?:-\d+)+)"$/)?.[1] || null
  );
}

function unresolvedUserError() {
  const error = new Error('cannot resolve current Windows user for owner-only ACL enforcement');
  error.code = 'EACLNOUSER';
  return error;
}

function resolveCurrentUserPrincipal() {
  const whoami = systemToolPath('whoami.exe');
  if (whoami && existsSync(whoami)) {
    try {
      const output = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const sid = currentUserSid(output);
      if (sid) return sid;
    } catch {}
  }
  throw unresolvedUserError();
}

async function resolveCurrentUserPrincipalAsync() {
  const whoami = systemToolPath('whoami.exe');
  if (whoami && existsSync(whoami)) {
    try {
      const { stdout } = await execFileAsync(whoami, ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const sid = currentUserSid(stdout);
      if (sid) return sid;
    } catch {}
  }
  throw unresolvedUserError();
}

function icaclsPath() {
  const path = systemToolPath('icacls.exe');
  if (!path) {
    const error = new Error('SystemRoot not set; cannot locate icacls.exe for owner-only ACL enforcement');
    error.code = 'EACLNOROOT';
    throw error;
  }
  if (!existsSync(path)) {
    const error = new Error(`icacls.exe not found at ${path}; refusing to leave secret world-readable`);
    error.code = 'EACLNOICACLS';
    throw error;
  }
  return path;
}

const quoteForPowerShell = (value) => `'${String(value).replaceAll("'", "''")}'`;

function powerShellCommand(icacls, script) {
  return {
    executable: join(dirname(icacls), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    label: 'Windows ACL update',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

function ownerOnlyAclCommand(targetPath, sid, fresh, icacls) {
  if (fresh) {
    return {
      executable: icacls,
      label: 'icacls',
      args: [targetPath, '/inheritance:r', '/grant:r', `*${sid}:(F)`],
    };
  }
  // Never /reset a published secret: that temporarily restores broad parent
  // grants, and a later failure leaves them in place. Build the protected DACL
  // in memory and publish it in one native ACL update instead.
  const quote = quoteForPowerShell;
  const script = [
    "$ErrorActionPreference = 'Stop';",
    `$path = ${quote(targetPath)};`,
    `$sid = [System.Security.Principal.SecurityIdentifier]::new(${quote(sid)});`,
    '$directory = [System.IO.Directory]::Exists($path);',
    '$acl = if ($directory) { [System.Security.AccessControl.DirectorySecurity]::new() }',
    'else { [System.Security.AccessControl.FileSecurity]::new() };',
    '$acl.SetAccessRuleProtection($true, $false);',
    '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(',
    '$sid, [System.Security.AccessControl.FileSystemRights]::FullControl,',
    '[System.Security.AccessControl.AccessControlType]::Allow);',
    '$acl.AddAccessRule($rule);',
    'if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl) }',
    'else { [System.IO.File]::SetAccessControl($path, $acl) };',
  ].join(' ');
  return powerShellCommand(icacls, script);
}

// Replaces a directory's whole DACL (explicit grants to anyone else included)
// with one protected, inheritable owner-only grant, in one native update, so
// files created inside need no ACL call of their own. Files already inside
// that carry an explicit grant or any other principal's grant are reset to
// inherit only that owner grant.
function ownerOnlyDirectoryCommand(targetPath, sid, icacls) {
  const script = [
    "$ErrorActionPreference = 'Stop';",
    `$path = ${quoteForPowerShell(targetPath)};`,
    `$sid = [System.Security.Principal.SecurityIdentifier]::new(${quoteForPowerShell(sid)});`,
    '$acl = [System.Security.AccessControl.DirectorySecurity]::new();',
    '$acl.SetAccessRuleProtection($true, $false);',
    '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(',
    '$sid, [System.Security.AccessControl.FileSystemRights]::FullControl,',
    "[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',",
    '[System.Security.AccessControl.PropagationFlags]::None,',
    '[System.Security.AccessControl.AccessControlType]::Allow));',
    '[System.IO.Directory]::SetAccessControl($path, $acl);',
    'foreach ($file in [System.IO.Directory]::GetFiles($path)) {',
    '$current = [System.IO.File]::GetAccessControl($file);',
    '$rules = @($current.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]));',
    '$foreign = @($rules | Where-Object { -not $_.IsInherited -or $_.IdentityReference -ne $sid });',
    'if ($current.AreAccessRulesProtected -or $foreign.Count -gt 0) {',
    '$reset = [System.Security.AccessControl.FileSecurity]::new();',
    '$reset.SetAccessRuleProtection($false, $false);',
    '[System.IO.File]::SetAccessControl($file, $reset) } };',
  ].join(' ');
  return powerShellCommand(icacls, script);
}

function aclFailure(targetPath, cause, label = 'icacls') {
  const error = new Error(`${label} failed to apply owner-only ACL to ${targetPath}: ${cause?.message || cause}`);
  error.code = 'EACLFAIL';
  error.cause = cause;
  return error;
}

// Never resolve security-sensitive executables through PATH or fall back to an
// account name. Successful writes require a proven SID and successful ACL calls.
export function enforceOwnerOnlyAclWin32(targetPath, { fresh = false } = {}) {
  if (process.platform !== 'win32') return;
  const icacls = icaclsPath();
  if (cachedUserSid === null) cachedUserSid = resolveCurrentUserPrincipal();
  const command = ownerOnlyAclCommand(targetPath, cachedUserSid, fresh, icacls);
  try {
    execFileSync(command.executable, command.args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    });
  } catch (error) {
    throw aclFailure(targetPath, error, command.label);
  }
}

export async function enforceOwnerOnlyAclWin32Async(targetPath, { fresh = false } = {}) {
  if (process.platform !== 'win32') return;
  const icacls = icaclsPath();
  if (cachedUserSid === null) cachedUserSid = await resolveCurrentUserPrincipalAsync();
  const command = ownerOnlyAclCommand(targetPath, cachedUserSid, fresh, icacls);
  try {
    await execFileAsync(command.executable, command.args, { windowsHide: true, timeout: 15_000 });
  } catch (error) {
    throw aclFailure(targetPath, error, command.label);
  }
}

export async function enforceOwnerOnlyDirectoryWin32Async(targetPath) {
  if (process.platform !== 'win32') return;
  const icacls = icaclsPath();
  if (cachedUserSid === null) cachedUserSid = await resolveCurrentUserPrincipalAsync();
  const command = ownerOnlyDirectoryCommand(targetPath, cachedUserSid, icacls);
  try {
    await execFileAsync(command.executable, command.args, { windowsHide: true, timeout: 15_000 });
  } catch (error) {
    throw aclFailure(targetPath, error, command.label);
  }
}
