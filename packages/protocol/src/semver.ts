/**
 * The subset of semver that plugin manifests need: `1.2.3[-pre]` versions and ranges made of
 * `*`, exact versions, comparators (`>=1.0.0 <2.0.0`), carets (`^1.2.0`) and tildes (`~1.2.0`),
 * joined with `||`.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== undefined;
}

export function compareVersions(a: Version | string, b: Version | string): number {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  // A pre-release sorts before its release.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length === 0 ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

type Comparator = { op: '>=' | '<=' | '>' | '<' | '='; version: Version };

function expand(token: string): Comparator[] | undefined {
  if (token === '*' || token === 'x' || token === '') return [];
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) return undefined;
  const op = m[1] ?? '=';
  // Allow partial versions in ranges: `^1`, `~1.2`, `>=2`.
  const parts = m[2]!.split('-')[0]!.split('.');
  const filled = [...parts, '0', '0'].slice(0, 3).map((p) => (p === 'x' || p === '*' ? '0' : p));
  const pre = m[2]!.includes('-') ? '-' + m[2]!.split('-').slice(1).join('-') : '';
  const version = parseVersion(filled.join('.') + pre);
  if (!version) return undefined;
  const { major, minor, patch } = version;
  const v = (a: number, b: number, c: number): Version => ({ major: a, minor: b, patch: c, pre: ['0'] });
  switch (op) {
    case '^':
      if (major > 0 || parts.length === 1) return [{ op: '>=', version }, { op: '<', version: v(major + 1, 0, 0) }];
      if (minor > 0 || parts.length === 2) return [{ op: '>=', version }, { op: '<', version: v(0, minor + 1, 0) }];
      return [{ op: '>=', version }, { op: '<', version: v(0, 0, patch + 1) }];
    case '~':
      if (parts.length === 1) return [{ op: '>=', version }, { op: '<', version: v(major + 1, 0, 0) }];
      return [{ op: '>=', version }, { op: '<', version: v(major, minor + 1, 0) }];
    case '=':
      if (parts.length < 3) return expand(`~${m[2]}`);
      return [{ op: '=', version }];
    default:
      return [{ op: op as Comparator['op'], version }];
  }
}

function parseRange(range: string): Comparator[][] | undefined {
  const sets: Comparator[][] = [];
  for (const alt of range.split('||')) {
    const set: Comparator[] = [];
    for (const token of alt.trim().split(/\s+/)) {
      const cs = expand(token);
      if (!cs) return undefined;
      set.push(...cs);
    }
    sets.push(set);
  }
  return sets;
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== undefined;
}

export function satisfies(version: string, range: string): boolean {
  const ver = parseVersion(version);
  const sets = parseRange(range);
  if (!ver || !sets) return false;
  return sets.some((set) =>
    set.every(({ op, version: target }) => {
      const c = compareVersions(ver, target);
      return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
    }),
  );
}

/** Highest version in `versions` that satisfies `range`, or undefined. */
export function maxSatisfying(versions: string[], range: string): string | undefined {
  return versions.filter((x) => satisfies(x, range)).sort(compareVersions).pop();
}
