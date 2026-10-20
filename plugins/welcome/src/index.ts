import { definePlugin, type Player } from '@opencitadel/plugin-sdk';

export interface WelcomeConfig {
  message: string;
  delaySeconds: number;
  rules: string[];
  discord: string;
  regreetMinutes: number;
}

export function formatGreeting(template: string, player: Player, server: string): string {
  return template.replace(/\{name\}/g, player.name).replace(/\{server\}/g, server);
}

export default definePlugin<WelcomeConfig>({
  setup(ctx) {
    const { message, delaySeconds, rules, discord, regreetMinutes } = ctx.config;
    // Players who reconnect within the delay are greeted once.
    const pending = new Map<string, { dispose(): void }>();
    // A client stuck reconnecting (as one did for hours on a finished match) shouldn't be greeted every time.
    const greetedAt = new Map<string, number>();
    const key = (p: Player) => p.steamId ?? p.steamId64 ?? p.name;

    ctx.on('player.connected', ({ player }) => {
      if (player.bot || !message) return;
      const last = greetedAt.get(key(player));
      if (last !== undefined && Date.now() - last < regreetMinutes * 60_000) return;
      pending.get(key(player))?.dispose();
      pending.set(
        key(player),
        ctx.timers.setTimeout(() => {
          pending.delete(key(player));
          // Only greet players who are still here.
          const current = ctx.server.findPlayer(player.steamId ?? player.name);
          if (!current && ctx.server.state.players.length) return;
          greetedAt.set(key(player), Date.now());
          void ctx.server.tell(current ?? player, formatGreeting(message, player, ctx.server.state.hostname));
        }, Math.max(0, delaySeconds) * 1000),
      );
    });

    ctx.on('player.disconnected', ({ player }) => {
      pending.get(key(player))?.dispose();
      pending.delete(key(player));
    });

    ctx.commands.register('rules', {
      description: 'Show the server rules',
      handler: async (cmd) => {
        if (!rules.length) return cmd.reply('This server has no rules set. Be nice!');
        for (const [i, rule] of rules.entries()) await cmd.reply(`${i + 1}. ${rule}`);
      },
    });

    ctx.commands.register('discord', {
      description: 'Show the community Discord',
      handler: (cmd) => cmd.reply(discord ? `Join us: ${discord}` : 'This server has no Discord set.'),
    });
  },
});
