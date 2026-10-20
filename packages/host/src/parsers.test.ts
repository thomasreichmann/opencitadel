import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteam3, toSteam64 } from '@opencitadel/protocol';
import { isConsoleNoise, parseDuration, parseLogLine, parseStatus, playerSteamId } from './parsers.js';

const CS2_STATUS = `Server:  Running [0.0.0.0:27015]
Client:  Disconnected
Source TV:  Not Active
@ Current  :  game
source   : console
hostname : My Server
spawn    : 1
version  : 1.40.2.0/14020 9842 secure  public
steamid  : [A:1:3967737862:28938] (90198434620252166)
udp/ip   : 0.0.0.0:27015 (public ip: 203.0.113.5)
os/type  : Windows dedicated
players  : 1 humans, 0 bots (12 max) (not hibernating) (unreserved)
loaded spawngroup(  1)  : SV:  [1: dl_midtown | main lump | mapload]

---------players--------
  id     time ping loss      state   rate adr name
65535 [NoChan]    0    0 challenging      0unknown ''
    2    01:02   35    0     active 786432 198.51.100.7:27005 'PlayerOne'
#end
`;

const SOURCE1_STATUS = `hostname: Old School
version : 1.38.0.0/13800 1234 secure
udp/ip  : 10.0.0.5:27015  (public ip: 198.51.100.1)
steamid : [G:1:1234567] (85568392921304519)
map     : dl_streets at: 0 x, 0 y, 0 z
players : 2 humans, 1 bots (16/0 max) (not hibernating)

# userid name uniqueid connected ping loss state rate adr
#      2 "Alice" STEAM_1:1:4491 1:01:02 45 0 active 196608 198.51.100.7:27005
#  3 1 "Bob 'the' Builder" [U:1:22202] 00:10 80 2 active 196608 198.51.100.8:27005
#      4 "Botty" BOT active 64
#end
`;

test('parses CS2-style status', () => {
  const s = parseStatus(CS2_STATUS);
  assert.equal(s.hostname, 'My Server');
  assert.equal(s.map, 'dl_midtown');
  assert.equal(s.steamId, '[A:1:3967737862:28938]');
  assert.equal(s.steamId64, '90198434620252166');
  assert.equal(s.publicIp, '203.0.113.5');
  assert.equal(s.localAddress, '0.0.0.0:27015');
  assert.equal(s.humans, 1);
  assert.equal(s.maxPlayers, 12);
  assert.deepEqual(s.players, [{ id: 2, name: 'PlayerOne', time: 62, ping: 35, loss: 0, state: 'active', address: '198.51.100.7:27005' }]);
});

test('parses Source 1 style status', () => {
  const s = parseStatus(SOURCE1_STATUS.replace(/\n/g, '\r\n'));
  assert.equal(s.hostname, 'Old School');
  assert.equal(s.map, 'dl_streets');
  assert.equal(s.steamId, '[G:1:1234567]');
  assert.equal(s.maxPlayers, 16);
  assert.equal(s.bots, 1);
  assert.equal(s.players.length, 3);
  assert.deepEqual(s.players[0], { id: 2, name: 'Alice', steamId: '[U:1:8983]', steamId64: '76561197960274711', time: 3662, ping: 45, loss: 0, state: 'active', address: '198.51.100.7:27005' });
  assert.equal(s.players[1]!.name, "Bob 'the' Builder");
  assert.equal(s.players[1]!.steamId, '[U:1:22202]');
  assert.equal(s.players[1]!.id, 3);
  assert.equal(s.players[2]!.bot, true);
});

test('status edge cases', () => {
  assert.deepEqual(parseStatus('').players, []);
  // Names containing quotes and bots in the Source 2 table.
  const s = parseStatus(`---------players--------\n  id     time ping loss      state   rate adr name\n    3      BOT    0    0     active      0 'Bot Haze'\n    4    10:00   20    0     active 786432 1.2.3.4:27005 'It's me'\n#end`);
  assert.equal(s.players.length, 2);
  assert.equal(s.players[0]!.bot, true);
  assert.equal(s.players[1]!.name, "It's me");
  assert.equal(s.players[1]!.time, 600);
  assert.equal(parseDuration('nope'), undefined);
});

