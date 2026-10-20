/**
 * Under WSL, a Windows executable runs behind a Linux interop process. Signalling that process
 * does not stop the Windows one: after `kill`, deadlock.exe keeps running (and holding the port)
 * with nobody supervising it. These helpers find the game process on the Windows side by its
 * command line and stop it there.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** True when `command` is a Windows executable launched directly (no Wine wrapper) under WSL. */
export function runsOnWindowsSide(command: string): boolean {
  return isWsl() && /\.exe$/i.test(command);
}

/**
 * Stops deadlock.exe/deadworks.exe processes whose command line contains every marker.
 * Markers must be plain text without quotes (they come from our own launch arguments).
 * Resolves with the Windows PIDs it stopped; never throws.
 */
export async function stopWindowsProcesses(markers: string[], timeoutMs = 20_000): Promise<number[]> {
  if (markers.some((m) => /['"`$]/.test(m))) throw new Error('process markers must not contain quotes or $');
  const filter = markers.map((m) => `$_.CommandLine -like '*${m.replace(/\[/g, '`[').replace(/\]/g, '`]')}*'`).join(' -and ');
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='deadlock.exe' OR Name='deadworks.exe'\" | " +
    `Where-Object { ${filter} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }`;
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs });
    return stdout
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}
