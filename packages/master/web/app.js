// OpenCitadel web server browser. Dependency-free; reads only the public /v1 API of the origin
// that serves it, plus /local/* when served by `citadel-browser ui`. Every string that comes
// from the network is inserted with textContent, never as HTML.

const APP_ID = '1422450';
const PAGE_SIZE = 50;
const REFRESH_MS = 15000;

const REGIONS = {
  'na-east': 'North America East',
  'na-west': 'North America West',
  'na-central': 'North America Central',
  sa: 'South America',
  'eu-west': 'Europe West',
  'eu-east': 'Europe East',
  'eu-north': 'Europe North',
  ru: 'Russia',
  me: 'Middle East',
  af: 'Africa',
  'asia-east': 'East Asia',
  'asia-south': 'South Asia',
  'asia-se': 'Southeast Asia',
  oce: 'Oceania',
};

const PERMISSIONS = {
  'server.command': 'Run arbitrary server console commands',
  'server.chat': 'Send chat messages to players',
  'players.manage': 'Kick players and change teams',
  'listing.write': 'Change the server listing (tags, game mode, metadata)',
  network: 'Make outbound network requests',
  storage: 'Persist data on the host',
};

const KINDS = {
  host: { label: 'Host plugin', blurb: 'JavaScript that runs beside the server in citadel-host' },
  deadworks: { label: 'Deadworks plugin', blurb: '.NET plugin loaded in-process by Deadworks' },
  content: { label: 'Content', blurb: 'Maps and VPK content, synced to players before they join' },
};

// Mirrors TRUST_LABELS in packages/protocol/src/registry.ts.
const TRUST_LABELS = {
  host: 'Runs in a WebAssembly sandbox inside citadel-host: no file, process or network access beyond the permissions it declares.',
  deadworks: 'Full trust: runs inside the game server process with full access to the machine.',
  content: 'Content only (VPK files). Files marked for clients are offered to players when they join.',
};

const REPORT_REASONS = [
  ['malware', 'Malware or a backdoor'],
  ['copyright', 'Copyright infringement'],
  ['broken', 'Broken or dangerous to run'],
  ['spam', 'Spam or misleading'],
  ['other', 'Something else'],
];

const STOCK_MAPS = ['dl_midtown', 'dl_hideout', 'street_test'];

const FILTER_DEFAULTS = { q: '', region: '', map: '', mode: '', sort: 'players', notFull: false, notEmpty: false, noPassword: false, modded: '', verified: false, favorites: false };

const state = {
  local: null, // /local/info payload when served by citadel-browser
  favorites: new Set(),
  filters: loadFilters(),
  page: 0,
  seenMaps: new Set(STOCK_MAPS),
  seenModes: new Set(),
  timers: [],
  pings: {},
  routeToken: 0,
};

// ---------------------------------------------------------------- helpers

