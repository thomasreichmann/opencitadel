import { definePlugin } from '@opencitadel/plugin-sdk';

export interface WebhookConfig {
  webhookUrl: string;
  events: string[];
  relayChat: boolean;
  username: string;
  batchSeconds: number;
  maxPerMinute: number;
}

/** Discord's limit for one message. */
const MAX_CONTENT = 2000;
/** Lines kept while posting is blocked; older ones are dropped and counted. */
const MAX_QUEUE = 200;

/**
 * Escapes Discord markdown so player names and chat cannot format or break messages. (Every
 * line starts with an emoji shortcode, so line-start syntax like `#` or `-` never applies.)
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>[\]])/g, '\\$1').replace(/\r?\n/g, ' ');
}

/** Packs queued lines into as few messages as fit, in order. */
export function packMessages(lines: string[], max = MAX_CONTENT): string[] {
  const out: string[] = [];
  let current = '';
  for (const raw of lines) {
    const line = raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
    if (current && current.length + 1 + line.length > max) {
      out.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) out.push(current);
  return out;
}

export default definePlugin<WebhookConfig>({
  setup(ctx) {
    const cfg = ctx.config;
    if (!cfg.webhookUrl) {
      ctx.log.warn('No webhookUrl configured; nothing will be posted.');
      return;
    }
    if (!/^https:\/\//.test(cfg.webhookUrl)) {
      ctx.log.error('webhookUrl must be an https:// URL; nothing will be posted.');
      return;
    }
    if (!/^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\//.test(cfg.webhookUrl)) {
      ctx.log.warn('webhookUrl does not look like a Discord webhook; posting anyway.');
    }

    const want = new Set(cfg.events);
    const queue: string[] = [];
    let dropped = 0;
    let lastFlush = 0;
    const sent: number[] = [];
    let blockedUntil = 0;
    let flushing = false;

    const enqueue = (line: string) => {
      queue.push(line);
      if (queue.length > MAX_QUEUE) {
        queue.shift();
        dropped++;
      }
    };

    const post = async (content: string, now: number): Promise<boolean> => {
      const res = await ctx.fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, username: (cfg.username || ctx.server.state.hostname).slice(0, 80), allowed_mentions: { parse: [] } }),
      });
      if (res.status === 429) {
        let retry = 5;
        try {
          retry = Number(((await res.json()) as { retry_after?: number }).retry_after) || retry;
        } catch {
          // keep the default
        }
        blockedUntil = now + retry * 1000;
        ctx.log.warn(`Discord rate limited us; pausing for ${retry}s`);
        return false;
      }
      if (!res.ok) {
        ctx.log.error(`Webhook returned HTTP ${res.status}; dropping ${content.split('\n').length} line(s)`);
        return true;
      }
      return true;
    };

    const flush = async (now: number) => {
      if (flushing || !queue.length || now < blockedUntil) return;
      flushing = true;
      try {
        lastFlush = now;
        while (sent.length && now - sent[0]! >= 60_000) sent.shift();
        if (dropped) {
          queue.unshift(`(${dropped} earlier message${dropped === 1 ? '' : 's'} skipped)`);
          dropped = 0;
        }
        const [first] = packMessages(queue);
        if (!first || sent.length >= cfg.maxPerMinute) return;
        const count = first.split('\n').length;
        sent.push(now);
        try {
          if (await post(first, now)) queue.splice(0, count);
        } catch (err) {
          ctx.log.error(`Webhook request failed: ${(err as Error).message}`);
        }
      } finally {
        flushing = false;
      }
    };

    const host = () => escapeMarkdown(ctx.server.state.hostname);

    if (want.has('server')) {
      ctx.on('server.ready', ({ map }) => enqueue(`:green_circle: **${host()}** is up on \`${map}\``));
      ctx.on('server.stopped', ({ crashed }) => {
        enqueue(crashed ? `:red_circle: **${host()}** crashed and is restarting` : `:black_circle: **${host()}** stopped`);
        return flush(Math.max(Date.now(), lastFlush));
      });
    }
    if (want.has('players')) {
      ctx.on('player.connected', ({ player }) => {
        if (player.bot) return;
        const s = ctx.server.state;
        enqueue(`:arrow_right: ${escapeMarkdown(player.name)} joined (${s.players.filter((p) => !p.bot).length}/${s.maxPlayers})`);
      });
      ctx.on('player.disconnected', ({ player }) => {
        if (!player.bot) enqueue(`:arrow_left: ${escapeMarkdown(player.name)} left`);
      });
    }
    if (want.has('maps')) {
      ctx.on('map.changed', ({ map }) => enqueue(`:map: Map changed to \`${map}\``));
    }
    if (cfg.relayChat) {
      ctx.on('chat.message', ({ player, message, teamOnly }) => {
        if (!teamOnly) enqueue(`:speech_balloon: **${escapeMarkdown(player.name)}**: ${escapeMarkdown(message)}`);
      });
    }

    ctx.on('tick', ({ now }) => {
      if (now - lastFlush >= Math.max(1, cfg.batchSeconds) * 1000) return flush(now);
    });
  },
});
