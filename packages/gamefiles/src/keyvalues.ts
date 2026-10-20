/**
 * A position-preserving reader/editor for Valve KeyValues (KV1) text, the format of
 * gameinfo.gi. Edits are applied as text splices on the original source so comments,
 * spacing and line endings the game ships with survive untouched.
 */

export interface KvNode {
  key: string;
  keyStart: number;
  keyEnd: number;
  /** Set for leaf entries (`key value`). */
  value?: string;
  valueStart?: number;
  valueEnd?: number;
  /** Set for blocks (`key { ... }`). */
  children?: KvNode[];
  openBrace?: number;
  closeBrace?: number;
}

interface Token {
  kind: 'string' | 'open' | 'close';
  text: string;
  start: number;
  end: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '{' || c === '}') {
      tokens.push({ kind: c === '{' ? 'open' : 'close', text: c, start: i, end: i + 1 });
      i++;
    } else if (c === '"') {
      const start = i++;
      let text = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1]!;
          text += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else {
          text += src[i++];
        }
      }
      i++; // closing quote
      tokens.push({ kind: 'string', text, start, end: i });
    } else {
      const start = i;
      while (i < src.length && !/[\s{}"]/.test(src[i]!) && !(src[i] === '/' && src[i + 1] === '/')) i++;
      tokens.push({ kind: 'string', text: src.slice(start, i), start, end: i });
    }
  }
  return tokens;
}

/** Parses KV1 text into a node tree. Conditionals like `[$WIN64]` are skipped. */
export function parseKeyValues(src: string): KvNode[] {
  const tokens = tokenize(src);
  let pos = 0;

  const isConditional = (t: Token | undefined) => t?.kind === 'string' && t.text.startsWith('[') && t.text.endsWith(']');

  function parseBlock(depth: number): KvNode[] {
    const nodes: KvNode[] = [];
    while (pos < tokens.length) {
      const t = tokens[pos]!;
      if (t.kind === 'close') {
        if (depth === 0) throw new Error(`Unexpected '}' at offset ${t.start}`);
        return nodes;
      }
      if (t.kind === 'open') throw new Error(`Unexpected '{' at offset ${t.start}`);
      pos++;
      if (isConditional(tokens[pos])) pos++;
      const next = tokens[pos];
      if (!next) throw new Error(`Key "${t.text}" has no value`);
      if (next.kind === 'open') {
        pos++;
        const children = parseBlock(depth + 1);
        const close = tokens[pos];
        if (!close || close.kind !== 'close') throw new Error(`Block "${t.text}" is not closed`);
        pos++;
        nodes.push({ key: t.text, keyStart: t.start, keyEnd: t.end, children, openBrace: next.start, closeBrace: close.start });
      } else if (next.kind === 'string') {
        pos++;
        if (isConditional(tokens[pos])) pos++;
        nodes.push({ key: t.text, keyStart: t.start, keyEnd: t.end, value: next.text, valueStart: next.start, valueEnd: next.end });
      } else {
        throw new Error(`Key "${t.text}" is followed by '}' at offset ${next.start}`);
      }
    }
    if (depth > 0) throw new Error('Unexpected end of input inside a block');
    return nodes;
  }

  return parseBlock(0);
}

/** Finds a block by a case-insensitive key path, e.g. `['GameInfo', 'FileSystem', 'SearchPaths']`. */
export function findBlock(nodes: KvNode[], path: string[]): KvNode | undefined {
  let current: KvNode | undefined;
  let level = nodes;
  for (const key of path) {
    current = level.find((n) => n.children && n.key.toLowerCase() === key.toLowerCase());
    if (!current) return undefined;
    level = current.children!;
  }
  return current;
}

export function findEntry(block: KvNode, key: string): KvNode | undefined {
  return block.children?.find((n) => n.key.toLowerCase() === key.toLowerCase());
}

interface Splice {
  at: number;
  remove: number;
  insert: string;
}

/**
 * Accumulates edits against one source string and applies them in a single pass.
 * All offsets refer to the original text, so several edits can be planned from one parse.
 */
export class KvEditor {
  private readonly splices: Splice[] = [];
  readonly eol: string;

  constructor(readonly source: string) {
    this.eol = source.includes('\r\n') ? '\r\n' : '\n';
  }

  /** The whitespace that precedes the first non-blank character on the line containing `offset`. */
  indentAt(offset: number): string {
    const lineStart = this.source.lastIndexOf('\n', offset - 1) + 1;
    const m = /^[ \t]*/.exec(this.source.slice(lineStart));
    return m ? m[0] : '';
  }

  private lineEnd(offset: number): number {
    const nl = this.source.indexOf('\n', offset);
    if (nl === -1) return this.source.length;
    return this.source[nl - 1] === '\r' ? nl - 1 : nl;
  }

  private lineStart(offset: number): number {
    return this.source.lastIndexOf('\n', offset - 1) + 1;
  }

  /** Indentation used for children of `block`, inferred from its first child or its brace. */
  childIndent(block: KvNode): string {
    const first = block.children?.[0];
    if (first) return this.indentAt(first.keyStart);
    return this.indentAt(block.openBrace!) + '\t';
  }

  /** Inserts whole lines directly after the line holding the block's opening brace. */
  insertLinesAtTop(block: KvNode, lines: string[]): void {
    const at = this.lineEnd(block.openBrace!);
    const indent = this.childIndent(block);
    this.splices.push({ at, remove: 0, insert: lines.map((l) => this.eol + indent + l).join('') });
  }

  /** Inserts whole lines directly before the line holding `node`. */
  insertLinesBefore(node: KvNode, lines: string[]): void {
    const at = this.lineStart(node.keyStart);
    const indent = this.indentAt(node.keyStart);
    this.splices.push({ at, remove: 0, insert: lines.map((l) => indent + l + this.eol).join('') });
  }

  /** Replaces a leaf's value token, keeping it quoted if it was quoted. */
  replaceValue(node: KvNode, value: string, trailingComment?: string): void {
    const quoted = this.source[node.valueStart!] === '"';
    const text = quoted ? `"${value}"` : value;
    this.splices.push({ at: node.valueStart!, remove: node.valueEnd! - node.valueStart!, insert: text });
    if (trailingComment) {
      this.splices.push({ at: this.lineEnd(node.valueEnd!), remove: 0, insert: `\t// ${trailingComment}` });
    }
  }

  /** Raw splice against the original source. */
  replaceRange(at: number, remove: number, insert: string): void {
    this.splices.push({ at, remove, insert });
  }

  /** Removes every full line containing `marker` (used to undo our own tagged insertions). */
  removeLinesContaining(marker: string): void {
    let idx = this.source.indexOf(marker);
    while (idx !== -1) {
      const start = this.lineStart(idx);
      let end = this.source.indexOf('\n', idx);
      end = end === -1 ? this.source.length : end + 1;
      this.splices.push({ at: start, remove: end - start, insert: '' });
      idx = this.source.indexOf(marker, end);
    }
  }

  get changed(): boolean {
    return this.splices.length > 0;
  }

  apply(): string {
    const sorted = [...this.splices].sort((a, b) => b.at - a.at);
    let out = this.source;
    for (const s of sorted) out = out.slice(0, s.at) + s.insert + out.slice(s.at + s.remove);
    return out;
  }
}

/** Quotes a KV token if it needs quoting. */
export function kvQuote(text: string): string {
  return /^[A-Za-z0-9_.\-/*]+$/.test(text) ? text : `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