/** Creates an element. `attrs.text` sets textContent; `on*` attrs become listeners. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = String(value);
    else if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value' && 'value' in el) el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = !!value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, init) {
  const res = await fetch(path, { ...init, headers: { accept: 'application/json', ...(init && init.headers) } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty or non-JSON */
  }
  if (!res.ok) {
    const err = new Error((body && body.error && body.error.message) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function loadFilters() {
  try {
    return { ...FILTER_DEFAULTS, ...JSON.parse(localStorage.getItem('oc.filters') || '{}') };
  } catch {
    return { ...FILTER_DEFAULTS };
  }
}

function saveFilters() {
  try {
    localStorage.setItem('oc.filters', JSON.stringify(state.filters));
  } catch {
    /* storage unavailable */
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function every(ms, fn) {
  const id = setInterval(() => {
    if (document.visibilityState === 'visible') fn();
  }, ms);
  state.timers.push(id);
}

function relativeTime(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function prettyMap(map) {
  return map.replace(/^dl_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function toast(message, kind) {
  const el = h('div', { class: `toast${kind === 'error' ? ' toast-error' : ''}`, text: message });
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { class: 'sr-only', 'aria-hidden': 'true' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied to clipboard');
}

function copyRow(text) {
  const code = h('code', { text });
  const row = h('div', { class: 'copy-row' }, h('pre', { class: 'cmd' }, code), h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => copyText(code.textContent) }, 'Copy'));
  row.setText = (t) => {
    code.textContent = t;
  };
  return row;
}

function setTally(stats) {
  const el = document.getElementById('tally');
  el.replaceChildren();
  if (!stats) return;
  el.append(h('strong', { text: stats.servers }), ` server${stats.servers === 1 ? '' : 's'} · `, h('strong', { text: stats.players }), ` player${stats.players === 1 ? '' : 's'} online`);
}

function panel(title, ...children) {
  return h('section', { class: 'panel' }, title ? h('h2', { text: title }) : null, ...children);
}

function errorState(err, retry) {
  return h(
    'div',
    { class: 'error-state', role: 'alert' },
    h('h2', { text: err.status === 404 ? 'Not found' : 'Something went wrong' }),
    h('p', { text: err.message }),
    retry ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: retry }, 'Try again') : null,
  );
}

// ---------------------------------------------------------------- joining
// Mirrors packages/protocol/src/connect.ts exactly.

function pickConnectTarget(connect, verified) {
  if (connect.address && verified) return { kind: 'address', value: connect.address };
  if (connect.steamId) return { kind: 'steamId', value: connect.steamId };
  if (connect.address) return { kind: 'address', value: connect.address };
  return undefined;
}

function connectCommand(target, password) {
  const pw = password ? `password "${password.replace(/"/g, '')}"; ` : '';
  return `${pw}connect ${target.value}`;
}

function steamJoinUrl(target, password) {
  if (target.kind === 'address') {
    return `steam://connect/${target.value}${password ? `/${encodeURIComponent(password)}` : ''}`;
  }
  const args = [...(password ? ['+password', `"${password.replace(/"/g, '')}"`] : []), '+connect', target.value];
  return `steam://run/${APP_ID}//${encodeURIComponent(args.join(' '))}/`;
}

function openJoinDialog(title, ...content) {
  const dialog = document.getElementById('join-dialog');
  document.getElementById('join-title').textContent = title;
  document.getElementById('join-content').replaceChildren(...content);
  if (!dialog.open) dialog.showModal();
}

function consoleHelp(command) {
  return [
    h('p', { text: 'If Deadlock is already running, Steam won’t pass the server along. Open the console with F7 (enable it under Settings → “Dev command console”) and paste:' }),
    copyRow(command),
  ];
}

async function join(server, password) {
  if (state.local) return joinLocal(server, password);
  const target = pickConnectTarget(server.connect, server.verified);
  if (!target) return toast('This server has not published a way to connect.', 'error');
  const url = steamJoinUrl(target, password);
  const command = connectCommand(target, password);
  const launch = h('a', { class: 'btn', href: url }, 'Launch Deadlock');
  if (server.requiresContent) {
    openJoinDialog(
      `Join ${server.name}`,
      h('div', { class: 'notice notice-warn' }, 'This server needs custom content (maps or mods). Install it first with ', h('code', { text: `citadel-browser join ${server.id}` }), ', which downloads and verifies everything, then launches the game.'),
      h('div', { class: 'modal-actions' }, h('a', { class: 'btn btn-ghost', href: url }, 'Launch anyway')),
      ...consoleHelp(command),
    );
    return;
  }
  openJoinDialog(`Joining ${server.name}`, h('p', { text: 'Steam will ask you to confirm launching Deadlock with this server.' }), h('div', { class: 'modal-actions' }, launch), ...consoleHelp(command));
  window.location.href = url;
}

async function joinLocal(server, password) {
  openJoinDialog(`Joining ${server.name}`, h('p', { text: server.requiresContent ? 'Downloading and verifying server content…' : 'Launching Deadlock…' }), h('div', { class: 'skeleton', 'aria-hidden': 'true' }));
  try {
    const r = await api(`/local/join/${encodeURIComponent(server.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(password ? { password } : {}) });
    const parts = [h('p', { text: r.message || (r.launched ? 'Deadlock is launching.' : 'Ready to join.') })];
    if (r.contentInstalled && r.contentInstalled.length) {
      parts.push(h('p', { text: 'Installed content:' }), h('ul', {}, r.contentInstalled.map((c) => h('li', { text: c }))));
    }
    if (r.restartRequired) parts.push(h('div', { class: 'notice notice-warn', text: 'Deadlock is running with different content. Restart the game so it picks up the new files, then join again.' }));
    if (!r.launched && r.steamUrl) parts.push(h('div', { class: 'modal-actions' }, h('a', { class: 'btn', href: r.steamUrl }, 'Launch Deadlock')));
    if (r.command) parts.push(...consoleHelp(r.command));
    openJoinDialog(r.ok ? `Joining ${server.name}` : `Couldn’t join ${server.name}`, ...parts);
  } catch (err) {
    openJoinDialog(`Couldn’t join ${server.name}`, h('div', { class: 'notice notice-warn', text: err.message }));
  }
}

async function toggleFavorite(id, button) {
  const on = !state.favorites.has(id);
  try {
    await api(`/local/favorites/${encodeURIComponent(id)}`, { method: on ? 'PUT' : 'DELETE' });
    if (on) state.favorites.add(id);
    else state.favorites.delete(id);
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? '★' : '☆';
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- badges

function serverBadges(s, extra) {
  const b = [];
  if (extra && extra.online === false) b.push(h('span', { class: 'badge badge-offline', text: 'Offline' }));
  if (s.verified) b.push(h('span', { class: 'badge badge-verified', title: 'The master reached this server at its listed address', text: 'Verified' }));
  if (s.passworded) b.push(h('span', { class: 'badge badge-password', text: 'Password' }));
  if (s.requiresContent) b.push(h('span', { class: 'badge badge-content', title: 'Players download custom content before joining', text: 'Content' }));
  else if (s.modded) b.push(h('span', { class: 'badge badge-modded', text: 'Modded' }));
  if (s.source === 'deadworks' || (s.software && s.software.name === 'deadworks')) b.push(h('span', { class: 'badge badge-deadworks', text: 'Deadworks' }));
  for (const t of s.tags.slice(0, extra && extra.allTags ? 16 : 4)) b.push(h('span', { class: 'badge badge-tag', text: t }));
  return h('div', { class: 'badges' }, b);
}

function playerBar(s) {
  const pct = s.maxPlayers ? Math.min(100, Math.round((s.players / s.maxPlayers) * 100)) : 0;
  const fill = h('div', { class: 'bar-fill' });
  fill.style.width = `${pct}%`;
  return h(
    'div',
    { class: 'players' },
    h('div', { class: 'players-count' }, `${s.players}`, h('span', { text: ` / ${s.maxPlayers}` }), s.bots ? h('span', { text: ` · ${s.bots} bot${s.bots === 1 ? '' : 's'}` }) : null),
    h('div', { class: 'bar', role: 'img', 'aria-label': `${s.players} of ${s.maxPlayers} players` }, fill),
  );
}

function pingCell(id) {
  const ms = state.pings[id];
  if (ms === undefined) return h('div', { class: 'ping', text: '…', title: 'Measuring ping' });
  if (ms === null) return h('div', { class: 'ping', text: '—', title: 'No direct address to ping' });
  const cls = ms < 60 ? 'ping-good' : ms < 120 ? 'ping-ok' : 'ping-bad';
  return h('div', { class: `ping ${cls}`, text: `${ms} ms`, title: 'Round trip from this PC' });
}

// ---------------------------------------------------------------- servers view

function selectField(label, key, options, onChange) {
  const select = h(
    'select',
    { 'data-filter': key, onchange: (e) => onChange(key, e.target.value) },
    options.map(([value, text]) => h('option', { value, selected: state.filters[key] === value }, text)),
  );
  return h('label', { class: 'field' }, h('span', { text: label }), select);
}

function chip(label, key, onChange) {
  return h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: !!state.filters[key], onchange: (e) => onChange(key, e.target.checked) }), h('span', { text: label }));
}

function renderServers(view, token) {
  const list = h('ul', { class: `servers${state.local ? ' is-local' : ''}`, 'aria-label': 'Servers', 'aria-busy': 'true' },[0, 1, 2, 3].map(() => h('li', { class: 'skeleton', 'aria-hidden': 'true' })));
  const count = h('span', { class: 'refresh-note', 'aria-live': 'polite' });
  const pager = h('nav', { class: 'pager', 'aria-label': 'Pages' });

  const changed = (key, value) => {
    state.filters[key] = value;
    state.page = 0;
    saveFilters();
    load();
  };
  const search = h('input', { type: 'search', placeholder: 'Name, map, tag…', value: state.filters.q, 'aria-label': 'Search servers', oninput: debounce((e) => changed('q', e.target.value.trim()), 250) });
  const mapSelect = selectField('Map', 'map', [['', 'Any map']], changed);
  const modeSelect = selectField('Game mode', 'mode', [['', 'Any mode']], changed);

  const filters = h(
    'details',
    { class: 'filters', open: window.matchMedia('(min-width: 861px)').matches },
    h('summary', {}, 'Filters'),
    h(
      'div',
      { class: 'filters-body' },
      h('label', { class: 'field' }, h('span', { text: 'Search' }), search),
      selectField('Region', 'region', [['', 'Anywhere'], ...Object.entries(REGIONS)], changed),
      mapSelect,
      modeSelect,
      selectField('Sort by', 'sort', [['players', 'Most players'], ['name', 'Name'], ['newest', 'Newest']], changed),
      selectField('Mods', 'modded', [['', 'Modded or vanilla'], ['0', 'Vanilla only'], ['1', 'Modded only']], changed),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: 'Show only' }),
        h(
          'div',
          { class: 'toggles' },
          chip('Not full', 'notFull', changed),
          chip('Has players', 'notEmpty', changed),
          chip('No password', 'noPassword', changed),
          chip('Verified', 'verified', changed),
          state.local ? chip('Favorites', 'favorites', changed) : null,
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-sm btn-reset',
          onclick: () => {
            state.filters = { ...FILTER_DEFAULTS };
            saveFilters();
            route();
          },
        },
        'Reset filters',
      ),
    ),
  );

  view.replaceChildren(
    h(
      'div',
      { class: 'browser' },
      filters,
      h('section', { 'aria-labelledby': 'servers-title' }, h('div', { class: 'list-head' }, h('h1', { id: 'servers-title', text: 'Servers' }), count), list, pager),
    ),
  );

  function refreshOptions(select, values, current) {
    const el = select.querySelector('select');
    const first = el.options[0];
    const opts = [...new Set([...values, ...(current ? [current] : [])])].sort();
    el.replaceChildren(first, ...opts.map((v) => h('option', { value: v, selected: v === current }, select === mapSelect ? prettyMap(v) : v)));
  }

  async function load() {
    const f = state.filters;
    const params = new URLSearchParams({ sort: f.sort, limit: String(PAGE_SIZE), offset: String(state.page * PAGE_SIZE) });
    for (const k of ['q', 'region', 'map', 'mode', 'modded']) if (f[k] !== '') params.set(k, f[k]);
    for (const k of ['notFull', 'notEmpty', 'noPassword', 'verified']) if (f[k]) params.set(k, '1');
    let data;
    try {
      data = await api(`/v1/servers?${params}`);
    } catch (err) {
      if (token !== state.routeToken) return;
      list.setAttribute('aria-busy', 'false');
      list.replaceChildren(h('li', {}, errorState(err, load)));
      return;
    }
    if (token !== state.routeToken) return;
    setTally(data.stats);
    for (const s of data.servers) {
      state.seenMaps.add(s.map);
      if (s.gameMode) state.seenModes.add(s.gameMode);
    }
    refreshOptions(mapSelect, state.seenMaps, f.map);
    refreshOptions(modeSelect, state.seenModes, f.mode);

    const servers = state.local && f.favorites ? data.servers.filter((s) => state.favorites.has(s.id)) : data.servers;
    renderRows(servers, data.total);
    renderPager(data.total);
    if (state.local) loadPings(servers.map((s) => s.id));
  }

  function renderRows(servers, total) {
    const focusedKey = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.key;
    list.setAttribute('aria-busy', 'false');
    count.textContent = total ? `${total} server${total === 1 ? '' : 's'} · refreshes every 15s` : '';
    if (!servers.length) {
      const anyFilter = Object.entries(state.filters).some(([k, v]) => k !== 'sort' && v !== '' && v !== false);
      list.replaceChildren(
        h(
          'li',
          { class: 'empty' },
          h('h2', { text: anyFilter ? 'No servers match' : 'No servers online yet' }),
          h('p', {}, anyFilter ? 'Try loosening the filters.' : 'Be the first: ', anyFilter ? null : h('a', { href: '#/host' }, 'host a server'), anyFilter ? null : '.'),
        ),
      );
      return;
    }
    list.replaceChildren(...servers.map(serverRow));
    if (focusedKey) {
      const again = list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
      if (again) again.focus();
    }
  }

  function serverRow(s) {
    const full = s.players >= s.maxPlayers;
    const fav = state.local
      ? h('button', { type: 'button', class: 'fav', 'data-key': `fav-${s.id}`, 'aria-pressed': String(state.favorites.has(s.id)), 'aria-label': `Favorite ${s.name}`, onclick: (e) => toggleFavorite(s.id, e.currentTarget) }, state.favorites.has(s.id) ? '★' : '☆')
      : null;
    return h(
      'li',
      { class: `server${full ? ' is-full' : ''}`, 'data-id': s.id },
      fav,
      h('div', { class: 'server-name' }, h('a', { href: `#/server/${s.id}`, 'data-key': `link-${s.id}`, text: s.name }), serverBadges(s)),
      h('div', { class: 'cell cell-map' }, h('strong', { text: prettyMap(s.map) }), h('small', { text: s.gameMode || s.map })),
      h('div', { class: 'cell cell-region' }, h('strong', { text: s.region ? REGIONS[s.region] || s.region : '—' }), h('small', { text: s.country || '' })),
      playerBar(s),
      state.local ? pingCell(s.id) : null,
      h(
        'div',
        { class: 'join-cell' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm',
            'data-key': `join-${s.id}`,
            'aria-label': `Join ${s.name}`,
            disabled: full,
            onclick: () => (s.passworded ? (location.hash = `#/server/${s.id}`) : join(s)),
          },
          full ? 'Full' : 'Join',
        ),
      ),
    );
  }

  function renderPager(total) {
    pager.replaceChildren();
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages <= 1) return;
    const go = (p) => {
      state.page = p;
      load();
      list.scrollIntoView({ block: 'start' });
    };
    pager.append(
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: state.page === 0, onclick: () => go(state.page - 1) }, 'Previous'),
      h('span', { text: `Page ${state.page + 1} of ${pages}` }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: state.page >= pages - 1, onclick: () => go(state.page + 1) }, 'Next'),
    );
  }

  async function loadPings(ids) {
    const missing = ids.filter((id) => !(id in state.pings));
    if (!missing.length) return;
    try {
      const { pings } = await api(`/local/ping?ids=${missing.slice(0, 100).map(encodeURIComponent).join(',')}`);
      Object.assign(state.pings, pings);
      if (token !== state.routeToken) return;
      for (const li of list.querySelectorAll('.server')) {
        const cell = li.querySelector('.ping');
        if (cell) cell.replaceWith(pingCell(li.dataset.id));
      }
    } catch {
      /* ping is best effort */
    }
  }

  load();
  every(REFRESH_MS, load);
  // Pings go stale; re-measure each minute.
  every(60000, () => {
    state.pings = {};
  });
}

