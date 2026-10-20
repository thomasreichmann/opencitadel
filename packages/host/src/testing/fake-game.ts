#!/usr/bin/env node
/**
 * A stand-in for `deadlock.exe -dedicated`, for tests and end-to-end runs without the game.
 *
 * Launch it through the host's wrapper setting: `"wrapper": ["node", "<dist>/testing/fake-game.js"]`
 * (add `"--fake-bridge"` to also impersonate the OpenCitadel.Bridge Deadworks plugin). It receives
 * the exe path and the real server flags, runs from game/bin/win64 of a fake install, and:
 *  - prints (and with -condebug appends to citadel/console.log) realistic startup lines, including
 *    a fresh anonymous `[A:1:…:…]` Steam ID and the map load;
 *  - serves Source RCON on TCP 127.0.0.1:<hostport> when -usercon and rcon_password are set
 *    (status, say, map, kick, kickid, quit, echo; `changelevel` exits with code 5 like the real
 *    server; test hooks _crash, _chat, _join, _leave, _endmatch);
 *  - prints the real server's per-frame stdin noise line every 50 ms;
 *  - answers A2S_INFO on UDP 127.0.0.1:<hostport>;
 *  - with --fake-bridge / FAKE_BRIDGE=1, connects to OPENCITADEL_BRIDGE and plays a script:
 *    player.connected (BridgeBob), chat.message "!help", player.disconnected.
 *
 * Environment: FAKE_PLAYERS (comma-separated names, default "PlayerOne"), FAKE_CRASH_AFTER_MS,
 * FAKE_RCON_MIRROR=0 (ignore the RCON end-of-response sentinel), FAKE_BRIDGE_DELAY_MS (default 300),
 * FAKE_BRIDGE_LEAVE=0 (keep BridgeBob connected).
 */

import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, connect, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePackets, encodePacket } from '../rcon.js';

interface FakePlayer {
  slot: number;
  name: string;
  steamId64: string;
  connectedAt: number;
  address: string;
  team?: number;
  hero?: string;
}

interface Options {
  usercon: boolean;
  condebug: boolean;
  port: number;
  map: string;
  execs: string[];
  maxPlayers: number;
  fakeBridge: boolean;
}

export function parseFakeArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  const fakeBridge = argv.includes('--fake-bridge') || env.FAKE_BRIDGE === '1';
  const args = argv.filter((a) => a !== '--fake-bridge');
  const o: Options = { usercon: false, condebug: false, port: 27015, map: 'dl_midtown', execs: [], maxPlayers: 12, fakeBridge };
  let i = args[0] && !/^[-+]/.test(args[0]) ? 1 : 0; // skip the exe path
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-usercon') o.usercon = true;
    else if (a === '-condebug') o.condebug = true;
    else if (a === '-maxplayers') o.maxPlayers = Number(args[++i]);
    else if (a === '+hostport') o.port = Number(args[++i]);
    else if (a === '+map') o.map = args[++i]!;
    else if (a === '+exec') o.execs.push(args[++i]!);
    else if (a.startsWith('+')) i++;
  }
  return o;
}

