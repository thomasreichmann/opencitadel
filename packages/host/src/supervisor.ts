/**
 * Runs the dedicated server and everything around it: launches the game, follows its console
 * log, connects RCON, accepts the in-game bridge, turns all of it into deduplicated events for
 * plugins, keeps the listing fresh, restarts after crashes and on a daily schedule, and shuts
 * down cleanly.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fromSteam64, formatSteam3 } from '@opencitadel/protocol';
import type { EventName, Logger, Player, PluginEvents, ServerPhase, ServerState } from '@opencitadel/plugin-sdk';
import { gameLayout, type GameLayout } from '@opencitadel/gamefiles';
import type { HostConfig } from './config.js';
import { hostPaths } from './config.js';
import type { CreatePluginHost, InstalledListing, PluginHost } from './services.js';
import { BridgeServer } from './bridge.js';
import { EventBus, type EventSource } from './eventbus.js';
import { ensureGameinfo } from './game.js';
import { Heartbeater } from './heartbeat.js';
import { HostServicesImpl } from './host-services.js';
import { CFG_NAME, planLaunch } from './launch.js';
import { createLogger } from './logger.js';
import { LogTail } from './logtail.js';
import { isConsoleNoise, parseLogLine, parseStatus, type StatusPlayer } from './parsers.js';
import { RconClient } from './rcon.js';
import { StateWriter, initialState, type StateFile } from './state.js';
import { HOST_VERSION } from './version.js';
import { runsOnWindowsSide, stopWindowsProcesses } from './winproc.js';

export interface SupervisorTimings {
  /** Delay before the first RCON attempt after launch, and between retries. */
  rconRetryMs: number;
  statusPollMs: number;
  /** Heartbeat interval; undefined lets the master suggest one. */
  heartbeatMs?: number;
  /** How long a graceful `quit` may take before the process is killed. */
  stopTimeoutMs: number;
  /** First crash-restart delay; doubles per consecutive crash up to restart.maxBackoffSeconds. */
  backoffBaseMs: number;
  /** Uptime after which the crash counter resets. */
  uptimeResetMs: number;
  tickMs: number;
  stateWriteMs: number;
  logPollMs: number;
}

const DEFAULT_TIMINGS: SupervisorTimings = {
  rconRetryMs: 2000,
  statusPollMs: 10_000,
  stopTimeoutMs: 20_000,
  backoffBaseMs: 5000,
  uptimeResetMs: 10 * 60_000,
  tickMs: 1000,
  stateWriteMs: 2000,
  logPollMs: 250,
};

export interface SupervisorOptions {
  serverDir: string;
  config: HostConfig;
  gameRoot: string;
  createPluginHost: CreatePluginHost;
  installedListing?: InstalledListing;
  fetch?: typeof fetch;
  timings?: Partial<SupervisorTimings>;
}

type SupervisorEvents = {
  phase: [ServerPhase];
  /** Every console line from the game. */
  line: [string];
};

const str = (v: unknown, max = 128): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Converts a player object sent by the bridge into an SDK Player. */
export function bridgePlayer(data: Record<string, unknown>): Player {
  const steamId64 = typeof data.steamId64 === 'string' && /^\d{17}$/.test(data.steamId64) ? data.steamId64 : undefined;
  const parsed = steamId64 ? fromSteam64(steamId64) : undefined;
  const player: Player = { name: str(data.name, 64) ?? 'unknown' };
  const slot = num(data.slot);
  if (slot !== undefined) player.slot = slot;
  if (steamId64) player.steamId64 = steamId64;
  if (parsed && parsed.type === 1) player.steamId = formatSteam3(parsed);
  const team = num(data.team);
  if (team !== undefined) player.team = team;
  const hero = str(data.hero, 48);
  if (hero) player.hero = hero;
  if (data.bot === true) player.bot = true;
  return player;
}