test('log lines', () => {
  const anon = { kind: 'steamId', steamId: '[A:1:3967737862:28938]' };
  // The lines Deadlock prints (as recorded in Deadworks' launcher tests).
  assert.deepEqual(parseLogLine('SV:  ServerSteamID=[A:1:3967737862:28938] (90196284278759430).'), anon);
  assert.deepEqual(parseLogLine('Gameserver logged on to Steam, assigned identity steamid:90196284278759430\r'), anon);
  assert.deepEqual(parseLogLine('SV:  Assigned anonymous gameserver Steam ID [A:1:3967737862:28938].'), anon);
  const gslt = toSteam64(parseSteam3('[G:1:1234567]')!);
  assert.deepEqual(parseLogLine(`Gameserver logged on to Steam, assigned identity steamid:${gslt}`), { kind: 'steamId', steamId: '[G:1:1234567]' });
  // A player's own id is not the server's.
  assert.equal(parseLogLine('Gameserver logged on to Steam, assigned identity steamid:76561197960287930'), undefined);
});

// RCON `status` from a live Deadlock dedicated server (build 6796, empty and hibernating). The
// public address is replaced with a documentation address.
const DEADLOCK_STATUS = `Server:  Running [127.0.0.1:27015]
Client:  Disconnected
----- Status -----
@ Current  :  game
source   : console
hostname : OpenCitadel live test
spawn    : 1
version  : 48/48 10931 insecure  public
steamid  : [A:1:4085873681:51989] (90295287688035345)
udp/ip   : 127.0.0.1:27015 (public 203.0.113.5:27015)
os/type  : Windows dedicated
players  : 0 humans, 0 bots (0 max) (hibernating) (unreserved)
---------spawngroups----
loaded spawngroup(  1)  : SV:  [1: dl_midtown | main lump | mapload]
---------players--------
  id     time ping loss      state   rate adr name
Citadel Specific
===========================
Game State: 1 (Init)
#end
`;

test('real Deadlock status output (build 6796)', () => {
  const s = parseStatus(DEADLOCK_STATUS);
  assert.equal(s.hostname, 'OpenCitadel live test');
  assert.equal(s.map, 'dl_midtown');
  assert.equal(s.steamId, '[A:1:4085873681:51989]');
  assert.equal(s.steamId64, '90295287688035345');
  assert.equal(s.publicIp, '203.0.113.5');
  assert.equal(s.humans, 0);
  // An idle server reports "(0 max)"; the supervisor keeps the configured maximum in that case.
  assert.equal(s.maxPlayers, 0);
  assert.deepEqual(s.players, [], 'the "Citadel Specific" footer is not a player row');
});

test('real Deadlock status with a player connected over SDR (build 6796)', () => {
  const withPlayer = DEADLOCK_STATUS.replace('players  : 0 humans, 0 bots (0 max) (hibernating)', 'players  : 1 humans, 0 bots (0 max) (not hibernating)')
    .replace("  id     time ping loss      state   rate adr name\n", "  id     time ping loss      state   rate adr name\n   0    00:15    0    0     active 196608 [U:1:22202]:0 'Alice'\n")
    .replace('Game State: 1 (Init)', 'Game State: 7 (GameInProgress)');
  const s = parseStatus(withPlayer);
  assert.equal(s.humans, 1);
  assert.deepEqual(s.players, [{ id: 0, name: 'Alice', time: 15, ping: 0, loss: 0, state: 'active', steamId: '[U:1:22202]', steamId64: '76561197960287930' }]);
});

test('real Deadlock console lines (build 6796, captured from a live dedicated server)', () => {
  const live = { kind: 'steamId', steamId: '[A:1:3520943121:51989]' };
  assert.deepEqual(parseLogLine('10/19 23:56:49 [Server] SV:  ServerSteamID=[A:1:3520943121:51989] (90295287123104785).'), live);
  assert.deepEqual(parseLogLine('10/19 23:56:49 [SteamNetSockets] Gameserver logged on to Steam, assigned identity steamid:90295287123104785'), live);
  assert.deepEqual(parseLogLine('10/19 23:56:48 [Server] SV:  Spawn Server: dl_midtown'), { kind: 'map', map: 'dl_midtown' });
  assert.deepEqual(parseLogLine('10/19 23:56:47 Loading map "dl_midtown"'), { kind: 'map', map: 'dl_midtown' });
  // A second fake prefix inside the line is not stripped.
  assert.equal(parseLogLine('10/19 23:56:49 [Server] [Server] SV:  ServerSteamID=[A:1:3520943121:51989] (90295287123104785).'), undefined);
  assert.equal(parseLogLine('10/19 23:56:49 [Server] x SV:  ServerSteamID=[A:1:3520943121:51989] (90295287123104785).'), undefined);
});

