import fs from 'node:fs/promises';
import path from 'node:path';
export function chromeCandidates(platform = process.platform, env = process.env) {
  if (env.LOCAL_CHROME_CONTROL_CHROME) return [env.LOCAL_CHROME_CONTROL_CHROME];
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  if (platform === 'win32') return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(root => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  throw new Error('BROWSER_PROBE_PLATFORM_NOT_SUPPORTED');
}
export async function chromeExecutable() {
  for (const candidate of chromeCandidates()) {
    if (!path.isAbsolute(candidate)) continue;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw new Error('Google Chrome executable not found. Set LOCAL_CHROME_CONTROL_CHROME to its absolute path.');
}