function statusPlayer(p: StatusPlayer): Player {
  const player: Player = { name: p.name };
  if (p.id !== undefined) player.slot = p.id;
  if (p.steamId) player.steamId = p.steamId;
  if (p.steamId64) player.steamId64 = p.steamId64;
  if (p.ping !== undefined) player.ping = p.ping;
  if (p.time !== undefined) player.connectedFor = p.time;
  if (p.bot) player.bot = true;
  return player;
}

export class Supervisor extends EventEmitter<SupervisorEvents> {
  readonly bus = new EventBus();
  readonly services: HostServicesImpl;
  readonly layout: GameLayout;
  pluginHost!: PluginHost;

  private readonly log: Logger;
  private readonly timings: SupervisorTimings;
  private config: HostConfig;
  private state: ServerState;
  private child?: ChildProcess;
  private childExited?: Promise<void>;
  /** The game is a Windows process started from WSL, so killing `child` alone won't stop it. */
  private windowsSide = false;
  private rcon?: RconClient;
  private rconAuthFailed = false;
  private bridge?: BridgeServer;
  private tail?: LogTail;
  private heartbeater?: Heartbeater;
  private readonly stateWriter: StateWriter;
  private attempt = 0;
  private consecutiveCrashes = 0;
  private launchedAt = 0;
  private launchSeq = 0;
  private steamIdFromRcon = false;
  private exitedSeq = 0;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private restartRequested = false;
  private restartTimer?: NodeJS.Timeout;
  /** Set by changeMap(): the map every later launch starts on, crash restarts included. */
  private launchMap?: string;
  private matchEndTimer?: NodeJS.Timeout;
  private rconTimer?: NodeJS.Timeout;
  private statusTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private dailyTimers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: SupervisorOptions) {
    super();
    this.config = opts.config;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.log = createLogger('host');
    this.layout = gameLayout(opts.gameRoot);
    this.state = initialState(this.config.name, this.config.game.maxPlayers, this.config.publicAddress);
    this.services = new HostServicesImpl({
      serverDir: opts.serverDir,
      config: () => this.config,
      state: () => this.getState(),
      bridge: () => this.bridge,
      rcon: () => this.rcon,
      changeMap: (map) => this.changeMap(map),
    });
    this.stateWriter = new StateWriter(hostPaths(opts.serverDir).stateFile, () => this.snapshot(), this.timings.stateWriteMs);
    this.bus.on((event, payload, source) => this.onBusEvent(event, payload, source));
  }

  getState(): ServerState {
    const map = this.bus.currentMap() ?? this.state.map;
    return { ...this.state, ...(map ? { map } : {}), players: this.bus.players(), sources: { ...this.state.sources } };
  }

  get phase(): ServerPhase {
    return this.state.phase;
  }

  get gamePid(): number | undefined {
    return this.child?.pid;
  }

  private snapshot(): StateFile {
    return { ...this.getState(), pid: process.pid, ...(this.child?.pid ? { gamePid: this.child.pid } : {}), updatedAt: new Date().toISOString(), version: HOST_VERSION };
  }

  private setPhase(phase: ServerPhase): void {
    if (this.state.phase === phase) return;
    this.state.phase = phase;
    this.stateWriter.markDirty();
    this.emit('phase', phase);
  }

  /** Emits to plugins without letting a misbehaving runtime take the supervisor down. */
  private toPlugins<E extends EventName>(event: E, payload: PluginEvents[E]): void {
    try {
      this.pluginHost?.emit(event, payload);
    } catch (err) {
      this.log.error(`Plugin host failed handling ${event}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    const c = this.config;
    if (c.bridge.enabled) {
      this.bridge = new BridgeServer({ port: c.bridge.port, token: randomBytes(24).toString('base64url'), log: createLogger('bridge') });
      try {
        await this.bridge.listen();
        this.wireBridge(this.bridge);
      } catch (err) {
        this.log.warn(`Bridge disabled: cannot listen on 127.0.0.1:${c.bridge.port} (${(err as Error).message})`);
        this.bridge = undefined;
      }
    }

    this.pluginHost = this.opts.createPluginHost(this.services, c);
    try {
      await this.pluginHost.loadAll();
    } catch (err) {
      this.log.error(`Loading plugins failed: ${(err as Error).message}`);
    }

    const installed = this.opts.installedListing;
    this.heartbeater = new Heartbeater({
      config: () => this.config,
      state: () => this.getState(),
      contributions: () => {
        try {
          return this.pluginHost.listingContributions();
        } catch {
          return { tags: [], metadata: {} };
        }
      },
      installed: async () => (installed ? installed(this.opts.serverDir, this.config).catch(() => ({ plugins: [], content: [] })) : { plugins: [], content: [] }),
      log: createLogger('heartbeat'),
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.timings.heartbeatMs !== undefined ? { intervalMs: this.timings.heartbeatMs } : {}),
    });
    this.heartbeater.start();

    this.tickTimer = setInterval(() => {
      if (this.state.phase === 'running') this.toPlugins('tick', { now: Date.now() });
    }, this.timings.tickMs);
    this.scheduleDaily();
    await this.launch();
  }

  private async launch(): Promise<void> {
    if (this.stopping) return;
    const seq = ++this.launchSeq;
    this.attempt++;
    this.rconAuthFailed = false;
    this.bus.resetForLaunch();
    this.state = { ...initialState(this.config.name, this.config.game.maxPlayers, this.config.publicAddress), phase: 'starting', startedAt: Date.now() };
    this.steamIdFromRcon = false;
    this.stateWriter.markDirty();
    this.emit('phase', 'starting');
    const map = this.launchMap ?? this.config.game.map;
    this.log.info(`Starting the server (attempt ${this.attempt}) on map ${map}, port ${this.config.game.port}.`);
    this.toPlugins('server.starting', { attempt: this.attempt });

    if (this.config.game.patchGameinfo) {
      try {
        await ensureGameinfo(this.layout, this.log);
      } catch (err) {
        this.log.error(`Could not patch gameinfo.gi; Steam P2P joins may not work: ${(err as Error).message}`);
      }
    }

    const token = randomBytes(24).toString('base64url');
    this.bridge?.setToken(token);
    const plan = planLaunch({ ...this.config, game: { ...this.config.game, map } }, this.layout, this.bridge ? { port: this.bridge.port, token } : undefined);
    await mkdir(dirname(plan.cfgPath), { recursive: true });
    await writeFile(plan.cfgPath, plan.cfgContents, { mode: 0o600 });

    this.windowsSide = runsOnWindowsSide(plan.command);
    if (this.windowsSide) {
      // A previous host that died without stopping its game leaves it holding the port.
      const stale = await stopWindowsProcesses(this.processMarkers());
      if (stale.length) this.log.warn(`Stopped a leftover game process from an earlier run (PID ${stale.join(', ')}).`);
    }

    const condebug = this.config.game.logSource === 'condebug';
    const offset = condebug ? await LogTail.sizeOf(this.layout.consoleLog) : 0;
    // stop() may have been called while we were preparing.
    if (this.stopping || seq !== this.launchSeq) return;

    let child: ChildProcess;
    let resolveExit!: () => void;
    this.childExited = new Promise<void>((r) => (resolveExit = r));
    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: { ...process.env, ...plan.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.log.error(`Could not start ${plan.command}: ${(err as Error).message}`);
      resolveExit();
      this.onExit(seq, null, null);
      return;
    }
    this.child = child;
    this.launchedAt = Date.now();

    const onOutput = (line: string) => {
      if (seq !== this.launchSeq || isConsoleNoise(line)) return;
      if (condebug) this.log.debug(`[game] ${line}`);
      else this.handleLine(line);
    };
    if (child.stdout) createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', onOutput);
    if (child.stderr) createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', onOutput);

    child.once('error', (err) => {
      const hint = (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'ENOEXEC'
        ? process.platform === 'win32' ? '' : ' (on Linux, set game.wrapper to ["wine"])'
        : '';
      this.log.error(`Could not start ${plan.command}: ${err.message}${hint}`);
      resolveExit();
      this.onExit(seq, null, null);
    });
    child.once('exit', (code, signal) => {
      resolveExit();
      this.onExit(seq, code, signal);
    });

    if (condebug) {
      const tail = new LogTail(this.layout.consoleLog, { from: offset, pollMs: this.timings.logPollMs });
      tail.on('line', (line) => seq === this.launchSeq && this.handleLine(line));
      tail.on('error', (err) => this.log.warn(`Reading console.log failed: ${err.message}`));
      this.tail = tail;
      await tail.start();
    }
    this.state.sources.log = true;
    this.scheduleRcon(seq, this.timings.rconRetryMs);
  }

  private childAlive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  private teardownLaunch(): void {
    if (this.rconTimer) clearTimeout(this.rconTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.matchEndTimer) clearTimeout(this.matchEndTimer);
    this.rconTimer = this.statusTimer = this.matchEndTimer = undefined;
    const rcon = this.rcon;
    this.rcon = undefined;
    rcon?.close();
    const tail = this.tail;
    this.tail = undefined;
    void tail?.stop();
    this.bus.setLive('rcon', false);
    this.state.sources = { rcon: false, log: false, bridge: this.bridge?.connected ?? false };
  }

  private onExit(seq: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (seq !== this.launchSeq || this.exitedSeq === seq) return;
    this.exitedSeq = seq;
    this.teardownLaunch();
    this.child = undefined;
    const uptime = Date.now() - this.launchedAt;
    const planned = this.restartRequested;
    const crashed = !this.stopping && !planned && code !== 0;
    this.bus.resetForLaunch();
    this.state.players = [];
    this.setPhase(this.stopping ? 'stopped' : crashed ? 'crashed' : 'stopped');
    this.toPlugins('server.stopped', { code, crashed });
    this.stateWriter.markDirty();

    if (this.stopping) {
      this.log.info(`Server stopped (code ${code ?? signal ?? 'none'}).`);
      return;
    }
    if (planned) {
      this.restartRequested = false;
      this.consecutiveCrashes = 0;
      this.log.info('Restarting the server.');
      void this.launch().catch((err) => this.log.error(`Restart failed: ${(err as Error).message}`));
      return;
    }
    if (!this.config.restart.onCrash) {
      this.log.warn(`Server exited (code ${code ?? signal ?? 'none'}); restart.onCrash is off, so it stays down.`);
      return;
    }
    if (uptime >= this.timings.uptimeResetMs) this.consecutiveCrashes = 0;
    const delay = Math.min(this.timings.backoffBaseMs * 2 ** this.consecutiveCrashes, this.config.restart.maxBackoffSeconds * 1000);
    this.consecutiveCrashes++;
    this.log.warn(`Server exited unexpectedly (code ${code ?? signal ?? 'none'}). Restarting in ${Math.round(delay / 100) / 10}s.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.launch().catch((err) => this.log.error(`Restart failed: ${(err as Error).message}`));
    }, delay);
  }

  /** Stops the server gracefully (RCON `quit`, then kill), delists, and unloads plugins. */
  stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.matchEndTimer) clearTimeout(this.matchEndTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const t of this.dailyTimers) clearTimeout(t);
    this.dailyTimers = [];
    if (this.childAlive()) {
      this.setPhase('stopping');
      await this.quitGame();
    }
    await this.heartbeater?.stop();
    try {
      await this.pluginHost?.unloadAll();
    } catch (err) {
      this.log.error(`Unloading plugins failed: ${(err as Error).message}`);
    }
    await this.bridge?.close();
    this.setPhase('stopped');
    await this.stateWriter.close();
  }

  /** Asks the game to quit, waiting `stopTimeoutMs` before killing it. */
  private async quitGame(): Promise<void> {
    const exited = this.childExited ?? Promise.resolve();
    const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    try {
      if (this.rcon?.connected) await Promise.race([this.rcon.command('quit'), new Promise((r) => setTimeout(r, 2000).unref())]);
      else if (this.bridge?.connected) await this.bridge.request('command', { command: 'quit' }, 2000);
      else await this.killGame('SIGTERM');
    } catch {
      // The server often drops the connection before answering `quit`.
    }
    if (await within(this.timings.stopTimeoutMs)) return;
    this.log.warn('The server did not quit in time; terminating it.');
    await this.killGame('SIGTERM');
    if (await within(3000)) return;
    await this.killGame('SIGKILL');
    await within(3000);
  }

  /** Command-line markers that identify this server's game process among other Deadlock processes. */
  private processMarkers(): string[] {
    return [`+exec ${CFG_NAME}`, `+hostport ${this.config.game.port}`];
  }

  /** Kills the game process, including its Windows-side process when it was started from WSL. */
  private async killGame(signal: NodeJS.Signals): Promise<void> {
    if (this.windowsSide) {
      const stopped = await stopWindowsProcesses(this.processMarkers());
      if (stopped.length) this.log.info(`Stopped deadlock.exe (Windows PID ${stopped.join(', ')}).`);
    }
    this.child?.kill(signal);
  }

  /** Restarts the game process without counting it as a crash. */
  async restart(reason = 'requested'): Promise<void> {
    if (this.stopping) return;
    this.log.info(`Restart ${reason}.`);
    if (!this.childAlive()) {
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
      return this.launch();
    }
    this.restartRequested = true;
    await this.quitGame();
  }

  /**
   * Moves the server to `map`. A restart by default: `changelevel` crashes a stock server
   * (exit code 5 during the level load, build 6796). While a match-end restart is pending, only
   * the map it starts on changes.
   */
  async changeMap(map: string): Promise<void> {
    this.launchMap = map;
    if (this.config.game.mapChange === 'changelevel') {
      await this.services.command(`changelevel ${map}`);
      return;
    }
    if (this.matchEndTimer) {
      this.log.info(`The next match will be on ${map}.`);
      return;
    }
    await this.restart(`on map ${map}`);
  }

  /**
   * A stock server stays on a finished match, and clients reconnecting to it (the game retries on
   * its own) load in, see the match is over and drop, every 10 s. So the next match gets a
   * fresh server.
   */
  private onGameState(state: string): void {
    if (state !== 'PostGame' || this.matchEndTimer) return;
    const map = this.bus.currentMap() ?? this.state.map ?? this.config.game.map;
    const { afterMatch, afterMatchDelaySeconds } = this.config.restart;
    this.log.info(afterMatch ? `The match is over; a new one starts in ${afterMatchDelaySeconds}s.` : 'The match is over.');
    if (afterMatch) {
      const seq = this.launchSeq;
      this.matchEndTimer = setTimeout(() => {
        this.matchEndTimer = undefined;
        if (seq === this.launchSeq) void this.restart('for the next match');
      }, afterMatchDelaySeconds * 1000);
    }
    this.toPlugins('match.ended', { map });
  }

  private scheduleDaily(): void {
    const at = this.config.restart.dailyAt;
    if (!at || this.stopping) return;
    const [h, m] = at.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h!, m!, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const ms = next.getTime() - now.getTime();
    for (const minutes of [5, 1]) {
      const t = ms - minutes * 60_000;
      if (t > 0) {
        this.dailyTimers.push(
          setTimeout(() => {
            this.services.say(`Scheduled server restart in ${minutes} minute${minutes === 1 ? '' : 's'}.`).catch(() => {});
          }, t),
        );
      }
    }
    this.dailyTimers.push(
      setTimeout(() => {
        this.dailyTimers = [];
        void this.restart(`scheduled for ${at}`).finally(() => this.scheduleDaily());
      }, ms),
    );
  }

  // ---------------------------------------------------------------- sources

  private markRunning(): void {
    if (this.state.phase !== 'starting') return;
    this.setPhase('running');
    this.log.info('The server is up.');
    void this.heartbeater?.sendNow();
  }

  /** RCON `status` is authoritative; once it has named the SteamID, log lines no longer change it. */
  private setSteamId(steamId: string, source: 'log' | 'rcon'): void {
    if (source === 'rcon') this.steamIdFromRcon = true;
    else if (this.steamIdFromRcon) return;
    if (this.state.steamId === steamId) return;
    this.state.steamId = steamId;
    this.stateWriter.markDirty();
    this.log.info(`Server SteamID ${steamId}. Players can join with: connect ${steamId}`);
    void this.heartbeater?.sendNow();
  }

  private handleLine(line: string): void {
    if (isConsoleNoise(line)) return;
    const ev = parseLogLine(line);
    if (ev) {
      switch (ev.kind) {
        case 'steamId':
          this.setSteamId(ev.steamId, 'log');
          break;
        case 'map':
          this.bus.publish('log', 'map.changed', { map: ev.map });
          this.bus.publish('log', 'server.ready', { map: ev.map, ...(this.state.steamId ? { steamId: this.state.steamId } : {}) });
          break;
        case 'chat':
          this.bus.publish('log', 'chat.message', {
            player: { name: ev.name, ...(ev.userId !== undefined ? { slot: ev.userId } : {}), ...(ev.steamId ? { steamId: ev.steamId } : {}) },
            message: ev.message,
            teamOnly: ev.teamOnly,
          });
          break;
        case 'connected':
          this.bus.publish('log', 'player.connected', { player: { name: ev.name, ...(ev.userId !== undefined ? { slot: ev.userId } : {}), ...(ev.steamId ? { steamId: ev.steamId } : {}) } });
          break;
        case 'disconnected':
          this.bus.publish('log', 'player.disconnected', {
            player: { name: ev.name, ...(ev.steamId ? { steamId: ev.steamId } : {}) },
            ...(ev.reason ? { reason: ev.reason } : {}),
          });
          break;
        case 'gameState':
          this.onGameState(ev.state);
          break;
      }
    }
    this.toPlugins('console.line', { line });
    this.emit('line', line);
  }

  private scheduleRcon(seq: number, delay: number): void {
    const { rcon } = this.config;
    if (!rcon.enabled || !rcon.password || this.rconAuthFailed) return;
    if (this.rconTimer) clearTimeout(this.rconTimer);
    this.rconTimer = setTimeout(() => void this.connectRcon(seq), delay);
  }

  private async connectRcon(seq: number): Promise<void> {
    if (seq !== this.launchSeq || !this.childAlive() || this.stopping) return;
    const client = new RconClient({ host: '127.0.0.1', port: this.config.game.port, password: this.config.rcon.password, timeoutMs: 3000 });
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (err) {
      client.close();
      if (/authentication failed/.test((err as Error).message)) {
        this.rconAuthFailed = true;
        this.log.error('RCON rejected our password; RCON features are off for this launch.');
        return;
      }
      this.scheduleRcon(seq, this.timings.rconRetryMs);
      return;
    }
    if (seq !== this.launchSeq || !this.childAlive()) {
      client.close();
      return;
    }
    this.rcon = client;
    this.bus.setLive('rcon', true);
    this.state.sources.rcon = true;
    this.log.info('RCON connected.');
    client.on('close', () => {
      if (this.rcon !== client) return;
      this.rcon = undefined;
      this.bus.setLive('rcon', false);
      this.state.sources.rcon = false;
      if (this.statusTimer) clearInterval(this.statusTimer);
      this.statusTimer = undefined;
      if (this.childAlive() && !this.stopping) this.scheduleRcon(seq, this.timings.rconRetryMs);
    });
    this.markRunning();
    await this.pollStatus(seq);
    if (this.rcon === client) this.statusTimer = setInterval(() => void this.pollStatus(seq), this.timings.statusPollMs);
  }

  private async pollStatus(seq: number): Promise<void> {
    const rcon = this.rcon;
    if (!rcon?.connected || seq !== this.launchSeq) return;
    let out: string;
    try {
      out = await rcon.command('status');
    } catch {
      return;
    }
    if (seq !== this.launchSeq) return;
    const info = parseStatus(out);
    if (info.hostname) this.state.hostname = info.hostname;
    if (info.maxPlayers) this.state.maxPlayers = info.maxPlayers;
    if (info.steamId) this.setSteamId(info.steamId, 'rcon');
    if (info.map) {
      this.bus.publish('rcon', 'map.changed', { map: info.map });
      this.bus.publish('rcon', 'server.ready', { map: info.map, ...(this.state.steamId ? { steamId: this.state.steamId } : {}) });
    }
    this.bus.reconcile('rcon', info.players.map(statusPlayer));
    this.stateWriter.markDirty();
  }

  private wireBridge(bridge: BridgeServer): void {
    bridge.on('connected', (hello) => {
      this.bus.setLive('bridge', true);
      this.state.sources.bridge = true;
      this.markRunning();
      if (hello.map) {
        this.bus.publish('bridge', 'map.changed', { map: hello.map });
        this.bus.publish('bridge', 'server.ready', { map: hello.map, ...(this.state.steamId ? { steamId: this.state.steamId } : {}) });
      }
      bridge
        .request('players')
        .then((list) => {
          if (Array.isArray(list)) {
            this.bus.reconcile('bridge', list.filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null).map(bridgePlayer));
          }
        })
        .catch(() => {});
      this.stateWriter.markDirty();
    });
    bridge.on('disconnected', () => {
      this.bus.setLive('bridge', false);
      this.state.sources.bridge = false;
      this.stateWriter.markDirty();
    });
    bridge.on('event', (name, data) => this.onBridgeEvent(name, data));
  }

  private onBridgeEvent(name: string, data: Record<string, unknown>): void {
    const map = str(data.map, 64);
    switch (name) {
      case 'server.ready':
        if (map) this.bus.publish('bridge', 'map.changed', { map });
        // Deadworks reports an empty map name until the first map has started.
        this.bus.publish('bridge', 'server.ready', { map: map || this.bus.currentMap() || this.config.game.map, ...(this.state.steamId ? { steamId: this.state.steamId } : {}) });
        break;
      case 'map.changed':
        if (map) this.bus.publish('bridge', 'map.changed', { map });
        break;
      case 'player.connected':
        this.bus.publish('bridge', 'player.connected', { player: bridgePlayer(data) });
        break;
      case 'player.disconnected': {
        const reason = str(data.reason, 200);
        this.bus.publish('bridge', 'player.disconnected', { player: bridgePlayer(data), ...(reason ? { reason } : {}) });
        break;
      }
      case 'chat.message': {
        const message = str(data.message, 512);
        if (message === undefined) return;
        this.bus.publish('bridge', 'chat.message', { player: bridgePlayer(data), message, teamOnly: data.teamOnly === true });
        break;
      }
      case 'game.event': {
        const eventName = str(data.name, 128);
        if (!eventName) return;
        const payload = typeof data.data === 'object' && data.data !== null && !Array.isArray(data.data) ? (data.data as Record<string, unknown>) : {};
        this.toPlugins('game.event', { name: eventName, data: payload });
        break;
      }
      default:
        this.log.debug(`Ignoring unknown bridge event "${name}"`);
    }
  }

  private onBusEvent(event: string, payload: unknown, source: EventSource): void {
    const p = payload as Record<string, unknown>;
    switch (event) {
      case 'player.connected':
        this.log.info(`${(p.player as Player).name} joined (${source}).`);
        break;
      case 'player.disconnected':
        this.log.info(`${(p.player as Player).name} left${p.reason ? ` (${String(p.reason)})` : ''}.`);
        break;
      case 'map.changed':
        this.state.map = String(p.map);
        this.log.info(`Map: ${String(p.map)}`);
        break;
      case 'server.ready':
        this.markRunning();
        break;
    }
    this.stateWriter.markDirty();
    this.toPlugins(event as EventName, payload as never);
  }
}
