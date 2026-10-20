using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using DeadworksManaged.Api;

namespace OpenCitadel.Bridge;

/// <summary>
/// Streams in-game events to citadel-host and runs its requests, over the OpenCitadel bridge
/// protocol: newline-delimited JSON on the loopback TCP address in OPENCITADEL_BRIDGE, authenticated
/// with OPENCITADEL_BRIDGE_TOKEN. citadel-host sets both when it launches deadworks.exe; without them
/// the plugin stays idle, so it is harmless on servers started any other way.
///
/// Threading: Deadworks calls plugin hooks on the game thread. Socket I/O runs on background tasks;
/// outgoing lines go through a bounded channel (the game thread never blocks on the network), and
/// incoming requests are marshalled back onto the game thread with Timer.NextTick.
/// </summary>
public sealed class BridgePlugin : DeadworksPluginBase {
	public const string BridgeVersion = "0.1.0";
	private const int MaxLineChars = 64 * 1024;
	private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(5);
	private static readonly TimeSpan PingInterval = TimeSpan.FromSeconds(15);
	private static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(45);

	public override string Name => "OpenCitadel.Bridge";

	private CancellationTokenSource? _cts;
	private volatile Channel<string>? _outbox;
	// Resolved on the game thread in OnLoad; ITimer.NextTick itself is safe to call from any thread.
	private DeadworksManaged.Api.ITimer? _timer;
	private long _lastSeenTicks;
	private string? _lastError;

	public override void OnLoad(bool isReload) {
		var address = Environment.GetEnvironmentVariable("OPENCITADEL_BRIDGE");
		var token = Environment.GetEnvironmentVariable("OPENCITADEL_BRIDGE_TOKEN");
		if (string.IsNullOrEmpty(address) || string.IsNullOrEmpty(token)) {
			Console.WriteLine("[OpenCitadel.Bridge] OPENCITADEL_BRIDGE is not set (server not started by citadel-host); staying idle.");
			return;
		}
		if (!TryParseAddress(address, out var host, out var port)) {
			Console.WriteLine($"[OpenCitadel.Bridge] Ignoring malformed OPENCITADEL_BRIDGE \"{address}\".");
			return;
		}
		_timer = Timer;
		_cts = new CancellationTokenSource();
		var ct = _cts.Token;
		_ = Task.Run(() => RunAsync(host, port, token, ct), ct);
		Console.WriteLine($"[OpenCitadel.Bridge] {(isReload ? "Reloaded" : "Loaded")}; connecting to citadel-host at {address}.");
	}

	public override void OnUnload() {
		_cts?.Cancel();
		_cts = null;
		_outbox = null;
	}

	// ------------------------------------------------------------------ game events (game thread)

	public override void OnStartupServer() {
		var map = Server.MapName;
		Send(Event("map.changed", new JsonObject { ["map"] = map }));
		Send(Event("server.ready", new JsonObject { ["map"] = map }));
	}

	public override void OnClientFullConnect(ClientFullConnectEvent args) {
		// Fired again for everyone after a map change; that is not a join.
		if (args.IsMapChangeReconnect) return;
		var controller = args.Controller;
		if (controller == null) return;
		Send(Event("player.connected", PlayerJson(controller)));
	}

	public override void OnClientDisconnecting(ClientDisconnectedEvent args) {
		// Everyone "disconnects" while a map shuts down and reconnects to the next one.
		if (args.IsMapChange) return;
		var controller = args.Controller;
		var data = controller != null ? PlayerJson(controller) : new JsonObject { ["slot"] = args.Slot, ["name"] = "" };
		data["reason"] = args.Reason.ToString();
		Send(Event("player.disconnected", data));
	}

	public override HookResult OnChatMessage(ChatMessage message) {
		var controller = message.Controller;
		var data = controller != null ? PlayerJson(controller) : new JsonObject { ["slot"] = message.SenderSlot, ["name"] = "" };
		data["message"] = message.ChatText;
		data["teamOnly"] = !message.AllChat;
		Send(Event("chat.message", data));
		return HookResult.Continue;
	}

