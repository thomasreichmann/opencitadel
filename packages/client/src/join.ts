/**
 * The join flow shared by the CLI and the local UI: check the server can be joined, sync its
 * content, then hand Steam the join URL — with the console command as a fallback, because Steam
 * does not forward launch arguments to a game that is already running.
 */

import { connectCommand, pickConnectTarget, steamJoinUrl, type ConnectTarget, type ServerDetail } from '@opencitadel/protocol';
import { syncContent, type ProgressEvent } from './content.js';
import type { FetchLike } from './api.js';
import type { Platform } from './launch.js';

export type JoinErrorCode = 'offline' | 'full' | 'password_required' | 'no_target' | 'no_game' | 'content_failed';

export class JoinError extends Error {
  constructor(readonly code: JoinErrorCode, message: string) {
    super(message);
    this.name = 'JoinError';
  }
}

/** The `POST /local/join/:id` response shape (see docs/ARCHITECTURE.md, "Local mode"). */
export interface JoinResult {
  ok: boolean;
  launched: boolean;
  steamUrl: string;
  command: string;
  contentInstalled: string[];
  restartRequired: boolean;
  message: string;
  /** The console command was put on the clipboard. */
  copied: boolean;
  target: ConnectTarget;
}

export interface LaunchOptions {
  target: ConnectTarget;
  password?: string;
  platform: Platform;
  /** False for `--print`: build the URL and command without opening anything. */
  launch?: boolean;
}

/** Opens the Steam URL for a target and copies the console command. No content handling. */
export async function launchTarget(opts: LaunchOptions): Promise<Omit<JoinResult, 'contentInstalled' | 'restartRequired'>> {
  const steamUrl = steamJoinUrl(opts.target, opts.password);
  const command = connectCommand(opts.target, opts.password);
  const launch = opts.launch ?? true;
  const running = launch ? await opts.platform.isGameRunning() : false;
  if (launch) await opts.platform.openUrl(steamUrl);
  const copied = launch ? await opts.platform.copyToClipboard(command).catch(() => false) : false;
  const fallback = `If Deadlock doesn't connect, open the console (F7) and run: ${command}`;
  const message = !launch
    ? `Run in the Deadlock console (F7): ${command}`
    : running
      ? `Deadlock is already running, so Steam may not pass the join on. Open the console (F7) and run: ${command}${copied ? ' (copied to your clipboard)' : ''}`
      : `Launching Deadlock through Steam. ${fallback}${copied ? ' (copied to your clipboard)' : ''}`;
  return { ok: true, launched: launch, steamUrl, command, message, copied, target: opts.target };
}

export interface JoinOptions {
  server: ServerDetail;
  password?: string;
  /** Join even when the listing says the server is full. */
  force?: boolean;
  /** Skip downloading/installing the server's content. */
  skipContent?: boolean;
  /** Deadlock install root; required only when content has to be synced. */
  gameRoot?: string;
  cacheDir: string;
  platform: Platform;
  launch?: boolean;
  fetchImpl?: FetchLike;
  allowPrivateContent?: boolean;
  /** Content hosts trusted even on private addresses (pass the master's `host[:port]`). */
  trustedHosts?: string[];
  onProgress?(event: ProgressEvent): void;
}

export async function joinServer(opts: JoinOptions): Promise<JoinResult> {
  const { server } = opts;
  if (!server.online) throw new JoinError('offline', `${server.name} is offline`);
  const target = pickConnectTarget(server.connect, server.verified);
  if (!target) throw new JoinError('no_target', `${server.name} doesn't publish a way to connect`);
  if (server.passworded && !opts.password) throw new JoinError('password_required', `${server.name} is password protected; supply the password to join`);
  if (!opts.force && server.maxPlayers > 0 && server.players >= server.maxPlayers) {
    throw new JoinError('full', `${server.name} is full (${server.players}/${server.maxPlayers})`);
  }

  let contentInstalled: string[] = [];
  let restartRequired = false;
  // Even a vanilla server gets a sync, so a previous server's addons are unmounted.
  if (!opts.skipContent && (server.content.length || opts.gameRoot)) {
    if (!opts.gameRoot) {
      throw new JoinError('no_game', `${server.name} requires content, but no Deadlock install was found. Set DEADLOCK_PATH or gamePath in client.json, or join without content.`);
    }
    try {
      const sync = await syncContent({
        gameRoot: opts.gameRoot,
        cacheDir: opts.cacheDir,
        items: server.content,
        server: { id: server.id, name: server.name },
        gameRunning: await opts.platform.isGameRunning(),
        fetchImpl: opts.fetchImpl,
        allowPrivate: opts.allowPrivateContent,
        trustedHosts: opts.trustedHosts,
        onProgress: opts.onProgress,
      });
      contentInstalled = sync.installed;
      restartRequired = sync.restartRequired;
    } catch (err) {
      throw new JoinError('content_failed', (err as Error).message);
    }
  }

  const steamUrl = steamJoinUrl(target, opts.password);
  const command = connectCommand(target, opts.password);
  if (restartRequired) {
    // Search paths are read at startup; joining now would load the old content.
    return {
      ok: true,
      launched: false,
      steamUrl,
      command,
      contentInstalled,
      restartRequired,
      copied: false,
      target,
      message: `Installed new content for ${server.name}. Quit Deadlock and join again so it loads.`,
    };
  }
  const launched = await launchTarget({ target, password: opts.password, platform: opts.platform, launch: opts.launch });
  const installedNote = contentInstalled.length ? `Installed ${contentInstalled.join(', ')}. ` : '';
  return { ...launched, contentInstalled, restartRequired, message: installedNote + launched.message };
}
