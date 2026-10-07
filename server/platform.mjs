import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export function runtimeDirectory(platform = process.platform, env = process.env, home = homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = env.LOCAL_CHROME_CONTROL_DIR || (platform === 'win32' ?
    paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'LocalChromeControl') :
    paths.join(home, 'Library', 'Application Support', 'LocalChromeControl'));
  if (!paths.isAbsolute(root) || (platform === 'win32' && !/^[a-z]:\\/i.test(root))) throw new Error('RUNTIME_DIRECTORY_MUST_BE_LOCAL_AND_ABSOLUTE');
  // Chrome launches .cmd hosts through cmd.exe before our own quoting runs.
  // Source paths are escaped inside the batch file; the manifest/launcher path
  // itself must avoid cmd expansion and control characters.
  if (platform === 'win32' && /[%!&^()<>|"\r\n\0]/.test(root)) throw new Error('WINDOWS_RUNTIME_PATH_CONTAINS_CMD_METACHARACTERS');
  return paths.normalize(root);
}
export function ipcEndpoint(root, sessionId, platform = process.platform) {
  if (!/^[a-f0-9]{12}$/.test(sessionId)) throw new Error('INVALID_SESSION_ID');
  if (platform === 'win32') {
    const scope = createHash('sha256').update(path.win32.normalize(root).toLowerCase()).digest('hex').slice(0, 24);
    return '\\\\.\\pipe\\LocalChromeControl-' + scope + '-' + sessionId;
  }
  const endpoint = path.join(root, sessionId + '.sock');
  if (Buffer.byteLength(endpoint) > 100) throw new Error('UNIX_SOCKET_PATH_TOO_LONG');
  return endpoint;
}
export function installPlan({ platform = process.platform, home = homedir(), env = process.env, root, project, node, host, origin }) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('INSTALL_PLATFORM_NOT_SUPPORTED');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  root ||= runtimeDirectory(platform, env, home);
  const directory = platform === 'win32' ? paths.join(root, 'NativeMessagingHosts') : paths.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  const launcher = paths.join(root, platform === 'win32' ? 'native-host.cmd' : 'native-host.sh');
  const manifestPath = paths.join(directory, host + '.json');
  return { platform, directory, manifestPath, launcherPath: launcher,
    registryKey: platform === 'win32' ? 'Software\\Google\\Chrome\\NativeMessagingHosts\\' + host : null,
    manifest: { name: host, description: 'Local Chrome Control local-only bridge', path: launcher, type: 'stdio', allowed_origins: [origin] },
    mcp: { command: node, args: [paths.join(project, 'server', 'mcp.mjs')] } };
}
export function launcherText(plan, node, project) {
  if (plan.platform === 'win32') {
    const quote = value => {
      if (/["\r\n\0]/.test(value)) throw new Error('INVALID_LAUNCHER_PATH');
      return '"' + value.replaceAll('%', '%%') + '"';
    };
    return '@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\nif errorlevel 1 exit /b 1\r\n' +
      quote(node) + ' ' + quote(path.win32.join(project, 'server', 'native-host.mjs')) + ' %*\r\nexit /b %errorlevel%\r\n';
  }
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return '#!/bin/sh\nexec ' + quote(node) + ' ' + quote(path.join(project, 'server', 'native-host.mjs')) + ' "$@"\n';
}
export function ownsManifest(existing, expected) {
  return existing?.name === expected.name && existing.type === 'stdio' && sameInstallationPath(existing.path, expected.path) &&
    JSON.stringify(existing.allowed_origins) === JSON.stringify(expected.allowed_origins);
}
export function sameInstallationPath(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  if (/^[a-z]:\\/i.test(expected)) return path.win32.normalize(actual).toLowerCase() === path.win32.normalize(expected).toLowerCase();
  return actual === expected;
}
