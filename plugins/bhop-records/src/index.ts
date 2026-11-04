import { definePlugin, type Player, type PluginContext } from '@opencitadel/plugin-sdk';

export interface BhopRecordsConfig {
  announce: 'records' | 'pbs' | 'none';
  webhookUrl: string;
  leaderboardSize: number;
}

/** A finished run, as the bhop Deadworks plugin reports it (game event `bhop.run_finished`). */
export interface RunFinished {
  map: string;
  style: string;
  steamId64: string;
  name: string;
  /** Seconds. */
  time: number;
  jumps: number;
  maxSpeed: number;
  /** 0 for the main course, 1 and up for bonuses (whose style names carry the bonus too). */
  track: number;
}

export interface BoardEntry {
  steamId64: string;
  name: string;
  time: number;
  jumps: number;
  date: number;
}

export interface Submission {
  personalBest: boolean;
  mapRecord: boolean;
  rank: number;
  previousBest?: number;
  previousRecord?: BoardEntry;
}

/** Parses an event payload; undefined when it isn't a well-formed finished run. */
export function parseRun(data: Record<string, unknown>): RunFinished | undefined {
  const { map, style, steamId64, name, time, jumps, maxSpeed, track } = data;
  if (typeof map !== 'string' || !/^[a-z0-9_]{1,64}$/.test(map)) return undefined;
  if (typeof style !== 'string' || style.length > 64) return undefined;
  if (typeof steamId64 !== 'string' || !/^\d{1,20}$/.test(steamId64)) return undefined;
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return undefined;
  return {
    map,
    style,
    steamId64,
    name: typeof name === 'string' ? name.slice(0, 64) : steamId64,
    time,
    jumps: typeof jumps === 'number' ? jumps : 0,
    maxSpeed: typeof maxSpeed === 'number' ? maxSpeed : 0,
    track: typeof track === 'number' && Number.isInteger(track) && track >= 0 && track <= 64 ? track : 0,
  };
}

/** "bhop_eazy_v2" or "bhop_eazy_v2 bonus 1". */
export const courseName = (run: Pick<RunFinished, 'map' | 'track'>) => (run.track > 0 ? `${run.map} bonus ${run.track}` : run.map);

/** Puts a run on a leaderboard (best time per player, fastest first). Returns the new board and how the run placed. */
export function submit(board: readonly BoardEntry[], run: RunFinished, now: number, size: number): { board: BoardEntry[]; result: Submission } {
  const previousRecord = board[0];
  const mine = board.find((e) => e.steamId64 === run.steamId64);
  const personalBest = !mine || run.time < mine.time;
  let next = [...board];
  if (personalBest) {
    next = next.filter((e) => e.steamId64 !== run.steamId64);
    next.push({ steamId64: run.steamId64, name: run.name, time: run.time, jumps: run.jumps, date: now });
    next.sort((a, b) => a.time - b.time || a.date - b.date);
    next = next.slice(0, Math.max(1, size));
  }
  const rank = next.findIndex((e) => e.steamId64 === run.steamId64) + 1;
  return {
    board: next,
    result: {
      personalBest,
      mapRecord: personalBest && rank === 1 && (!previousRecord || run.time < previousRecord.time),
      rank,
      previousBest: mine?.time,
      previousRecord,
    },
  };
}