// ---------------------------------------------------------------- server detail

function renderServer(view, token, id) {
  view.replaceChildren(h('div', { class: 'skeleton', 'aria-hidden': 'true' }));
  let passwordValue = '';

  async function load() {
    let s;
    try {
      s = await api(`/v1/servers/${encodeURIComponent(id)}`);
    } catch (err) {
      if (token === state.routeToken) view.replaceChildren(h('a', { class: 'back', href: '#/' }, '← All servers'), errorState(err, load));
      return;
    }
    if (token !== state.routeToken) return;
    const hadFocus = document.activeElement && document.activeElement.id === 'server-password';
    view.replaceChildren(detail(s));
    if (hadFocus) document.getElementById('server-password').focus();
  }

  function detail(s) {
    document.title = `${s.name} · OpenCitadel`;
    const target = pickConnectTarget(s.connect, s.verified);
    const cmd = target ? copyRow(connectCommand(target, passwordValue)) : null;
    const password = s.passworded
      ? h('label', { class: 'field' }, h('span', { text: 'Server password' }), h('input', {
          type: 'password',
          id: 'server-password',
          autocomplete: 'off',
          value: passwordValue,
          oninput: (e) => {
            passwordValue = e.target.value;
            if (cmd && target) cmd.setText(connectCommand(target, passwordValue));
          },
        }))
      : null;
    const full = s.players >= s.maxPlayers;
    const joinBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-lg',
        disabled: !s.online || full || !target,
        onclick: () => {
          if (s.passworded && !passwordValue) {
            toast('Enter the server password first.', 'error');
            document.getElementById('server-password').focus();
            return;
          }
          join(s, passwordValue || undefined);
        },
      },
      !s.online ? 'Offline' : full ? 'Server full' : 'Join server',
    );

    const facts = [
      ['Map', prettyMap(s.map)],
      ['Game mode', s.gameMode || '—'],
      ['Players', `${s.players} / ${s.maxPlayers}${s.bots ? ` (+${s.bots} bots)` : ''}`],
      ['Region', s.region ? REGIONS[s.region] || s.region : '—'],
      ['Country', s.country || '—'],
      ['Software', s.software ? `${s.software.name} ${s.software.version}` : '—'],
      ['Game build', s.gameBuild || '—'],
      ['Listed since', new Date(s.firstSeen).toLocaleString()],
      ['Last heartbeat', relativeTime(s.lastHeartbeat)],
      ['Owner', s.owner ? s.owner.name : s.source === 'deadworks' ? 'Self-registered (Deadworks)' : '—'],
    ];

    const side = [
      panel(
        'Connect',
        h(
          'div',
          { class: 'connect-panel' },
          !s.online ? h('div', { class: 'notice notice-warn', text: 'This server is offline right now.' }) : null,
          s.requiresContent
            ? h(
                'div',
                { class: 'notice' },
                state.local ? 'Required content will be downloaded, verified and installed when you join.' : h('span', {}, 'Needs custom content. ', h('code', { text: `citadel-browser join ${s.id}` }), ' installs it and launches the game.'),
              )
            : null,
          password,
          joinBtn,
          target ? h('p', { class: 'hint', text: 'Or paste into the in-game console (F7):' }) : h('p', { class: 'hint', text: 'This server has not published a way to connect.' }),
          cmd,
          h('dl', { class: 'kv' }, s.connect.steamId ? [h('dt', { text: 'SteamID' }), h('dd', { text: s.connect.steamId })] : null, s.connect.address ? [h('dt', { text: 'Address' }), h('dd', { text: s.connect.address })] : null),
        ),
      ),
    ];
    if (s.content.length) {
      side.push(
        panel(
          'Required content',
          h(
            'ul',
            { class: 'plain-list' },
            s.content.map((c) => h('li', {}, h('span', {}, h('strong', { text: c.name }), ` · ${c.kind}`), h('span', { class: 'mono', title: c.sha256, text: `${formatBytes(c.size)} · ${c.sha256.slice(0, 10)}` }))),
          ),
        ),
      );
    }
    if (s.plugins.length) {
      side.push(
        panel(
          'Plugins',
          h(
            'ul',
            { class: 'plain-list' },
            s.plugins.map((p) =>
              h(
                'li',
                {},
                p.kind !== 'other' && s.source === 'opencitadel' ? h('a', { href: `#/plugin/${encodeURIComponent(p.id)}`, text: p.name || p.id }) : h('span', { text: p.name || p.id }),
                h('span', { class: 'mono', text: `${p.version} · ${p.kind}` }),
              ),
            ),
          ),
        ),
      );
    }
    const meta = Object.entries(s.metadata);
    const links = [s.links.website && ['Website', s.links.website], s.links.discord && ['Discord', s.links.discord]].filter(Boolean).filter(([, url]) => /^https:\/\//.test(url));
    if (meta.length || links.length) {
      side.push(
        panel(
          'Details',
          h(
            'dl',
            { class: 'kv' },
            links.map(([label, url]) => [h('dt', { text: label }), h('dd', {}, h('a', { href: url, rel: 'noopener noreferrer nofollow', target: '_blank', text: url.replace(/^https:\/\//, '') }))]),
            meta.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]),
          ),
        ),
      );
    }

    const head = h(
      'header',
      { class: 'panel detail-head' },
      h('p', { class: 'eyebrow', text: s.source === 'deadworks' ? 'Deadworks server' : 'Community server' }),
      h('h1', { class: 'page-title', text: s.name }),
      serverBadges(s, { online: s.online, allTags: true }),
      s.description ? h('p', { class: 'description', text: s.description }) : null,
    );
    const main = [panel('At a glance', h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v })))))];
    // Servers publish player names only when their operator opts in; the count is in the facts above either way.
    if (s.playerList.length) {
      const named = s.playerList.some((p) => p.name);
      const teamDot = (p) => h('span', { class: `team-dot team-${p.team ?? 0}`, 'aria-hidden': 'true' });
      main.push(
        panel(
          `Players (${s.playerList.length})`,
          named ? null : h('p', { class: 'hint', text: 'Player names are hidden on this server.' }),
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, named ? h('th', { text: 'Name' }) : null, h('th', { text: 'Hero' }), h('th', { class: 'num', text: 'K / D / A' }), h('th', { class: 'num', text: 'Level' }), h('th', { class: 'num', text: 'Time' }))),
              h(
                'tbody',
                {},
                s.playerList.map((p) =>
                  h(
                    'tr',
                    {},
                    named ? h('td', {}, teamDot(p), p.name || 'Unnamed') : null,
                    named ? h('td', { text: p.hero || '—' }) : h('td', {}, teamDot(p), p.hero || '—'),
                    h('td', { class: 'num', text: p.kills !== undefined ? `${p.kills} / ${p.deaths ?? 0} / ${p.assists ?? 0}` : '—' }),
                    h('td', { class: 'num', text: p.level ?? '—' }),
                    h('td', { class: 'num', text: p.time !== undefined ? formatDuration(p.time) : '—' }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    return h('div', {}, h('a', { class: 'back', href: '#/' }, '← All servers'), head, h('div', { class: 'detail' }, h('div', { class: 'detail-main' }, main), h('aside', { class: 'detail-side' }, side)));
  }

  load();
  every(REFRESH_MS, load);
  api('/v1/stats').then((s) => token === state.routeToken && setTally(s), () => {});
}

// ---------------------------------------------------------------- plugins

function renderPlugins(view, token) {
  const grid = h('ul', { class: 'plugin-grid', 'aria-label': 'Plugins', 'aria-busy': 'true' }, [0, 1, 2].map(() => h('li', { class: 'skeleton', 'aria-hidden': 'true' })));
  const query = { q: '', kind: '' };
  const load = async () => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.kind) params.set('kind', query.kind);
    let data;
    try {
      data = await api(`/v1/plugins?${params}`);
    } catch (err) {
      if (token === state.routeToken) grid.replaceChildren(h('li', {}, errorState(err, load)));
      return;
    }
    if (token !== state.routeToken) return;
    grid.setAttribute('aria-busy', 'false');
    if (!data.plugins.length) {
      grid.replaceChildren(h('li', { class: 'empty' }, h('h2', { text: query.q || query.kind ? 'No plugins match' : 'No plugins published yet' }), h('p', {}, 'Publish one with ', h('code', { text: 'citadel-host plugin publish' }), '.')));
      return;
    }
    grid.replaceChildren(
      ...data.plugins.map((p) =>
        h(
          'li',
          {},
          h(
            'article',
            { class: 'panel plugin-card' },
            h('p', { class: `eyebrow kind-${p.kind}`, text: (KINDS[p.kind] || { label: p.kind }).label }),
            h('h2', {}, h('a', { href: `#/plugin/${encodeURIComponent(p.id)}`, text: p.name })),
            h('p', { text: p.description || 'No description.' }),
            h('div', { class: 'plugin-meta' }, h('span', { text: `v${p.latest}` }), h('span', { text: `by ${p.author || p.owner}` }), h('span', { text: `${p.downloads} download${p.downloads === 1 ? '' : 's'}` })),
          ),
        ),
      ),
    );
  };
  view.replaceChildren(
    h(
      'div',
      {},
      h('header', { class: 'page-head' }, h('p', { class: 'eyebrow', text: 'Registry' }), h('h1', { class: 'page-title', text: 'Plugins' }), h('p', { class: 'lede', text: 'Host plugins, Deadworks plugins and content packs that server owners can install with one command.' })),
      h(
        'div',
        { class: 'plugin-tools' },
        h('label', { class: 'field' }, h('span', { text: 'Search' }), h('input', { type: 'search', placeholder: 'Name, tag, description…', oninput: debounce((e) => ((query.q = e.target.value.trim()), load()), 250) })),
        h(
          'label',
          { class: 'field' },
          h('span', { text: 'Kind' }),
          h('select', { onchange: (e) => ((query.kind = e.target.value), load()) }, h('option', { value: '' }, 'All kinds'), Object.entries(KINDS).map(([k, v]) => h('option', { value: k }, v.label))),
        ),
      ),
      grid,
    ),
  );
  load();
  api('/v1/stats').then((s) => token === state.routeToken && setTally(s), () => {});
}

function renderPlugin(view, token, id) {
  view.replaceChildren(h('div', { class: 'skeleton', 'aria-hidden': 'true' }));
  const load = async () => {
    let data;
    let advisories = [];
    let publisher = null;
    try {
      [data, advisories] = await Promise.all([
        api(`/v1/plugins/${encodeURIComponent(id)}`),
        api(`/v1/plugins/${encodeURIComponent(id)}/advisories`).then((r) => r.advisories || [], () => []),
      ]);
      // The publisher's keys turn a key id into a ready-to-run verify command; optional.
      publisher = await api(`/v1/publishers/${encodeURIComponent(data.plugin.owner)}`).catch(() => null);
    } catch (err) {
      if (token === state.routeToken) view.replaceChildren(h('a', { class: 'back', href: '#/plugins' }, '← All plugins'), errorState(err, load));
      return;
    }
    if (token !== state.routeToken) return;
    const { plugin: p, manifest: m, versions } = data;
    const latest = versions.find((v) => v.version === p.latest) || versions[0];
    const activeAdvisories = advisories.filter((a) => !a.withdrawn);
    document.title = `${p.name} · OpenCitadel plugins`;
    const facts = [
      ['Latest', `v${p.latest}`],
      ['Publisher', p.owner],
      ['Author', m.author || '—'],
      ['License', m.license || '—'],
      ['Downloads', String(p.downloads)],
      ['Updated', relativeTime(p.updatedAt)],
    ];
    const head = h(
      'header',
      { class: 'panel detail-head' },
      h('p', { class: `eyebrow kind-${p.kind}`, text: (KINDS[p.kind] || { label: p.kind }).label }),
      h('h1', { class: 'page-title', text: p.name }),
      h(
        'div',
        { class: 'badges' },
        latest && latest.signature ? h('span', { class: 'badge badge-verified', title: `Signed by key ${latest.signature.keyId}`, text: 'Signed' }) : h('span', { class: 'badge badge-offline', text: 'Unsigned' }),
        latest && latest.keyChanged ? h('span', { class: 'badge badge-password', text: 'Key changed' }) : null,
        latest && provenanceLinks(latest.provenance) ? h('span', { class: 'badge badge-ci', title: 'Built and published by GitHub Actions', text: 'Built by CI' }) : null,
        p.requireTrustedPublishing ? h('span', { class: 'badge badge-verified', title: "New versions can only come from the plugin's linked CI workflows", text: 'Trusted publishing only' }) : null,
        activeAdvisories.length
          ? h('button', { type: 'button', class: 'badge badge-password badge-button', onclick: () => document.getElementById('advisories')?.scrollIntoView({ block: 'start' }), text: `${activeAdvisories.length} advisor${activeAdvisories.length === 1 ? 'y' : 'ies'}` })
          : null,
        h('span', { class: 'badge badge-tag', text: p.id }),
        p.tags.map((t) => h('span', { class: 'badge badge-tag', text: t })),
      ),
      h('p', { class: 'description', text: p.description || 'No description.' }),
      m.homepage && /^https:\/\//.test(m.homepage) ? h('p', {}, h('a', { href: m.homepage, rel: 'noopener noreferrer nofollow', target: '_blank', text: m.homepage })) : null,
    );
    const main = [panel('At a glance', h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v })))))];
    if (advisories.length) main.unshift(advisoriesPanel(advisories));
    const config = Object.entries(m.config || {});
    if (config.length) {
      main.push(
        panel(
          'Configuration',
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', { text: 'Key' }), h('th', { text: 'Type' }), h('th', { text: 'Default' }), h('th', { text: 'Description' }))),
              h(
                'tbody',
                {},
                config.map(([k, f]) =>
                  h('tr', {}, h('td', {}, h('code', { text: k })), h('td', { text: f.type }), h('td', {}, f.secret ? h('em', { text: 'secret' }) : f.default === undefined ? '—' : h('code', { text: JSON.stringify(f.default) })), h('td', { text: f.description || '' })),
                ),
              ),
            ),
          ),
        ),
      );
    }
    main.push(
      panel(
        'Versions',
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h(
              'thead',
              {},
              h('tr', {}, h('th', { text: 'Version' }), h('th', { text: 'Published' }), h('th', { class: 'num', text: 'Size' }), h('th', { text: 'SHA-256' }), h('th', { text: 'Signature' }), h('th', { text: 'Built by' }), h('th', { text: '' })),
            ),
            h(
              'tbody',
              {},
              versions.map((v) => {
                const pkgUrl = `/v1/plugins/${encodeURIComponent(p.id)}/${encodeURIComponent(v.version)}/package`;
                return h(
                  'tr',
                  {},
                  h('td', {}, v.version, v.yanked ? h('span', { class: 'badge badge-password', text: ' yanked' }) : null),
                  h('td', { text: new Date(v.publishedAt).toLocaleDateString() }),
                  h('td', { class: 'num', text: formatBytes(v.size) }),
                  h('td', {}, h('code', { title: v.sha256, text: v.sha256.slice(0, 12) })),
                  h(
                    'td',
                    {},
                    v.signature ? h('code', { title: v.signature.trustedComment, text: v.signature.keyId }) : h('span', { class: 'faint', text: 'unsigned' }),
                    v.keyChanged ? h('span', { class: 'badge badge-password', title: 'Signed with a different key than the previous release, or unsigned after a signed one', text: 'key changed' }) : null,
                  ),
                  h('td', {}, provenanceCell(v.provenance)),
                  h(
                    'td',
                    { class: 'links' },
                    h('a', { href: pkgUrl, download: `${p.id}-${v.version}.tgz` }, 'Download'),
                    v.signature ? h('a', { href: `${pkgUrl}.minisig`, download: `${p.id}-${v.version}.tgz.minisig` }, '.minisig') : null,
                  ),
                );
              }),
            ),
          ),
        ),
      ),
    );

    const install = [h('p', { class: 'hint', text: 'In your server directory:' }), copyRow(`citadel-host plugin install ${p.id}`)];
    if (p.kind !== 'host') install.push(h('p', { class: 'hint', text: 'Running Deadworks without citadel-host:' }), copyRow(`citadel-pkg install ${p.id}`));
    install.push(h('p', { class: 'hint', text: KINDS[p.kind] ? KINDS[p.kind].blurb : '' }));
    const side = [panel('Install', h('div', { class: 'connect-panel' }, install)), trustPanel(p, m, latest, publisher)];
    if (m.permissions && m.permissions.length) {
      side.push(panel('Permissions', h('ul', { class: 'perm-list' }, m.permissions.map((perm) => h('li', {}, h('code', { text: perm }), h('span', { text: PERMISSIONS[perm] || '' }))))));
    } else if (p.kind === 'host') {
      side.push(panel('Permissions', h('p', { class: 'hint', text: 'Requests no special permissions.' })));
    }
    const deps = Object.entries(m.dependencies || {});
    const engines = Object.entries(m.engines || {});
    if (deps.length || engines.length) {
      side.push(panel('Requires', h('dl', { class: 'kv' }, engines.map(([k, r]) => [h('dt', { text: k }), h('dd', { text: r })]), deps.map(([k, r]) => [h('dt', {}, h('a', { href: `#/plugin/${encodeURIComponent(k)}`, text: k })), h('dd', { text: r })]))));
    }
    if (m.content && m.content.length) {
      side.push(panel('Content files', h('ul', { class: 'plain-list' }, m.content.map((c) => h('li', {}, h('code', { text: c.file }), h('span', { class: 'mono', text: c.client ? 'players download' : 'server only' }))))));
    }
    side.push(reportPanel(p, versions));
    view.replaceChildren(h('div', {}, h('a', { class: 'back', href: '#/plugins' }, '← All plugins'), head, h('div', { class: 'detail' }, h('div', { class: 'detail-main' }, main), h('aside', { class: 'detail-side' }, side))));
  };
  load();
}

