/**
 * Guest-side half of the plugin sandbox: plain ES2020 that runs inside each plugin's QuickJS
 * context before the plugin itself. It builds the PluginContext the plugin sees and talks to
 * the host through one function, `__ocHost(op, argsJson)`. That function returns a JSON
 * envelope (`{"ok":…}` or `{"err":{name,message}}`), or a promise of one for async ops. The host
 * calls back in through `__ocGuest.*`. Everything that crosses the boundary is a JSON string.
 */

export const SDK_MODULE = '@opencitadel/plugin-sdk';

/** Source of the virtual `@opencitadel/plugin-sdk` module inside the sandbox. */
export const SDK_MODULE_SOURCE = [
  'const sdk = globalThis.__ocSdk;',
  'export const definePlugin = sdk.definePlugin;',
  'export const PermissionError = sdk.PermissionError;',
  'export const PLUGIN_BRAND = sdk.PLUGIN_BRAND;',
  'export default sdk;',
].join('\n');

export const PRELUDE = String.raw`
(function () {
  'use strict';
  var host = globalThis.__ocHost;
  delete globalThis.__ocHost;

  class PermissionError extends Error {
    constructor(message, plugin, permission) {
      super(message);
      this.name = 'PermissionError';
      this.plugin = plugin;
      this.permission = permission;
    }
  }
  var BRAND = Symbol.for('opencitadel.plugin');
  function definePlugin(def) {
    def[BRAND] = true;
    return def;
  }
  globalThis.__ocSdk = Object.freeze({ definePlugin: definePlugin, PermissionError: PermissionError, PLUGIN_BRAND: BRAND });

  function decode(json) {
    var env = JSON.parse(json);
    if (env.err) {
      var e = env.err.name === 'PermissionError'
        ? new PermissionError(env.err.message, env.err.plugin, env.err.permission)
        : new Error(env.err.message);
      if (env.err.name && env.err.name !== 'PermissionError') e.name = env.err.name;
      throw e;
    }
    return env.ok;
  }
  function encode(args) {
    return JSON.stringify(args === undefined ? null : args);
  }
  function call(op, args) {
    return decode(host(op, encode(args)));
  }
  // A synchronous host answer (e.g. a PermissionError) throws right away, exactly as the
  // unsandboxed context does; a real async answer arrives as a promise.
  function callAsync(op, args) {
    var r = host(op, encode(args));
    return typeof r === 'string' ? Promise.resolve(decode(r)) : r.then(decode);
  }
  function show(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || String(value);
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
  function logger(level) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(show(arguments[i]));
      call('log', { level: level, message: parts.join(' ') });
    };
  }
  function disposable(fn) {
    var done = false;
    return { dispose: function () { if (!done) { done = true; fn(); } } };
  }

  var nextId = 1;
  var handlers = new Map();
  var timers = new Map();
  var commands = new Map();
  var exposed = null;
  var cleanup = null;

  function addTimer(fn, ms, repeat) {
    if (typeof fn !== 'function') throw new TypeError('timer callback must be a function');
    var id = nextId++;
    timers.set(id, { fn: fn, repeat: repeat });
    call(repeat ? 'setInterval' : 'setTimeout', { id: id, ms: Math.max(0, Number(ms) || 0) });
    return id;
  }
  function clearTimer(id) {
    if (timers.delete(id)) call('clearTimer', { id: id });
  }
  var log = { debug: logger('debug'), info: logger('info'), warn: logger('warn'), error: logger('error') };
  globalThis.console = { log: log.info, info: log.info, warn: log.warn, error: log.error, debug: log.debug };
  globalThis.setTimeout = function (fn, ms) { return addTimer(fn, ms, false); };
  globalThis.setInterval = function (fn, ms) { return addTimer(fn, ms, true); };
  globalThis.clearTimeout = clearTimer;
  globalThis.clearInterval = clearTimer;
  globalThis.queueMicrotask = function (fn) { Promise.resolve().then(fn); };

  function plainHeaders(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { out[String(k)] = String(v); });
    else if (Array.isArray(h)) h.forEach(function (pair) { out[String(pair[0])] = String(pair[1]); });
    else Object.keys(h).forEach(function (k) { out[k] = String(h[k]); });
    return out;
  }
  function makeResponse(r) {
    var headers = r.headers || {};
    var get = function (name) {
      var v = headers[String(name).toLowerCase()];
      return v === undefined ? null : v;
    };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.statusText,
      url: r.url,
      redirected: !!r.redirected,
      headers: {
        get: get,
        has: function (name) { return get(name) !== null; },
        forEach: function (fn) { Object.keys(headers).forEach(function (k) { fn(headers[k], k); }); },
      },
      text: function () { return Promise.resolve(r.body); },
      json: function () { return Promise.resolve().then(function () { return JSON.parse(r.body); }); },
    };
  }

  function remote(id, methods) {
    var api = {};
    methods.forEach(function (m) {
      api[m] = function () {
        return callAsync('invoke', { id: id, method: m, args: Array.prototype.slice.call(arguments) });
      };
    });
    return Object.freeze(api);
  }

  function makeContext(info) {
    return Object.freeze({
      id: info.id,
      version: info.version,
      config: Object.freeze(info.config),
      dataDir: info.dataDir,
      log: Object.freeze(log),
      server: Object.freeze({
        get state() { return call('state'); },
        command: function (command) { return callAsync('command', { command: String(command) }); },
        say: function (message) { return callAsync('say', { message: String(message) }); },
        tell: function (player, message) { return callAsync('tell', { player: player, message: String(message) }); },
        kick: function (player, reason) { return callAsync('kick', { player: player, reason: reason }); },
        changeMap: function (map) { return callAsync('changeMap', { map: String(map) }); },
        findPlayer: function (query) { return call('findPlayer', { query: String(query) }) || undefined; },
      }),
      commands: Object.freeze({
        register: function (name, options) {
          if (!options || typeof options.handler !== 'function') throw new TypeError('register() needs options with a handler function');
          var id = nextId++;
          commands.set(id, options.handler);
          var sub = call('register', { id: id, name: String(name), description: options.description, access: options.access, aliases: options.aliases });
          return disposable(function () { commands.delete(id); call('dispose', { sub: sub }); });
        },
      }),
      listing: Object.freeze({
        setTags: function (tags) { call('setTags', { tags: tags }); },
        setGameMode: function (mode) { call('setGameMode', { mode: mode }); },
        setMetadata: function (key, value) { call('setMetadata', { key: key, value: value }); },
      }),
      storage: Object.freeze({
        get: function (key) { var v = call('storageGet', { key: String(key) }); return v === null ? undefined : v; },
        set: function (key, value) { call('storageSet', { key: String(key), value: value }); },
        delete: function (key) { call('storageDelete', { key: String(key) }); },
        keys: function () { return call('storageKeys'); },
      }),
      timers: Object.freeze({
        setTimeout: function (fn, ms) { var id = addTimer(fn, ms, false); return disposable(function () { clearTimer(id); }); },
        setInterval: function (fn, ms) { var id = addTimer(fn, ms, true); return disposable(function () { clearTimer(id); }); },
      }),
      plugins: Object.freeze({
        expose: function (api) {
          if (typeof api !== 'object' || api === null) throw new TypeError('expose() takes an object');
          exposed = api;
          var methods = [];
          for (var k in api) if (typeof api[k] === 'function') methods.push(k);
          call('expose', { methods: methods });
        },
        get: function (id) {
          var methods = call('get', { id: String(id) });
          return methods ? remote(String(id), methods) : undefined;
        },
      }),
      fetch: function (input, init) {
        init = init || {};
        var body = init.body;
        if (body !== undefined && body !== null && typeof body !== 'string') return Promise.reject(new TypeError('fetch body must be a string in the sandbox'));
        return callAsync('fetch', {
          url: String(input && input.href ? input.href : input),
          init: { method: init.method, headers: plainHeaders(init.headers), body: body === null ? undefined : body },
        }).then(makeResponse);
      },
      on: function (event, handler) {
        if (typeof handler !== 'function') throw new TypeError('on() needs a handler function');
        var id = nextId++;
        handlers.set(id, handler);
        var sub = call('on', { id: id, event: String(event) });
        return disposable(function () { handlers.delete(id); call('dispose', { sub: sub }); });
      },
    });
  }

  // Values handed back to the host: a promise for async results, else undefined or a JSON string.
  function result(value, keep) {
    if (value && typeof value.then === 'function') {
      return Promise.resolve(value).then(function (v) { return keep ? encode(v) : undefined; });
    }
    return keep ? encode(value) : undefined;
  }

  globalThis.__ocGuest = Object.freeze({
    setup: function (infoJson) {
      var def = globalThis.__ocPlugin;
      if (!def || typeof def !== 'object' || typeof def.setup !== 'function') {
        throw new Error('the default export must be definePlugin({ setup(ctx) { ... } })');
      }
      var take = function (c) { cleanup = typeof c === 'function' ? c : null; return cleanup !== null; };
      var r = def.setup(makeContext(JSON.parse(infoJson)));
      return result(r && typeof r.then === 'function' ? Promise.resolve(r).then(take) : take(r), true);
    },
    cleanup: function () {
      var c = cleanup;
      cleanup = null;
      return result(c ? c() : undefined, false);
    },
    // Ids arrive as strings (everything crossing the boundary is a string); the maps use numbers.
    dispatch: function (id, payloadJson) {
      var h = handlers.get(Number(id));
      return h ? result(h(JSON.parse(payloadJson)), false) : undefined;
    },
    timer: function (id) {
      id = Number(id);
      var t = timers.get(id);
      if (!t) return undefined;
      if (!t.repeat) timers.delete(id);
      return result(t.fn(), false);
    },
    command: function (id, invocationJson) {
      var h = commands.get(Number(id));
      if (!h) return undefined;
      var inv = JSON.parse(invocationJson);
      var token = inv.token;
      delete inv.token;
      inv.reply = function (message) { return callAsync('reply', { token: token, message: String(message) }); };
      return result(h(Object.freeze(inv)), false);
    },
    call: function (method, argsJson) {
      if (!exposed || typeof exposed[method] !== 'function') throw new Error('this plugin exposes no method "' + method + '"');
      return result(exposed[method].apply(exposed, JSON.parse(argsJson)), true);
    },
  });
})();
`;