/** "1:23.456". */
export function formatTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = String(ms % 1000).padStart(3, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${rest}` : `${m}:${String(s).padStart(2, '0')}.${rest}`;
}

const boardKey = (map: string, style: string) => `board:${map}:${style}`;

export default definePlugin<BhopRecordsConfig>({
  setup(ctx: PluginContext<BhopRecordsConfig>) {
    const cfg = ctx.config;
    /** Style of the latest main-course run seen per map, so !wr shows the board players are actually on. */
    const styleOf = new Map<string, string>();

    const board = (map: string, style: string) => ctx.storage.get<BoardEntry[]>(boardKey(map, style)) ?? [];

    const publishRecord = (map: string | undefined) => {
      if (!map) return;
      const style = styleOf.get(map) ?? ctx.storage.get<string>(`style:${map}`);
      const best = style ? board(map, style)[0] : undefined;
      ctx.listing.setMetadata('bhopRecord', best ? `${formatTime(best.time)} by ${best.name}` : undefined);
    };

    ctx.listing.setGameMode('Bhop');
    ctx.listing.setTags(['bhop', 'movement']);
    publishRecord(ctx.server.state.map);

    ctx.on('map.changed', ({ map }) => publishRecord(map));

    ctx.on('game.event', async ({ name, data }) => {
      if (name !== 'bhop.run_finished') return;
      const run = parseRun(data);
      if (!run) {
        ctx.log.warn('Ignoring a malformed bhop.run_finished event');
        return;
      }
      if (run.track === 0) {
        styleOf.set(run.map, run.style);
        ctx.storage.set(`style:${run.map}`, run.style);
      }
      // Bonus styles name their bonus ("exact aa1000 bonus 1"), so each course has its own board.
      const { board: next, result } = submit(board(run.map, run.style), run, Date.now(), cfg.leaderboardSize);
      if (result.personalBest) ctx.storage.set(boardKey(run.map, run.style), next);

      const time = formatTime(run.time);
      const course = courseName(run);
      if (result.mapRecord) {
        const beat = result.previousRecord ? ` (beat ${result.previousRecord.name} by ${formatTime(result.previousRecord.time - run.time)})` : '';
        if (cfg.announce !== 'none') await ctx.server.say(`New ${course} record: ${time} by ${run.name}${beat}`);
        if (run.track === 0) publishRecord(run.map);
        if (cfg.webhookUrl) await postDiscord(ctx, `:trophy: **${escapeMd(run.name)}** set the \`${course}\` record: **${time}** (${run.jumps} jumps, ${run.style})${beat}`);
      } else if (result.personalBest && cfg.announce === 'pbs') {
        await ctx.server.say(`${run.name}: ${time} on ${course}, a personal best (rank ${result.rank}).`);
      }
    });

    const forPlayer = (p: Player | undefined) => p?.steamId64 ?? p?.steamId;

    ctx.commands.register('wr', {
      description: 'The record on this map, or on another: !wr <map>',
      handler: async (cmd) => {
        const asked = cmd.args[0]?.toLowerCase();
        if (asked && !/^[a-z0-9_]{1,64}$/.test(asked)) return void (await cmd.reply('Usage: !wr [map]'));
        const map = asked ?? ctx.server.state.map;
        const style = map ? styleOf.get(map) ?? ctx.storage.get<string>(`style:${map}`) : undefined;
        const best = map && style ? board(map, style)[0] : undefined;
        await cmd.reply(best ? `${map} record: ${formatTime(best.time)} by ${best.name}` : `No times on ${map ?? 'this map'} yet.`);
      },
    });

    ctx.commands.register('pb', {
      description: 'Your best time and rank on this map',
      handler: async (cmd) => {
        const map = ctx.server.state.map;
        const style = map ? styleOf.get(map) ?? ctx.storage.get<string>(`style:${map}`) : undefined;
        const id = forPlayer(cmd.player);
        if (!map || !style || !id) return void (await cmd.reply('No times yet.'));
        const entries = board(map, style);
        const at = entries.findIndex((e) => e.steamId64 === id);
        await cmd.reply(at === -1 ? `No time on ${map} yet.` : `Your best on ${map}: ${formatTime(entries[at]!.time)}, rank ${at + 1} of ${entries.length}.`);
      },
    });
  },
});

function escapeMd(text: string): string {
  return text.replace(/[\\*_`~|>]/g, '\\$&');
}

async function postDiscord(ctx: PluginContext<BhopRecordsConfig>, content: string): Promise<void> {
  try {
    const res = await ctx.fetch(ctx.config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) ctx.log.warn(`Discord answered ${res.status}`);
  } catch (err) {
    ctx.log.warn(`Discord post failed: ${(err as Error).message}`);
  }
}