// ---------------------------------------------------------------- registry trust

function advisoriesPanel(advisories) {
  const section = panel(
    'Security advisories',
    h(
      'ul',
      { class: 'advisories' },
      advisories.map((a) =>
        h(
          'li',
          { class: `advisory sev-${a.severity}${a.withdrawn ? ' is-withdrawn' : ''}` },
          h(
            'div',
            { class: 'advisory-head' },
            h('span', { class: `badge badge-sev badge-sev-${a.severity}`, text: a.severity }),
            h('strong', { text: a.title }),
            a.withdrawn ? h('span', { class: 'badge badge-offline', text: 'Withdrawn' }) : null,
          ),
          h('p', { class: 'advisory-meta' }, 'Affects ', h('code', { text: a.affected }), a.fixedIn ? [' · fixed in ', h('code', { text: a.fixedIn })] : ' · no fix yet', ` · ${new Date(a.publishedAt).toLocaleDateString()}`),
          a.description ? h('p', { class: 'advisory-body', text: a.description }) : null,
          a.url && /^https:\/\//.test(a.url) ? h('a', { href: a.url, rel: 'noopener noreferrer nofollow', target: '_blank', text: 'Details' }) : null,
        ),
      ),
    ),
    h('p', { class: 'hint' }, 'Server owners can check what they have installed with ', h('code', { text: 'citadel-host plugin audit' }), '.'),
  );
  section.id = 'advisories';
  return section;
}

