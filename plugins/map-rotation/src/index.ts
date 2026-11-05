import { definePlugin, type Player } from '@opencitadel/plugin-sdk';

export interface RotationConfig {
  maps: string[];
  emptyMinutes: number;
  /** Where an empty server goes after emptyMinutes, instead of the next map: the map newcomers should start on. */
  emptyMap?: string;
  intervalMinutes: number;
  rtvRatio: number;
  afterMatch: boolean;
}

const MAP_NAME = /^[A-Za-z0-9_]+$/;
const MINUTE = 60_000;

/** The map after `current` in `maps`; falls back to the stored position when `current` is not in the list. */
export function nextMap(maps: readonly string[], current: string | undefined, storedIndex: number): string | undefined {
  if (!maps.length) return undefined;
  const at = current ? maps.indexOf(current) : -1;
  const next = maps[((at !== -1 ? at : storedIndex) + 1) % maps.length]!;
  return next === current ? undefined : next;
}

export default definePlugin<RotationConfig>({
  setup(ctx) {
    const maps = ctx.config.maps.filter((m) => {
      if (MAP_NAME.test(m)) return true;
      ctx.log.warn(`Ignoring invalid map name "${m}"`);
      return false;
    });
    let emptyMap = ctx.config.emptyMap || undefined;
    if (emptyMap && !MAP_NAME.test(emptyMap)) {
      ctx.log.warn(`Ignoring invalid emptyMap "${emptyMap}"`);
      emptyMap = undefined;
    }
    const votes = new Set<string>();
    let now = Date.now();
    let emptySince: number | undefined;
    let rotatedWhileEmpty = false;
    let lastChange = now;
    let announced = false;
    let changing = false;

    const humans = () => ctx.server.state.players.filter((p) => !p.bot);
    const voter = (p: Player) => p.steamId ?? p.steamId64 ?? p.name;
    const upcoming = () => nextMap(maps, ctx.server.state.map, ctx.storage.get<number>('index') ?? -1);
    const publishNext = () => ctx.listing.setMetadata('nextMap', upcoming());

    const changeTo = async (map: string, reason: string) => {
      if (changing) return;
      changing = true;
      try {
        ctx.log.info(`Changing map to ${map} (${reason})`);
        await ctx.server.changeMap(map);
        const idx = maps.indexOf(map);
        if (idx !== -1) ctx.storage.set('index', idx);
        votes.clear();
        lastChange = now;
        announced = false;
      } finally {
        changing = false;
      }
    };

    ctx.on('tick', async ({ now: t }) => {
      now = t;
      if (ctx.server.state.phase !== 'running') return;
      const next = upcoming();
      if (humans().length === 0) {
        emptySince ??= t;
        const target = emptyMap ? (emptyMap !== ctx.server.state.map ? emptyMap : undefined) : next;
        if (target && !rotatedWhileEmpty && ctx.config.emptyMinutes > 0 && t - emptySince >= ctx.config.emptyMinutes * MINUTE) {
          rotatedWhileEmpty = true;
          await changeTo(target, `empty for ${ctx.config.emptyMinutes} min`);
        }
        return;
      }
      // The interval counts time with players on: someone joining an empty server gets the whole of
      // it, rather than the map changing under them as they load in.
      if (emptySince !== undefined) {
        lastChange = t;
        announced = false;
      }
      emptySince = undefined;
      rotatedWhileEmpty = false;
      const interval = ctx.config.intervalMinutes * MINUTE;
      if (!next || interval <= 0) return;
      if (!announced && t - lastChange >= interval - MINUTE) {
        announced = true;
        await ctx.server.say(`Next map: ${next} in 1 minute.`);
      }
      if (t - lastChange >= interval) await changeTo(next, 'scheduled');
    });

    ctx.on('map.changed', ({ map }) => {
      const idx = maps.indexOf(map);
      if (idx !== -1) ctx.storage.set('index', idx);
      votes.clear();
      lastChange = now;
      announced = false;
      publishNext();
    });

    // The host starts a fresh server after a match; this picks the map it starts on.
    ctx.on('match.ended', async () => {
      const next = upcoming();
      if (ctx.config.afterMatch && next) await changeTo(next, 'match over');
    });

    ctx.on('player.disconnected', ({ player }) => {
      votes.delete(voter(player));
    });

    ctx.commands.register('nextmap', {
      description: 'Show the next map in the rotation and when it comes',
      handler: (cmd) => {
        const next = upcoming();
        if (!next) return cmd.reply('There is no other map in the rotation.');
        // Players read !nextmap as "change the map"; say when it happens and how to make it happen now.
        const interval = ctx.config.intervalMinutes * MINUTE;
        const left = Math.max(1, Math.ceil((lastChange + interval - now) / MINUTE));
        const when = interval > 0 && humans().length > 0 ? ` in ${left} min` : '';
        return cmd.reply(`Next map: ${next}${when}. Type !rtv to vote to change now.`);
      },
    });

    ctx.commands.register('map', {
      description: 'Change the map now: !map <name>',
      access: 'admin',
      handler: async (cmd) => {
        const map = cmd.args[0];
        if (!map || !MAP_NAME.test(map)) return cmd.reply('Usage: !map <name>');
        await ctx.server.say(`Changing map to ${map}.`);
        await changeTo(map, `admin ${cmd.player?.name ?? 'console'}`);
      },
    });

    ctx.commands.register('rtv', {
      description: 'Vote to rock the vote (change to the next map)',
      aliases: ['rockthevote'],
      handler: async (cmd) => {
        const next = upcoming();
        if (!cmd.player) return cmd.reply('Only players can vote.');
        if (!next) return cmd.reply('There is no other map to vote for.');
        votes.add(voter(cmd.player));
        const needed = Math.max(1, Math.ceil(humans().length * ctx.config.rtvRatio));
        if (votes.size >= needed) {
          await ctx.server.say(`Vote passed! Changing map to ${next}.`);
          await changeTo(next, 'rtv');
        } else {
          await ctx.server.say(`${cmd.player.name} wants a new map (${votes.size}/${needed}). Type !rtv to vote.`);
        }
      },
    });

    publishNext();
  },
});