	[GameEventHandler("player_death")]
	public HookResult OnPlayerDeath(GameEvent e) {
		var data = new JsonObject {
			["weapon"] = e.GetString("weapon"),
			["headshot"] = e.GetBool("headshot"),
		};
		if (e.GetPlayerController("userid") is { } victim) {
			data["victimSlot"] = victim.Slot;
			data["victimName"] = victim.PlayerName;
			if (victim.PlayerSteamId != 0) data["victimSteamId64"] = victim.PlayerSteamId.ToString();
		}
		if (e.GetPlayerController("attacker") is { } attacker) {
			data["attackerSlot"] = attacker.Slot;
			data["attackerName"] = attacker.PlayerName;
			if (attacker.PlayerSteamId != 0) data["attackerSteamId64"] = attacker.PlayerSteamId.ToString();
		}
		Send(Event("game.event", new JsonObject { ["name"] = "player_death", ["data"] = data }));
		return HookResult.Continue;
	}

	private static JsonObject PlayerJson(CBasePlayerController controller) {
		var o = new JsonObject {
			["slot"] = controller.Slot,
			["name"] = controller.PlayerName,
			["team"] = controller.TeamNum,
			["bot"] = controller.IsBot,
		};
		if (controller.PlayerSteamId != 0) o["steamId64"] = controller.PlayerSteamId.ToString();
		if (controller is CCitadelPlayerController citadel) {
			var pawn = citadel.GetHeroPawn();
			if (pawn != null) o["team"] = pawn.TeamNum;
			var heroId = pawn?.PlayerData?.HeroID ?? 0;
			if (heroId != 0) o["hero"] = ((Heroes)heroId).ToDisplayName();
		}
		return o;
	}

	// ------------------------------------------------------------------ requests (game thread)

	private void HandleRequest(long id, string method, JsonObject? p) {
		try {
			switch (method) {
				case "command": {
					var command = Str(p, "command");
					try {
						// Output arrives on a later frame.
						Server.ExecuteCommand(command, output => Respond(id, JsonValue.Create(output)));
					} catch (InvalidOperationException) {
						// Output capture unavailable: run it blind.
						Server.ExecuteCommand(command);
						Respond(id, JsonValue.Create(""));
					}
					return;
				}
				case "say":
					Chat.PrintToChatAll(Str(p, "message"));
					Respond(id, null);
					return;
				case "tell":
					Chat.PrintToChat(Int(p, "slot"), Str(p, "message"));
					Respond(id, null);
					return;
				case "kick": {
					var slot = Int(p, "slot");
					if (Players.FromSlot(slot) == null) throw new ArgumentException($"no player in slot {slot}");
					Server.Kick(slot, Str(p, "reason"));
					Respond(id, null);
					return;
				}
				case "players": {
					var list = new JsonArray();
					foreach (var controller in Players.GetAll()) list.Add(PlayerJson(controller));
					Respond(id, list);
					return;
				}
				default:
					Fail(id, $"unknown method \"{method}\"");
					return;
			}
		} catch (Exception ex) {
			Fail(id, ex.Message);
		}
	}

