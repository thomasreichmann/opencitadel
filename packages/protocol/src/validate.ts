/**
 * A tiny schema validator. Every network-facing payload in OpenCitadel goes through one of
 * these before it is trusted; validators also strip unknown keys, so stored objects only ever
 * contain fields we know about.
 */

export class ValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ValidationError';
  }
}

export type Validator<T> = (value: unknown, path: string) => T;
export type Infer<V> = V extends Validator<infer T> ? T : never;

const fail = (path: string, message: string): never => {
  throw new ValidationError(path, message);
};

export interface StringOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** Trim surrounding whitespace before checking length (default true). */
  trim?: boolean;
}

// Control characters other than tab/newline have no business in names shown in a UI.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const v = {
  string(opts: StringOpts = {}): Validator<string> {
    return (value, path) => {
      if (typeof value !== 'string') return fail(path, 'must be a string');
      const s = opts.trim === false ? value : value.trim();
      if (CONTROL_CHARS.test(s)) return fail(path, 'contains control characters');
      if (opts.min !== undefined && s.length < opts.min) return fail(path, `must be at least ${opts.min} characters`);
      if (opts.max !== undefined && s.length > opts.max) return fail(path, `must be at most ${opts.max} characters`);
      if (opts.pattern && !opts.pattern.test(s)) return fail(path, `has an invalid format`);
      return s;
    };
  },

  int(opts: { min?: number; max?: number } = {}): Validator<number> {
    return (value, path) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) return fail(path, 'must be an integer');
      if (opts.min !== undefined && value < opts.min) return fail(path, `must be >= ${opts.min}`);
      if (opts.max !== undefined && value > opts.max) return fail(path, `must be <= ${opts.max}`);
      return value;
    };
  },

  number(opts: { min?: number; max?: number } = {}): Validator<number> {
    return (value, path) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(path, 'must be a number');
      if (opts.min !== undefined && value < opts.min) return fail(path, `must be >= ${opts.min}`);
      if (opts.max !== undefined && value > opts.max) return fail(path, `must be <= ${opts.max}`);
      return value;
    };
  },

  bool(): Validator<boolean> {
    return (value, path) => (typeof value === 'boolean' ? value : fail(path, 'must be a boolean'));
  },

  literal<const T extends string>(values: readonly T[]): Validator<T> {
    return (value, path) =>
      typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fail(path, `must be one of: ${values.join(', ')}`);
  },

  array<T>(item: Validator<T>, opts: { max?: number; min?: number } = {}): Validator<T[]> {
    return (value, path) => {
      if (!Array.isArray(value)) return fail(path, 'must be an array');
      if (opts.max !== undefined && value.length > opts.max) return fail(path, `must have at most ${opts.max} items`);
      if (opts.min !== undefined && value.length < opts.min) return fail(path, `must have at least ${opts.min} items`);
      return value.map((x, i) => item(x, `${path}[${i}]`));
    };
  },

  record<T>(item: Validator<T>, opts: { maxKeys?: number; key?: Validator<string> } = {}): Validator<Record<string, T>> {
    return (value, path) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(path, 'must be an object');
      const entries = Object.entries(value);
      if (opts.maxKeys !== undefined && entries.length > opts.maxKeys) return fail(path, `must have at most ${opts.maxKeys} keys`);
      const out: Record<string, T> = Object.create(null);
      for (const [k, x] of entries) {
        const key = opts.key ? opts.key(k, `${path}.<key>`) : k;
        out[key] = item(x, `${path}.${k}`);
      }
      return out;
    };
  },

  object<S extends Record<string, Validator<unknown>>>(shape: S): Validator<{ [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]> } & { [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]> }> {
    return ((value: unknown, path: string) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(path, 'must be an object');
      const out: Record<string, unknown> = {};
      for (const [key, validator] of Object.entries(shape)) {
        const result = validator((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
        if (result !== undefined) out[key] = result;
      }
      return out;
    }) as never;
  },

  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path) => (value === undefined || value === null ? undefined : inner(value, path));
  },

  withDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
    return (value, path) => (value === undefined || value === null ? fallback : inner(value, path));
  },

  /** Accepts any JSON value (used for plugin config blobs, which plugins validate themselves). */
  json(opts: { maxBytes?: number } = {}): Validator<unknown> {
    return (value, path) => {
      const size = JSON.stringify(value ?? null).length;
      if (opts.maxBytes !== undefined && size > opts.maxBytes) return fail(path, `must be at most ${opts.maxBytes} bytes of JSON`);
      return value;
    };
  },
};

/** Validates and returns, or throws ValidationError. */
export function parse<T>(validator: Validator<T>, value: unknown): T {
  return validator(value, '');
}
