import { DurableObject } from "cloudflare:workers";
import { cooldown, parseClientMessage } from "./guard";
import { act, applyWeather, catchUp, newPet } from "./pet";
import type { FeedEvent, Pet, ServerMsg, Weather } from "./protocol";
import { DEFAULT_WEATHER, fetchBandungWeather, parseWeather } from "./weather";

const MAX_SOCKETS_PER_IP = 5;
const FEED_SIZE = 30;
const WEATHER_EVERY = 15 * 60_000; // Open-Meteo refreshes every 15 minutes

/** What Ohm remembers about each open WebSocket. Stored on the socket, so it survives hibernation. */
type Visitor = { ip: string; id: string; name: string; helloAt: number };

// The one and only Ohm. Every visitor connects to this single object, and it handles
// one message at a time, so there is never more than one copy of Ohm's state.
export class Ohm extends DurableObject<Env> {
  private sql: SqlStorage;
  private careAllowed = cooldown(3_000);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER, type TEXT, who_id TEXT, who_name TEXT)",
    );
    // Start the weather alarm if it isn't running yet. With FAKE_WEATHER (local testing only),
    // run it right away, so a changed .dev.vars shows up after a restart.
    ctx.blockConcurrencyWhile(async () => {
      if (env.FAKE_WEATHER || (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
    });
  }

  // A browser opens a WebSocket. The Worker has already checked its Origin.
  async fetch(request: Request): Promise<Response> {
    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    const mine = this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Visitor).ip === ip);
    if (mine.length >= MAX_SOCKETS_PER_IP) return new Response("Too many connections", { status: 429 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]); // hibernation API: Ohm can sleep while sockets stay open
    pair[1].serializeAttachment({ ip, id: "", name: "Guest", helloAt: 0 } satisfies Visitor);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const msg = parseClientMessage(raw);
    if (!msg) return this.send(ws, { t: "error", msg: "Ohm didn't understand that message" });
    const me = ws.deserializeAttachment() as Visitor;
    const now = Date.now();

    if (msg.t === "hello") {
      // One hello per socket every 2 s: it's sent once on connect and again on rename.
      if (now - me.helloAt < 2_000) return this.send(ws, { t: "error", msg: "Slow down: try again in a moment" });
      ws.serializeAttachment({ ...me, id: msg.id, name: msg.name, helloAt: now } satisfies Visitor);
      this.send(ws, this.stateMsg(this.load(now), now));
      this.send(ws, { t: "feed", events: this.feed() });
      this.broadcast({ t: "online", online: this.online() });
      return;
    }

    if (!this.careAllowed(me.ip, now)) {
      return this.send(ws, { t: "error", msg: "Slow down: one action every 3 seconds" });
    }
    const pet = this.load(now);
    const problem = act(pet, msg.t, now, this.weather());
    if (problem) return this.send(ws, { t: "error", msg: problem });
    this.save(pet);
    this.broadcast({ t: "event", e: this.log(now, msg.t, me.id, me.name) });
    this.broadcast(this.stateMsg(pet, now));
  }

  async webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      // already closed
    }
    this.broadcast({ t: "online", online: this.online() });
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  /** Every 15 minutes: read Bandung's weather, change the drain speed, and notice a shutdown. */
  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + WEATHER_EVERY); // schedule the next one first, so the chain never breaks
    try {
      const weather = this.env.FAKE_WEATHER
        ? parseWeather(JSON.parse(this.env.FAKE_WEATHER))
        : await fetchBandungWeather();
      if (weather) this.setWeather(weather, Date.now());
      else console.log("FAKE_WEATHER has the wrong format, see .dev.vars");
    } catch (err) {
      console.log("Weather update failed, keeping the last reading:", err);
    }
    this.load(Date.now()); // notices a shutdown even when nobody is online
  }

  /** For GET /state: the smoke check now, your portfolio card later. */
  async getState() {
    const now = Date.now();
    return { pet: this.load(now), weather: this.weather(), online: this.online(), now };
  }

  private setWeather(weather: Weather, now: number) {
    const pet = this.load(now); // catch up at the old speed first
    applyWeather(pet, weather, now);
    this.kvSet("weather", weather);
    this.save(pet);
    this.broadcast(this.stateMsg(pet, now));
  }

  private weather(): Weather {
    return this.kvGet<Weather>("weather") ?? DEFAULT_WEATHER;
  }

  /** Reads Ohm from SQLite and applies the drain up to `now`. */
  private load(now: number): Pet {
    let pet = this.kvGet<Pet>("pet");
    if (!pet) {
      pet = newPet(now, this.weather());
      this.save(pet);
    }
    if (catchUp(pet, now)) {
      this.save(pet);
      this.broadcast({ t: "event", e: this.log(pet.offAt!, "shutdown", "", "Ohm") });
      this.broadcast(this.stateMsg(pet, now)); // everyone switches to "off" and sees the Reboot button
    }
    return pet;
  }

  private save(pet: Pet) {
    this.kvSet("pet", pet);
  }

  private stateMsg(pet: Pet, now: number): ServerMsg {
    return { t: "state", pet, weather: this.weather(), now };
  }

  private kvGet<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private kvSet(key: string, value: unknown) {
    this.sql.exec(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  private log(at: number, type: FeedEvent["type"], whoId: string, name: string): FeedEvent {
    const { id } = this.sql
      .exec<{ id: number }>(
        "INSERT INTO events (at, type, who_id, who_name) VALUES (?, ?, ?, ?) RETURNING id",
        at,
        type,
        whoId,
        name,
      )
      .one();
    return { id, at, type, name };
  }

  private feed(): FeedEvent[] {
    return this.sql
      .exec<FeedEvent>(`SELECT id, at, type, who_name AS name FROM events ORDER BY id DESC LIMIT ${FEED_SIZE}`)
      .toArray();
  }

  private online() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1).length; // 1 = OPEN
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // socket is closing
      }
    }
  }
}