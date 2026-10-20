/**
 * Chat command registry and parsing. Players type `!name args` or `/name args`; arguments are
 * split on whitespace with "double" or 'single' quotes grouping words.
 */

import type { CommandOptions, Disposable, Logger } from '@opencitadel/plugin-sdk';

export const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Names the runtime answers itself. */
export const RESERVED_COMMANDS = new Set(['help']);

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === '\\' && quote === '"' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        current += input[++i];
      } else if (c === quote) {
        quote = undefined;
      } else {
        current += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || current) out.push(current);
      current = '';
      has = false;
    } else {
      current += c;
    }
  }
  if (has || current) out.push(current);
  return out;
}

export interface ParsedCommand {
  name: string;
  raw: string;
  args: string[];
}

/** Parses `!name rest` / `/name rest`. Returns undefined for ordinary chat. */
export function parseCommand(text: string): ParsedCommand | undefined {
  const m = /^\s*[!/]([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return undefined;
  const raw = (m[2] ?? '').trim();
  return { name: m[1]!.toLowerCase(), raw, args: tokenize(raw) };
}

export interface RegisteredCommand {
  /** The name it was registered under (aliases point at the same entry). */
  name: string;
  pluginId: string;
  options: CommandOptions;
}

export class CommandRegistry {
  private readonly byName = new Map<string, RegisteredCommand>();

  register(pluginId: string, name: string, options: CommandOptions, log: Logger): Disposable {
    const primary = name.toLowerCase();
    if (!COMMAND_NAME.test(primary)) throw new Error(`Invalid command name "${name}" (use a-z, 0-9, - and _, max 32)`);
    if (typeof options?.handler !== 'function') throw new Error(`Command "${name}" needs a handler`);
    const entry: RegisteredCommand = { name: primary, pluginId, options };
    const claimed: string[] = [];
    for (const n of [primary, ...(options.aliases ?? []).map((a) => a.toLowerCase())]) {
      if (!COMMAND_NAME.test(n)) throw new Error(`Invalid command alias "${n}"`);
      if (RESERVED_COMMANDS.has(n)) {
        log.warn(`!${n} is built in; not registering it`);
        continue;
      }
      const existing = this.byName.get(n);
      if (existing) {
        log.warn(`!${n} is already registered by plugin "${existing.pluginId}"; skipping`);
        continue;
      }
      this.byName.set(n, entry);
      claimed.push(n);
    }
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const n of claimed) if (this.byName.get(n) === entry) this.byName.delete(n);
      },
    };
  }

  get(name: string): RegisteredCommand | undefined {
    return this.byName.get(name.toLowerCase());
  }

  removePlugin(pluginId: string): void {
    for (const [n, entry] of this.byName) if (entry.pluginId === pluginId) this.byName.delete(n);
  }

  /** Each registered command once, sorted by name. */
  list(): RegisteredCommand[] {
    return [...new Set(this.byName.values())].sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}
