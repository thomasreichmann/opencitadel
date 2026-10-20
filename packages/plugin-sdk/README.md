# @opencitadel/plugin-sdk

Types and `definePlugin()` for OpenCitadel host plugins. These plugins run beside a
[Deadlock](https://store.steampowered.com/app/1422450/Deadlock/) server in `citadel-host`, each in
its own WebAssembly sandbox.

```ts
import { definePlugin } from '@opencitadel/plugin-sdk';

export default definePlugin({
  setup(ctx) {
    ctx.on('player.connected', ({ player }) => ctx.server.tell(player, `Welcome, ${player.name}!`));
  },
});
```

Start a new plugin with `citadel-host plugin new my-plugin`. See the
[plugin guide](https://github.com/thomasreichmann/opencitadel/blob/main/docs/PLUGINS.md) for the full
context API, permissions, the sandbox, and signed publishing from CI.
