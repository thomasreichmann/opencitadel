/**
 * Side effects on the player's desktop: opening Steam URLs, the clipboard, and checking whether
 * Deadlock is running. Everything goes through the `Platform` interface so tests (and other
 * front ends) can substitute their own.
 */

import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform as osPlatform } from 'node:os';

export interface Platform {
  /** Hands a URL (steam://, http://) to the OS handler. */
  openUrl(url: string): Promise<void>;
  /** Resolves false when no clipboard tool is available. */
  copyToClipboard(text: string): Promise<boolean>;
  isGameRunning(): Promise<boolean>;
}

function isWsl(): boolean {
  if (osPlatform() !== 'linux') return false;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

/** Starts a detached process and resolves once it spawned (rejects if the binary is missing). */
function detach(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function pipeTo(cmd: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

/**
 * The real desktop. On Windows and WSL URLs go through `rundll32 url.dll,FileProtocolHandler`
 * rather than `cmd /c start`: cmd.exe would expand the `%2B`/`%20` escapes in steam:// URLs as
 * environment variables, and `&` would split the command.
 */
export function systemPlatform(): Platform {
  const os = osPlatform();
  const windowsLike = os === 'win32' || isWsl();

  return {
    async openUrl(url) {
      if (!/^(steam|https?):\/\/[^\s"]+$/.test(url)) throw new Error(`Refusing to open unexpected URL: ${url}`);
      if (windowsLike) {
        try {
          await detach('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
        } catch {
          await detach('explorer.exe', [url]);
        }
      } else if (os === 'darwin') {
        await detach('open', [url]);
      } else {
        await detach('xdg-open', [url]);
      }
    },

    async copyToClipboard(text) {
      if (windowsLike) return pipeTo('clip.exe', [], text);
      if (os === 'darwin') return pipeTo('pbcopy', [], text);
      if (process.env.WAYLAND_DISPLAY && (await pipeTo('wl-copy', [], text))) return true;
      if (await pipeTo('xclip', ['-selection', 'clipboard'], text)) return true;
      return pipeTo('xsel', ['--clipboard', '--input'], text);
    },

    async isGameRunning() {
      if (windowsLike) {
        const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq deadlock.exe', '/NH']);
        return /deadlock\.exe/i.test(stdout);
      }
      // Linux (Proton) and macOS: the Windows binary shows up in the process list by name.
      return (await run('pgrep', ['-f', 'deadlock.exe'])).code === 0;
    },
  };
}

/** A Platform that records calls instead of acting. Used by tests and `--print`. */
export class RecordingPlatform implements Platform {
  readonly opened: string[] = [];
  readonly copied: string[] = [];
  constructor(public running = false, public clipboard = true) {}
  async openUrl(url: string): Promise<void> {
    this.opened.push(url);
  }
  async copyToClipboard(text: string): Promise<boolean> {
    if (this.clipboard) this.copied.push(text);
    return this.clipboard;
  }
  async isGameRunning(): Promise<boolean> {
    return this.running;
  }
}