	private static string Str(JsonObject? p, string key) =>
		p?[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";

	private static int Int(JsonObject? p, string key) =>
		p?[key] is JsonValue v && v.TryGetValue<int>(out var i) ? i : throw new ArgumentException($"\"{key}\" must be an integer");

	private void Respond(long id, JsonNode? result) =>
		Send(new JsonObject { ["type"] = "response", ["id"] = id, ["ok"] = true, ["result"] = result });

	private void Fail(long id, string error) =>
		Send(new JsonObject { ["type"] = "response", ["id"] = id, ["ok"] = false, ["error"] = error });

	private static JsonObject Event(string name, JsonObject data) =>
		new() { ["type"] = "event", ["name"] = name, ["data"] = data };

	/// <summary>Queues a message for the host. Dropped when not connected; never blocks.</summary>
	private void Send(JsonObject message) => _outbox?.Writer.TryWrite(message.ToJsonString());

	// ------------------------------------------------------------------ connection (background)

	private static bool TryParseAddress(string address, out string host, out int port) {
		host = "";
		port = 0;
		var idx = address.LastIndexOf(':');
		if (idx <= 0 || !int.TryParse(address[(idx + 1)..], out port) || port is <= 0 or > 65535) return false;
		host = address[..idx];
		return true;
	}

	private async Task RunAsync(string host, int port, string token, CancellationToken ct) {
		while (!ct.IsCancellationRequested) {
			try {
				using var client = new TcpClient { NoDelay = true };
				await client.ConnectAsync(host, port, ct);
				await using var stream = client.GetStream();
				using var session = CancellationTokenSource.CreateLinkedTokenSource(ct);

				var outbox = Channel.CreateBounded<string>(new BoundedChannelOptions(4096) {
					FullMode = BoundedChannelFullMode.DropOldest,
					SingleReader = true,
				});
				// The hello must be the first line on the wire.
				outbox.Writer.TryWrite(new JsonObject {
					["type"] = "hello",
					["token"] = token,
					["bridge"] = BridgeVersion,
					["deadworks"] = Deadworks.Version,
					["map"] = Server.MapName,
				}.ToJsonString());
				Interlocked.Exchange(ref _lastSeenTicks, Environment.TickCount64);

				var writer = WriteLoopAsync(stream, outbox.Reader, session.Token);
				var keepAlive = KeepAliveAsync(outbox.Writer, session);
				_outbox = outbox;
				try {
					await ReadLoopAsync(stream, session.Token);
				} finally {
					_outbox = null;
					session.Cancel();
					await Task.WhenAll(writer.ContinueWith(_ => { }), keepAlive.ContinueWith(_ => { }));
				}
				_lastError = null;
			} catch (OperationCanceledException) when (ct.IsCancellationRequested) {
				break;
			} catch (Exception ex) {
				// Log each distinct failure once rather than every 5 seconds.
				if (ex.Message != _lastError) Console.WriteLine($"[OpenCitadel.Bridge] Connection to citadel-host failed: {ex.Message}");
				_lastError = ex.Message;
			}
			try {
				await Task.Delay(ReconnectDelay, ct);
			} catch (OperationCanceledException) {
				break;
			}
		}
	}

	private static async Task WriteLoopAsync(NetworkStream stream, ChannelReader<string> reader, CancellationToken ct) {
		var newline = "\n"u8.ToArray();
		await foreach (var line in reader.ReadAllAsync(ct)) {
			await stream.WriteAsync(Encoding.UTF8.GetBytes(line), ct);
			await stream.WriteAsync(newline, ct);
		}
	}

	private async Task KeepAliveAsync(ChannelWriter<string> writer, CancellationTokenSource session) {
		var ping = new JsonObject { ["type"] = "ping" }.ToJsonString();
		while (!session.IsCancellationRequested) {
			await Task.Delay(PingInterval, session.Token);
			if (Environment.TickCount64 - Interlocked.Read(ref _lastSeenTicks) > IdleTimeout.TotalMilliseconds) {
				Console.WriteLine("[OpenCitadel.Bridge] citadel-host went quiet; reconnecting.");
				session.Cancel();
				return;
			}
			writer.TryWrite(ping);
		}
	}

	private async Task ReadLoopAsync(NetworkStream stream, CancellationToken ct) {
		using var reader = new StreamReader(stream, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: false, bufferSize: 8192, leaveOpen: true);
		while (!ct.IsCancellationRequested) {
			var line = await reader.ReadLineAsync(ct);
			if (line == null) return; // host closed the connection (e.g. wrong token)
			if (line.Length > MaxLineChars) return;
			Interlocked.Exchange(ref _lastSeenTicks, Environment.TickCount64);
			if (line.Length == 0) continue;

			JsonObject? msg;
			try {
				msg = JsonNode.Parse(line) as JsonObject;
			} catch (JsonException) {
				return;
			}
			if (msg == null) return;

			switch (Str(msg, "type")) {
				case "welcome":
					Console.WriteLine($"[OpenCitadel.Bridge] Connected to citadel-host {Str(msg, "host")}.");
					break;
				case "ping":
					_outbox?.Writer.TryWrite(new JsonObject { ["type"] = "pong" }.ToJsonString());
					break;
				case "request": {
					var id = msg["id"] is JsonValue v && v.TryGetValue<long>(out var n) ? n : -1;
					var method = Str(msg, "method");
					var p = msg["params"] as JsonObject;
					// Detach so the node can be used after this line's document is gone.
					p = p != null ? (JsonObject)JsonNode.Parse(p.ToJsonString())! : null;
					_timer?.NextTick(() => HandleRequest(id, method, p));
					break;
				}
				// pong and unknown types only refresh the idle timer.
			}
		}
	}
}
