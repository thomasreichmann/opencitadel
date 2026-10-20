import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { gameLayout } from '@opencitadel/gamefiles';
import { parseHostConfig } from './config.js';
import { CFG_NAME, buildServerArgs, buildServerCfg, cfgQuote, planLaunch } from './launch.js';

test('server args follow the documented order, map last', () => {
  const config = parseHostConfig({ rcon: { password: 'pw' }, game: { port: 27020, map: 'dl_streets' } });
  const args = buildServerArgs(config);
  assert.deepEqual(args.slice(0, 6), ['-dedicated', '-console', '-dev', '-insecure', '-allow_no_lobby_connect', '-usercon']);
  assert.ok(!args.includes('-condebug'), 'the log comes from stdout by default');
  assert.ok(!args.includes('-maxplayers'));
  assert.deepEqual(args.slice(args.indexOf('+hostport'), args.indexOf('+hostport') + 4), ['+hostport', '27020', '+exec', CFG_NAME]);
  assert.deepEqual(args.slice(-2), ['+map', 'dl_streets']);
  assert.ok(!args.join(' ').includes('pw'), 'the RCON password never reaches the command line');
});

test('optional flags', () => {
  const config = parseHostConfig({ rcon: { enabled: false, password: 'pw' }, game: { maxPlayers: 24, logSource: 'condebug', extraArgs: ['+sv_cheats', '1'] } });
  const args = buildServerArgs(config);
  assert.ok(!args.includes('-usercon'));
  assert.ok(args.includes('-condebug'));
  assert.deepEqual(args.slice(args.indexOf('-maxplayers'), args.indexOf('-maxplayers') + 2), ['-maxplayers', '24']);
  assert.deepEqual(args.slice(-4), ['+sv_cheats', '1', '+map', 'dl_midtown']);
});

test('RCON is pinned to loopback unless the admin chooses a bind address', () => {
  const args = buildServerArgs(parseHostConfig({}));
  assert.equal(args[args.indexOf('+ip') + 1], '127.0.0.1');
  assert.ok(args.indexOf('+ip') < args.indexOf('+map'));
  const custom = buildServerArgs(parseHostConfig({ game: { extraArgs: ['-ip', '0.0.0.0'] } }));
  assert.equal(custom.filter((a) => a === '+ip').length, 0);
  assert.equal(custom[custom.indexOf('-ip') + 1], '0.0.0.0');
});

test('cfg escapes values so they cannot inject commands', () => {
  assert.equal(cfgQuote('a"b\nquit\r'), '"abquit"');
  const config = parseHostConfig({
    name: 'Evil"; rcon_password "x',
    game: { password: 'p w', convars: { sv_cheats: '0', citadel_trooper_spawn_enabled: 'true"\nquit' } },
    rcon: { password: 'secret' },
  });
  const cfg = buildServerCfg(config);
  const lines = cfg.trim().split('\n');
  assert.equal(lines[1], 'hostname "Evil; rcon_password x"');
  assert.equal(lines[2], 'sv_password "p w"');
  assert.equal(lines[3], 'rcon_password "secret"');
  assert.equal(lines[5], 'citadel_trooper_spawn_enabled "truequit"');
  assert.equal(lines.length, 6, 'no line was injected');
  assert.ok(buildServerCfg(parseHostConfig({ rcon: { enabled: false, password: 'secret' } })).includes('rcon_password ""'));
});

test('launch plan: exe, wrapper, cwd, bridge env', () => {
  const layout = gameLayout('/games/Deadlock');
  const plain = planLaunch(parseHostConfig({}), layout);
  assert.equal(plain.command, layout.exe);
  assert.equal(plain.cwd, layout.binDir);
  assert.equal(plain.cfgPath, join(layout.citadelDir, 'cfg', CFG_NAME));
  assert.deepEqual(plain.env, {});

  const wine = planLaunch(parseHostConfig({ game: { executable: 'deadworks', wrapper: ['wine', '--debug'] } }), layout, { port: 27100, token: 't0k' });
  assert.equal(wine.command, 'wine');
  assert.deepEqual(wine.args.slice(0, 3), ['--debug', layout.deadworksExe, '-dedicated']);
  assert.deepEqual(wine.env, { OPENCITADEL_BRIDGE: '127.0.0.1:27100', OPENCITADEL_BRIDGE_TOKEN: 't0k' });
});