function main(): void {
  const env = process.env;
  const opts = parseFakeArgs(process.argv.slice(2), env);
  const citadel = resolve(process.cwd(), '..', '..', 'citadel');
  const consoleLog = join(citadel, 'console.log');
  const cvars: Record<string, string> = { hostname: 'Deadlock', sv_password: '', rcon_password: '' };
  for (const file of opts.execs) {
    const path = join(citadel, 'cfg', file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*(\w+)\s+"([^"]*)"/.exec(line);
      if (m) cvars[m[1]!] = m[2]!;
    }
  }

  let map = opts.map;
  const account = 1_000_000_000 + Math.floor(Math.random() * 3_000_000_000);
  const instance = 1 + Math.floor(Math.random() * 99_998);
  const steamId = `[A:1:${account}:${instance}]`;
  const steamId64 = ((1n << 56n) | (4n << 52n) | (BigInt(instance) << 32n) | BigInt(account)).toString();
  const players: FakePlayer[] = (env.FAKE_PLAYERS ?? 'PlayerOne')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name, i) => ({ slot: 2 + i, name, steamId64: String(76561198000000000n + BigInt(2 + i)), connectedAt: Date.now() - 62_000, address: `198.51.100.${7 + i}:27005` }));

  // Like the real server: `10/19 23:56:49 [Server] SV:  …` (the channel tag is on most lines, not all).
  const log = (line: string, channel?: string) => {
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
    const full = `${stamp} ${channel ? `[${channel}] ` : ''}${line}`;
    process.stdout.write(full + '\n');
    if (opts.condebug) appendFileSync(consoleLog, full + '\r\n');
  };

  const fmtTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const status = () =>
    [
      'Server:  Running [0.0.0.0:' + opts.port + ']',
      'Client:  Disconnected',
      'Source TV:  Not Active',
      '@ Current  :  game',
      'source   : console',
      `hostname : ${cvars.hostname}`,
      'spawn    : 1',
      'version  : 1.0.0.0/10000 1 secure  public',
      `steamid  : ${steamId} (${steamId64})`,
      `udp/ip   : 0.0.0.0:${opts.port} (public 203.0.113.5:${opts.port})`,
      'os/type  : Windows dedicated',
      `players  : ${players.length} humans, 0 bots (${opts.maxPlayers} max) (not hibernating) (unreserved)`,
      `loaded spawngroup(  1)  : SV:  [1: ${map} | main lump | mapload]`,
      '',
      '---------players--------',
      '  id     time ping loss      state   rate adr name',
      "65535 [NoChan]    0    0 challenging      0unknown ''",
      ...players.map((p) => `${String(p.slot).padStart(5)}    ${fmtTime(Date.now() - p.connectedAt)}   35    0     active 786432 ${p.address} '${p.name}'`),
      '#end',
      '',
    ].join('\n');

  const loadMap = (name: string) => {
    map = name;
    log(`SV:  Spawn Server: ${name}`, 'Server');
    log(`loaded spawngroup(  1)  : SV:  [1: ${name} | main lump | mapload]`);
  };

  const removePlayer = (pred: (p: FakePlayer) => boolean, reason: string): FakePlayer | undefined => {
    const idx = players.findIndex(pred);
    if (idx === -1) return undefined;
    const [p] = players.splice(idx, 1);
    log(`Dropped ${p!.name} from server: ${reason}`);
    return p;
  };

  const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');

  const run = (command: string): string => {
    const [word = '', ...rest] = command.trim().split(/\s+/);
    const arg = command.trim().slice(word.length).trim();
    switch (word.toLowerCase()) {
      case 'status':
        return status();
      case 'say':
        log(`[All Chat][Console (0)]: ${unquote(arg)}`);
        return '';
      // A real stock server dies during the level load after `changelevel` (build 6796).
      case 'changelevel':
        if (!rest[0]) return 'usage: changelevel <map>';
        log(`SV:  Level loading started for '${rest[0]}'`, 'Server');
        setTimeout(() => process.exit(5), 10);
        return `Changelevel to ${rest[0]}`;
      case 'map':
        if (!rest[0]) return 'usage: map <map>';
        setTimeout(() => loadMap(rest[0]!), 10);
        return '';
      case 'kick':
        return removePlayer((p) => p.name.toLowerCase() === unquote(arg).toLowerCase(), 'Kicked by Console') ? '' : `No player named ${unquote(arg)}`;
      case 'kickid': {
        const slot = Number(rest[0]);
        return removePlayer((p) => p.slot === slot, unquote(rest.slice(1).join(' ')) || 'Kicked by Console') ? '' : `No player with userid ${slot}`;
      }
      case 'quit':
        log('Shutting down (quit).');
        setTimeout(() => process.exit(0), 50);
        return 'Shutting down';
      case 'echo':
        return arg;
      case '_crash':
        setTimeout(() => process.exit(1), 10);
        return '';
      case '_chat': {
        const [name = 'PlayerOne', ...words] = rest;
        const p = players.find((x) => x.name === name);
        log(`L 10/19/2026 - 20:00:00: "${name}<${p?.slot ?? 9}><[U:1:${p ? Number(BigInt(p.steamId64) & 0xffffffffn) : 1}]><Amber>" say "${words.join(' ')}"`);
        return '';
      }
      case '_join': {
        const name = rest[0] ?? 'Newcomer';
        const slot = Math.max(1, ...players.map((p) => p.slot)) + 1;
        players.push({ slot, name, steamId64: String(76561198000000000n + BigInt(slot)), connectedAt: Date.now(), address: `198.51.100.${50 + slot}:27005` });
        return '';
      }
      case '_leave':
        return removePlayer((p) => p.name === rest[0], 'Disconnect') ? '' : `No player named ${rest[0]}`;
      case '_endmatch':
        log('Citadel: Bosses killed, triggering victory condition');
        log('Shutting down match - game over', 'Server');
        log('ChangeGameState: PostGame (8)');
        setTimeout(() => log('ChangeGameState: End (11)'), 100);
        return '';
      default:
        return `Unknown command "${word}"`;
    }
  };

  // ---- startup lines
  log('Source2Main: fake Deadlock dedicated server (OpenCitadel test double)');
  // The two SteamID lines Deadlock really prints (as recorded in Deadworks' launcher tests).
  setTimeout(() => log(`Gameserver logged on to Steam, assigned identity steamid:${steamId64}`, 'SteamNetSockets'), 40);
  setTimeout(() => log(`SV:  ServerSteamID=${steamId} (${steamId64}).`, 'Server'), 60);
  setTimeout(() => {
    loadMap(map);
    for (const [i, state] of ['WaitingForPlayersToJoin', 'HeroSelection', 'MatchIntro', 'WaitForMapToLoad', 'PreGameWait', 'GameInProgress'].entries()) {
      log(`ChangeGameState: ${state} (${i + 2})`);
    }
  }, 80);
  // The real server prints this every frame, since its stdin is never a console under the host.
  const noise = setInterval(() => log('CTextConsoleWin::GetLine: !GetNumberOfConsoleInputEvents'), 50);
  noise.unref();

  // ---- RCON
  if (opts.usercon && cvars.rcon_password) {
    const mirror = env.FAKE_RCON_MIRROR !== '0';
    createServer((sock: Socket) => {
      let buf: Buffer = Buffer.alloc(0);
      let authed = false;
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let packets;
        try {
          ({ packets, rest: buf } = decodePackets(buf));
        } catch {
          return sock.destroy();
        }
        for (const p of packets) {
          if (p.type === 3) {
            authed = p.body === cvars.rcon_password;
            sock.write(encodePacket(p.id, 0, ''));
            sock.write(encodePacket(authed ? p.id : -1, 2, ''));
          } else if (!authed) {
            sock.destroy();
          } else if (p.type === 2) {
            const out = run(p.body);
            sock.write(encodePacket(p.id, 0, out));
          } else if (p.type === 0 && mirror) {
            sock.write(encodePacket(p.id, 0, ''));
          }
        }
      });
    }).listen(opts.port, '127.0.0.1');
  }

  // ---- A2S_INFO
  const udp = createSocket('udp4');
  const challenge = Buffer.from([0x4f, 0x43, 0x21, 0x07]);
  udp.on('message', (msg, rinfo) => {
    if (msg.length < 25 || msg.readInt32LE(0) !== -1 || msg[4] !== 0x54) return;
    if (!msg.subarray(25, 29).equals(challenge)) {
      udp.send(Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), challenge]), rinfo.port, rinfo.address);
      return;
    }
    const s = (x: string) => Buffer.from(x + '\0', 'utf8');
    const port = Buffer.alloc(2);
    port.writeUInt16LE(opts.port);
    const sid = Buffer.alloc(8);
    sid.writeBigUInt64LE(BigInt(steamId64));
    const gid = Buffer.alloc(8);
    gid.writeBigUInt64LE(1422450n);
    udp.send(
      Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
        s(cvars.hostname!), s(map), s('citadel'), s('Deadlock'),
        Buffer.from([0, 0, players.length, opts.maxPlayers, 0, 0x64, 0x77, cvars.sv_password ? 1 : 0, 0]),
        s('1.0.0.0'),
        Buffer.from([0x80 | 0x10 | 0x01]), port, sid, gid,
      ]),
      rinfo.port,
      rinfo.address,
    );
  });
  udp.on('error', () => {});
  udp.bind(opts.port, '127.0.0.1');

  // ---- fake OpenCitadel.Bridge
  if (opts.fakeBridge && env.OPENCITADEL_BRIDGE) {
    const [host, portText] = env.OPENCITADEL_BRIDGE.split(':');
    const delay = Number(env.FAKE_BRIDGE_DELAY_MS ?? 300);
    const bob: FakePlayer = { slot: 9, name: 'BridgeBob', steamId64: '76561197960287930', connectedAt: Date.now(), address: '198.51.100.99:27005', team: 2, hero: 'Haze' };
    const bobData = () => ({ slot: bob.slot, name: bob.name, steamId64: bob.steamId64, team: bob.team, hero: bob.hero });
    const sock = connect(Number(portText), host!);
    const send = (m: object) => sock.write(JSON.stringify(m) + '\n');
    let inbox = '';
    sock.on('error', () => {});
    sock.on('connect', () => send({ type: 'hello', token: env.OPENCITADEL_BRIDGE_TOKEN ?? '', bridge: '0.1.0-fake', deadworks: '0.0.0-fake', map }));
    sock.on('data', (chunk) => {
      inbox += chunk.toString('utf8');
      let nl: number;
      while ((nl = inbox.indexOf('\n')) !== -1) {
        const line = inbox.slice(0, nl);
        inbox = inbox.slice(nl + 1);
        let msg: { type?: string; id?: number; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'welcome') {
          setTimeout(() => {
            players.push(bob);
            send({ type: 'event', name: 'player.connected', data: bobData() });
          }, delay);
          setTimeout(() => send({ type: 'event', name: 'chat.message', data: { ...bobData(), message: '!help', teamOnly: false } }), delay * 2);
          if (env.FAKE_BRIDGE_LEAVE !== '0') {
            setTimeout(() => {
              removePlayer((p) => p === bob, 'Disconnect by user');
              send({ type: 'event', name: 'player.disconnected', data: { ...bobData(), reason: 'Disconnect by user' } });
            }, delay * 4);
          }
        } else if (msg.type === 'ping') {
          send({ type: 'pong' });
        } else if (msg.type === 'request') {
          const p = msg.params ?? {};
          const reply = (result: unknown) => send({ type: 'response', id: msg.id, ok: true, result });
          switch (msg.method) {
            case 'say':
              log(`[All Chat][Console (0)]: ${String(p.message)}`);
              reply(null);
              break;
            case 'tell':
              log(`[Private to ${String(p.slot)}]: ${String(p.message)}`);
              reply(null);
              break;
            case 'kick':
              removePlayer((x) => x.slot === p.slot, String(p.reason || 'Kicked'));
              reply(null);
              break;
            case 'command':
              reply(run(String(p.command ?? '')));
              break;
            case 'players':
              reply(players.map((x) => ({ slot: x.slot, name: x.name, steamId64: x.steamId64, team: x.team ?? 2, hero: x.hero ?? '', bot: false })));
              break;
            default:
              send({ type: 'response', id: msg.id, ok: false, error: `unknown method ${String(msg.method)}` });
          }
        }
      }
    });
  }

  const crashAfter = Number(env.FAKE_CRASH_AFTER_MS);
  if (crashAfter > 0) {
    setTimeout(() => {
      log('FATAL: fake crash');
      process.exit(1);
    }, crashAfter);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