test('match phases and console noise (build 6796)', () => {
  assert.deepEqual(parseLogLine('10/20 00:53:10 ChangeGameState: PostGame (8)'), { kind: 'gameState', state: 'PostGame', id: 8 });
  assert.deepEqual(parseLogLine('10/20 00:53:20 ChangeGameState: End (11)\r'), { kind: 'gameState', state: 'End', id: 11 });
  // Whole-line only, so a player name can't end the match.
  assert.equal(parseLogLine('Player [0]ChangeGameState: PostGame (8) changing team 0->2 in game mode 0')?.kind, undefined);
  assert.equal(parseLogLine('10/20 00:53:10 [All Chat][Alice (0)]: ChangeGameState: PostGame (8)'), undefined);
  assert.equal(parseLogLine('10/20 00:53:10 [Server] ChangeGameState: PostGame (8) gg'), undefined);
  assert.ok(isConsoleNoise('10/20 00:09:53 CTextConsoleWin::GetLine: !GetNumberOfConsoleInputEvents'));
  assert.ok(isConsoleNoise('CTextConsoleWin::GetLine: !GetNumberOfConsoleInputEvents\r'));
  assert.ok(!isConsoleNoise('10/20 00:09:53 [Server] SV:  Spawn Server: dl_midtown'));
});

test('player names cannot spoof the server SteamID', () => {
  for (const line of [
    // Names start some engine lines and sit inside others; none of these may set the SteamID.
    'Player [0]ServerSteamID=[A:1:5:5] changing team 0->3 in game mode 0',
    'ServerSteamID=[A:1:5:5] connected',
    '[A:1:5:5] changed name',
    '"[A:1:5:5]<2><[U:1:10]><Amber>" say "Steam ID [A:1:5:5]"',
    // The two forms disagree.
    'SV:  ServerSteamID=[A:1:5:5] (90198434620252166).',
    'SV:  ServerSteamID=[A:1:5;quit:5]',
    'x SV:  Assigned anonymous gameserver Steam ID [A:1:5:5].',
  ]) {
    assert.notEqual(parseLogLine(line)?.kind, 'steamId', line);
  }
  assert.deepEqual(parseLogLine('loaded spawngroup(  1)  : SV:  [1: dl_midtown | main lump | mapload]'), { kind: 'map', map: 'dl_midtown' });
  assert.deepEqual(parseLogLine('SV:  Spawn Server: street_test'), { kind: 'map', map: 'street_test' });
  assert.deepEqual(parseLogLine('L 10/19/2026 - 20:00:00: Started map "dl_hideout" (CRC "0")'), { kind: 'map', map: 'dl_hideout' });
  assert.deepEqual(parseLogLine('L 10/19/2026 - 20:00:00: "Alice<2><[U:1:22202]><Amber>" say "!rtv now"'), {
    kind: 'chat', name: 'Alice', userId: 2, steamId: '[U:1:22202]', team: 'Amber', message: '!rtv now', teamOnly: false,
  });
  assert.deepEqual(parseLogLine('"Bob<3><STEAM_1:0:5><>" say_team "push mid"'), { kind: 'chat', name: 'Bob', userId: 3, steamId: '[U:1:10]', message: 'push mid', teamOnly: true });
  assert.deepEqual(parseLogLine('"Bob<3><[U:1:10]><>" connected, address "1.2.3.4:27005"'), { kind: 'connected', name: 'Bob', userId: 3, steamId: '[U:1:10]', address: '1.2.3.4:27005' });
  assert.deepEqual(parseLogLine('"Bob<3><[U:1:10]><Sapphire>" disconnected (reason "Disconnect")'), { kind: 'disconnected', name: 'Bob', userId: 3, steamId: '[U:1:10]', reason: 'Disconnect' });
  assert.equal(parseLogLine('Some unrelated engine spew'), undefined);
});

test('player steam ids', () => {
  assert.equal(playerSteamId('STEAM_0:1:4491'), '[U:1:8983]');
  assert.equal(playerSteamId('[U:1:22202]'), '[U:1:22202]');
  assert.equal(playerSteamId('BOT'), undefined);
  assert.equal(playerSteamId('[A:1:1:1]'), undefined);
});
