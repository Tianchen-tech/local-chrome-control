import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export async function windowsLauncherSource(node, project) {
  if (!path.win32.isAbsolute(node) || !path.win32.isAbsolute(project)) throw new Error('INVALID_LAUNCHER_PATH');
  const template = (await fs.readFile(new URL('./windows-launcher.cs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  return template.replace('__NODE_PATH__', JSON.stringify(node)).replace('__HOST_PATH__', JSON.stringify(path.win32.join(project, 'server', 'native-host.mjs')));
}

export async function buildWindowsLauncher(filename, node, project) {
  const source = await windowsLauncherSource(node, project);
  const sourceFile = filename + '.cs';
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('UNSAFE_NATIVE_LAUNCHER');
    if (await fs.readFile(sourceFile, 'utf8') === source) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = filename + '.' + process.pid + '.tmp.exe';
  const temporarySource = sourceFile + '.' + process.pid + '.tmp.cs';
  await fs.writeFile(temporarySource, source, { flag: 'wx' });
  const compiler = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await new Promise((resolve, reject) => {
    execFile(compiler, ['/nologo', '/target:exe', '/codepage:65001', '/out:' + temporary, temporarySource], { windowsHide: true, timeout: 30000 }, error => {
      if (error) reject(new Error('WINDOWS_NATIVE_LAUNCHER_BUILD_FAILED')); else resolve();
    });
  });
  await fs.rename(temporary, filename);
  await fs.rename(temporarySource, sourceFile);
}
