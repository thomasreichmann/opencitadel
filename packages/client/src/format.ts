/** Plain-text rendering for the terminal: aligned tables, optional ANSI emphasis. */

import { pickConnectTarget, type ServerDetail, type ServerSummary } from '@opencitadel/protocol';

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
}

const plain: Style = { bold: (s) => s, dim: (s) => s, green: (s) => s, yellow: (s) => s, red: (s) => s };

/** ANSI styling when writing to a terminal, unless NO_COLOR is set (https://no-color.org). */
export function makeStyle(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): Style {
  if (!stream.isTTY || env.NO_COLOR || env.TERM === 'dumb') return plain;
  const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), yellow: wrap(33, 39), red: wrap(31, 39) };
}

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string) => [...s.replace(ANSI, '')].length;

/** Truncates to `max` visible characters with an ellipsis. Expects unstyled input. */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** Renders rows under a header, padding every column to its widest cell. */
export function table(headers: string[], rows: string[][], align: Array<'l' | 'r'> = [], style: Style = plain): string {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))));
  const pad = (cell: string, i: number) => {
    const gap = ' '.repeat(widths[i]! - visibleLength(cell));
    return align[i] === 'r' ? gap + cell : cell + gap;
  };
  const line = (cells: string[]) => cells.map(pad).join('  ').replace(/\s+$/, '');
  return [style.dim(line(headers)), ...rows.map(line)].join('\n');
}

function players(s: ServerSummary): string {
  return `${s.players}/${s.maxPlayers}`;
}

function flags(s: ServerSummary): string {
  return [s.passworded ? 'locked' : '', s.requiresContent ? 'content' : s.modded ? 'modded' : '', s.verified ? 'verified' : ''].filter(Boolean).join(',');
}

export function formatPing(ms: number | null | undefined): string {
  return ms === undefined ? '' : ms === null ? '—' : `${ms}ms`;
}

export function formatServerList(servers: ServerSummary[], opts: { pings?: Record<string, number | null>; favorites?: string[]; style?: Style } = {}): string {
  const style = opts.style ?? plain;
  if (!servers.length) return 'No servers match.';
  const withPing = !!opts.pings;
  const headers = ['ID', 'NAME', 'MAP', 'PLAYERS', 'REGION', ...(withPing ? ['PING'] : []), 'FLAGS'];
  const rows = servers.map((s) => {
    const fav = opts.favorites?.includes(s.id) ? '★ ' : '';
    const full = s.maxPlayers > 0 && s.players >= s.maxPlayers;
    return [
      s.id,
      fav + truncate(s.name, 40),
      truncate(s.map, 20),
      full ? style.yellow(players(s)) : players(s),
      s.region ?? '',
      ...(withPing ? [formatPing(opts.pings![s.id])] : []),
      flags(s),
    ];
  });
  return table(headers, rows, ['l', 'l', 'l', 'r', 'l', ...(withPing ? ['r' as const] : []), 'l'], style);
}

export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
}

export function formatServerDetail(s: ServerDetail, style: Style = plain): string {
  const out: string[] = [];
  const target = pickConnectTarget(s.connect, s.verified);
  out.push(style.bold(s.name) + (s.online ? '' : ' ' + style.red('(offline)')));
  if (s.description) out.push(s.description);
  out.push('');
  const facts: Array<[string, string | undefined]> = [
    ['ID', s.id],
    ['Map', s.map + (s.gameMode ? ` (${s.gameMode})` : '')],
    ['Players', `${players(s)}${s.bots ? ` (+${s.bots} bots)` : ''}`],
    ['Region', [s.region, s.country].filter(Boolean).join(' / ') || undefined],
    ['Password', s.passworded ? 'yes' : 'no'],
    ['Verified', s.verified ? 'yes (master reached it at its address)' : 'no'],
    ['Connect', target ? target.value : 'unavailable'],
    ['Tags', s.tags.join(', ') || undefined],
    ['Software', s.software ? `${s.software.name} ${s.software.version}` : undefined],
    ['Owner', s.owner?.name],
    ['Website', s.links.website],
    ['Discord', s.links.discord],
    ['Last seen', s.lastHeartbeat],
  ];
  const width = Math.max(...facts.map(([k]) => k.length));
  for (const [k, value] of facts) if (value) out.push(`${style.dim(k.padEnd(width))}  ${value}`);
  for (const [k, value] of Object.entries(s.metadata)) out.push(`${style.dim(k.padEnd(width))}  ${value}`);

  if (s.playerList.length) {
    out.push('', style.bold('Players'));
    out.push(
      table(
        ['NAME', 'HERO', 'TEAM', 'K/D/A'],
        s.playerList.map((p) => [truncate(p.name, 32), p.hero ?? '', p.team === undefined ? '' : String(p.team), p.kills === undefined ? '' : `${p.kills}/${p.deaths ?? 0}/${p.assists ?? 0}`]),
        ['l', 'l', 'r', 'r'],
        style,
      ),
    );
  }
  if (s.plugins.length) {
    out.push('', style.bold('Plugins'));
    out.push(table(['ID', 'VERSION', 'KIND'], s.plugins.map((p) => [p.name ? `${p.id} (${p.name})` : p.id, p.version, p.kind]), [], style));
  }
  if (s.content.length) {
    out.push('', style.bold('Required content') + style.dim(' (downloaded and verified when you join)'));
    out.push(table(['NAME', 'KIND', 'SIZE'], s.content.map((c) => [c.name, c.kind, formatSize(c.size)]), ['l', 'l', 'r'], style));
  }
  return out.join('\n');
}
