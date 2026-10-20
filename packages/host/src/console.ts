/**
 * The interactive console of `citadel-host start`: host commands, plugin `!commands`, and
 * anything else forwarded to the game server.
 */

import { createInterface } from 'node:readline';
import type { Supervisor } from './supervisor.js';

const HELP = [
  'Host console:',
  '  status            show server state',
  '  restart           restart the game server',
  '  reload [plugin]   reload one plugin, or all',
  '  quit              stop the server and exit',
  '  !<command> …      run a plugin chat command as the console (admin)',
  '  anything else     sent to the server console (via the bridge or RCON)',
].join('\n');

export function describeState(sup: Supervisor): string {
  const s = sup.getState();
  const humans = s.players.filter((p) => !p.bot);
  const sources = Object.entries(s.sources)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(', ') || 'none';
  return [
    `phase:   ${s.phase}`,
    `name:    ${s.hostname}`,
    `map:     ${s.map ?? '-'}`,
    `steamid: ${s.steamId ?? '- (not seen yet)'}`,
    ...(s.address ? [`address: ${s.address}`] : []),
    `players: ${humans.length}/${s.maxPlayers}${humans.length ? ' — ' + humans.map((p) => p.name).join(', ') : ''}`,
    `sources: ${sources}`,
  ].join('\n');
}

/** Attaches the console to `input`. Returns a function that detaches it. */
export function attachHostConsole(sup: Supervisor, input: NodeJS.ReadableStream, print: (text: string) => void, onQuit: () => void): () => void {
  const rl = createInterface({ input, terminal: false });
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return;
    const [word, ...rest] = line.split(/\s+/);
    const fail = (err: unknown) => print(`error: ${(err as Error).message}`);
    switch (word!.toLowerCase()) {
      case 'help':
      case '?':
        print(HELP);
        return;
      case 'status':
        print(describeState(sup));
        return;
      case 'quit':
      case 'exit':
      case 'stop':
        onQuit();
        return;
      case 'restart':
        sup.restart('from the console').catch(fail);
        return;
      case 'reload':
        sup.pluginHost
          .reload(rest[0])
          .then(() => print(rest[0] ? `Reloaded ${rest[0]}.` : 'Reloaded all plugins.'))
          .catch(fail);
        return;
    }
    if (line.startsWith('!')) {
      sup.pluginHost
        .runConsoleCommand(line)
        .then((handled) => handled || print(`No plugin handles ${word}.`))
        .catch(fail);
      return;
    }
    sup.services
      .command(line)
      .then((out) => out.trim() && print(out.trimEnd()))
      .catch(fail);
  });
  return () => rl.close();
}