function trustPanel(p, m, latest, publisher) {
  const parts = [h('p', { class: `trust-label trust-${p.kind}`, text: TRUST_LABELS[p.kind] || '' })];
  const sig = latest && latest.signature;
  if (sig) {
    parts.push(h('p', {}, 'v', latest.version, ' is signed by key ', h('code', { text: sig.keyId }), ' of ', h('a', { href: `#/publisher/${encodeURIComponent(p.owner)}`, text: p.owner }), '.'));
    const key = publisher && publisher.signingKeys.find((k) => k.keyId === sig.keyId);
    if (key && key.revokedAt) parts.push(h('div', { class: 'notice notice-warn', text: `The publisher revoked this key on ${new Date(key.revokedAt).toLocaleDateString()}.` }));
    if (key) {
      parts.push(
        h('p', { class: 'hint', text: 'Check a download yourself (save the package and its .minisig side by side):' }),
        copyRow(`minisign -Vm ${p.id}-${latest.version}.tgz -P ${key.publicKey}`),
      );
    }
  } else {
    parts.push(h('p', { class: 'hint', text: 'Unsigned: nothing proves who built this package. Review its source before installing.' }));
  }
  const prov = latest && latest.provenance;
  const links = provenanceLinks(prov);
  if (links) {
    parts.push(
      h(
        'p',
        {},
        'v',
        latest.version,
        ' was built and published by GitHub Actions from ',
        links.commit ? h('a', { href: links.commit, rel: 'noopener noreferrer nofollow', target: '_blank' }, h('code', { text: links.label })) : h('code', { text: links.label }),
        ' (',
        h('code', { text: prov.workflow }),
        prov.environment ? [', environment ', h('code', { text: prov.environment })] : null,
        '). ',
        h('a', { href: links.run, rel: 'noopener noreferrer nofollow', target: '_blank', text: 'View the run' }),
        '.',
      ),
      h('p', { class: 'hint', text: "The registry checked the workflow's identity with GitHub before accepting the upload. That proves which repository, commit and workflow published it, not that the code is safe." }),
    );
  }
  if (p.requireTrustedPublishing) parts.push(h('p', { class: 'hint', text: "Only this plugin's linked CI workflows can publish new versions; an API key alone can't." }));
  if (latest && latest.keyChanged) {
    parts.push(
      h('div', {
        class: 'notice notice-warn',
        text: sig
          ? 'This release is signed with a different key than the one before it. citadel-host will refuse it until you accept the new key; confirm the change with the publisher first.'
          : 'This release is unsigned, but an earlier release was signed. citadel-host refuses it unless you allow unsigned updates.',
      }),
    );
  }
  if (m.repository && /^https:\/\//.test(m.repository)) {
    parts.push(h('p', {}, 'Source: ', h('a', { href: m.repository, rel: 'noopener noreferrer nofollow', target: '_blank', text: m.repository.replace(/^https:\/\//, '') })));
  }
  return panel('Trust', h('div', { class: 'connect-panel' }, parts));
}

/**
 * Links for a version's provenance (trusted publishing), or null. Built only from fields that
 * pass strict checks, so a stored record can't produce a javascript: or off-site commit link.
 */
function provenanceLinks(prov) {
  if (!prov || typeof prov.url !== 'string' || !/^https:\/\/[^\s/]+\//.test(prov.url)) return null;
  const repoOk = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(prov.repository || '');
  const shaOk = /^[0-9a-f]{7,64}$/.test(prov.sha || '');
  return {
    run: prov.url,
    commit: repoOk && shaOk ? `${new URL(prov.url).origin}/${prov.repository}/commit/${prov.sha}` : null,
    label: `${prov.repository}@${String(prov.sha || '').slice(0, 7)}`,
  };
}

function provenanceCell(prov) {
  const links = provenanceLinks(prov);
  if (!links) return h('span', { class: 'faint', text: '—' });
  const title = `${prov.workflow} · run ${prov.runId}${prov.runAttempt && prov.runAttempt !== '1' ? ` (attempt ${prov.runAttempt})` : ''}${prov.environment ? ` · environment ${prov.environment}` : ''}`;
  // Just the short commit here to keep the table narrow; the trust panel names the repository.
  const commitTitle = `${links.label} · ${prov.ref}`;
  const short = String(prov.sha || '').slice(0, 7);
  return h(
    'span',
    { class: 'built-by' },
    h('a', { href: links.run, rel: 'noopener noreferrer nofollow', target: '_blank', class: 'badge badge-ci', title, text: 'CI' }),
    links.commit ? h('a', { href: links.commit, rel: 'noopener noreferrer nofollow', target: '_blank', title: commitTitle }, h('code', { text: short })) : h('code', { title: commitTitle, text: short }),
  );
}

function reportPanel(p, versions) {
  if (state.local) {
    // citadel-browser only proxies reads; reports go straight to the registry.
    const where = state.local.masterUrl ? `${state.local.masterUrl.replace(/\/+$/, '')}/#/plugin/${encodeURIComponent(p.id)}` : null;
    return panel('Report', h('p', { class: 'hint' }, 'To report this plugin, open it on the registry', where ? [': ', h('span', { class: 'mono', text: where })] : '', '.'));
  }
  const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const reason = h('select', { id: 'report-reason', required: true }, REPORT_REASONS.map(([value, label]) => h('option', { value }, label)));
  const version = h('select', { id: 'report-version' }, h('option', { value: '' }, 'Any or all versions'), versions.map((v) => h('option', { value: v.version }, v.version)));
  const details = h('textarea', { id: 'report-details', rows: '5', minlength: '10', maxlength: '2000', required: true, placeholder: 'What did you find, and where? Links help.' });
  const contact = h('input', { type: 'text', id: 'report-contact', maxlength: '200', autocomplete: 'email', placeholder: 'Optional. Never published.' });
  const submit = h('button', { type: 'submit', class: 'btn btn-sm' }, 'Send report');
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-expanded': 'false', 'aria-controls': 'report-form' }, 'Report this plugin');
  const form = h(
    'form',
    { class: 'report-form', id: 'report-form', hidden: true, novalidate: true },
    h('label', { class: 'field', for: 'report-reason' }, h('span', { text: 'Reason' }), reason),
    h('label', { class: 'field', for: 'report-version' }, h('span', { text: 'Version' }), version),
    h('label', { class: 'field', for: 'report-details' }, h('span', { text: 'Details' }), details),
    h('label', { class: 'field', for: 'report-contact' }, h('span', { text: 'Your contact' }), contact),
    h('div', { class: 'modal-actions' }, submit),
    status,
  );
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) reason.focus();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = details.value.trim();
    if (text.length < 10) {
      status.textContent = 'Describe the problem in at least 10 characters.';
      details.focus();
      return;
    }
    const body = { reason: reason.value, details: text };
    if (contact.value.trim()) body.contact = contact.value.trim();
    if (version.value) body.version = version.value;
    submit.disabled = true;
    status.textContent = 'Sending…';
    try {
      const res = await fetch(`/v1/plugins/${encodeURIComponent(p.id)}/reports`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 202) {
        form.reset();
        form.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        status.textContent = '';
        toast('Report sent to the registry operators. Thank you.');
      } else if (res.status === 429) {
        status.textContent = 'Too many reports from your network. Try again in an hour.';
      } else {
        const j = await res.json().catch(() => null);
        status.textContent = (j && j.error && j.error.message) || `The report was not accepted (${res.status}).`;
      }
    } catch {
      status.textContent = 'Couldn’t reach the registry. Check your connection and try again.';
    } finally {
      submit.disabled = false;
    }
  });
  return panel('Report', h('p', { class: 'hint', text: 'Malware, stolen content, or something else wrong? Reports go to the people who run this registry, not to the publisher.' }), toggle, form);
}

function renderPublisher(view, token, name) {
  view.replaceChildren(h('div', { class: 'skeleton', 'aria-hidden': 'true' }));
  const load = async () => {
    let pub;
    try {
      pub = await api(`/v1/publishers/${encodeURIComponent(name)}`);
    } catch (err) {
      if (token === state.routeToken) view.replaceChildren(h('a', { class: 'back', href: '#/plugins' }, '← All plugins'), errorState(err, load));
      return;
    }
    if (token !== state.routeToken) return;
    document.title = `${pub.name} · OpenCitadel publishers`;
    const active = pub.signingKeys.filter((k) => !k.revokedAt);
    const head = h(
      'header',
      { class: 'panel detail-head' },
      h('p', { class: 'eyebrow', text: 'Publisher' }),
      h('h1', { class: 'page-title', text: pub.name }),
      h('p', { class: 'description', text: `${pub.plugins.length} package${pub.plugins.length === 1 ? '' : 's'} · ${active.length} active signing key${active.length === 1 ? '' : 's'}` }),
    );
    const keys = pub.signingKeys.length
      ? h(
          'ul',
          { class: 'keys' },
          pub.signingKeys.map((k) =>
            h(
              'li',
              { class: `key${k.revokedAt ? ' is-revoked' : ''}` },
              h(
                'div',
                { class: 'key-head' },
                h('code', { class: 'key-id', text: k.keyId }),
                k.label ? h('span', { class: 'key-label', text: k.label }) : null,
                k.revokedAt ? h('span', { class: 'badge badge-password', text: `Revoked ${new Date(k.revokedAt).toLocaleDateString()}` }) : h('span', { class: 'badge badge-verified', text: 'Active' }),
              ),
              h('p', { class: 'hint', text: `Added ${new Date(k.addedAt).toLocaleDateString()}` }),
              copyRow(`minisign -Vm <package>.tgz -P ${k.publicKey}`),
            ),
          ),
        )
      : h('p', { class: 'hint', text: 'This publisher has no signing keys, so their packages are unsigned.' });
    const main = [
      panel(
        'Signing keys',
        h('p', { class: 'hint', text: 'Hosts pin the key a plugin is first installed with. Compare these with what the publisher posts elsewhere (their repository or site) before trusting them.' }),
        keys,
      ),
    ];
    const side = [
      panel(
        'Packages',
        pub.plugins.length
          ? h('ul', { class: 'plain-list' }, pub.plugins.map((id) => h('li', {}, h('a', { href: `#/plugin/${encodeURIComponent(id)}`, text: id }))))
          : h('p', { class: 'hint', text: 'Nothing published yet.' }),
      ),
    ];
    view.replaceChildren(h('div', {}, h('a', { class: 'back', href: '#/plugins' }, '← All plugins'), head, h('div', { class: 'detail' }, h('div', { class: 'detail-main' }, main), h('aside', { class: 'detail-side' }, side))));
  };
  load();
}

async function loadRegistryInfo() {
  try {
    const info = await api('/v1/registry');
    const el = document.getElementById('abuse-contact');
    if (!info || !info.abuseContact || !el) return;
    const contact = info.abuseContact;
    const link = /^https:\/\/\S+$/.test(contact)
      ? h('a', { href: contact, rel: 'noopener noreferrer nofollow', target: '_blank', text: contact })
      : /^[^\s@]+@[^\s@]+$/.test(contact)
        ? h('a', { href: `mailto:${contact}`, text: contact })
        : h('span', { text: contact });
    el.replaceChildren('Takedown and security reports: ', link);
    el.hidden = false;
  } catch {
    /* older masters have no /v1/registry */
  }
}

// ---------------------------------------------------------------- host guide

function renderHost(view, token) {
  const content = document.getElementById('tpl-host').content.cloneNode(true);
  for (const el of content.querySelectorAll('[data-origin]')) el.textContent = state.local && state.local.masterUrl ? state.local.masterUrl : location.origin;
  view.replaceChildren(content);
  api('/v1/stats').then((s) => token === state.routeToken && setTally(s), () => {});
}

// ---------------------------------------------------------------- routing

const ROUTES = [
  [/^#?\/?$/, 'servers', renderServers],
  [/^#\/server\/([^/]+)$/, 'servers', renderServer],
  [/^#\/plugins\/?$/, 'plugins', renderPlugins],
  [/^#\/plugin\/([^/]+)$/, 'plugins', renderPlugin],
  [/^#\/publisher\/([^/]+)$/, 'plugins', renderPublisher],
  [/^#\/host\/?$/, 'host', renderHost],
];

function route() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  const token = ++state.routeToken;
  const hash = location.hash || '#/';
  const view = document.getElementById('view');
  document.title = 'OpenCitadel · Community Servers';
  const dialog = document.getElementById('join-dialog');
  if (dialog.open) dialog.close();
  for (const [pattern, nav, render] of ROUTES) {
    const m = pattern.exec(hash);
    if (!m) continue;
    for (const a of document.querySelectorAll('[data-nav]')) {
      if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    let arg;
    try {
      arg = m[1] !== undefined ? decodeURIComponent(m[1]) : undefined;
    } catch {
      arg = m[1];
    }
    render(view, token, arg);
    if (hash !== '#/' && document.activeElement !== document.getElementById('main')) document.getElementById('main').focus({ preventScroll: true });
    window.scrollTo(0, 0);
    return;
  }
  view.replaceChildren(errorState(Object.assign(new Error('That page does not exist.'), { status: 404 })));
}

async function detectLocal() {
  try {
    const res = await fetch('/local/info', { headers: { accept: 'application/json' } });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;
    state.local = await res.json();
    document.getElementById('local-banner').hidden = false;
    try {
      const fav = await api('/local/favorites');
      state.favorites = new Set(fav.ids || []);
    } catch {
      /* favorites optional */
    }
  } catch {
    /* not running locally */
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const search = document.querySelector('input[type="search"]');
  if (search) {
    e.preventDefault();
    search.focus();
  }
});

window.addEventListener('hashchange', route);
detectLocal().finally(() => {
  route();
  loadRegistryInfo();
});
