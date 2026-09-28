import { DurableObject } from "cloudflare:workers";
import { brainStats, createBrainTables, hear, reply, tokenize } from "./brain";
import { cooldown, parseClientMessage } from "./guard";
import { lexicon } from "./lexicon";
import { act, applyWeather, catchUp, isSulking, newPet } from "./pet";
import type { Brain, FeedEvent, Line, Pet, ServerMsg, Weather } from "./protocol";
import { DEFAULT_WEATHER, fetchBandungWeather, parseWeather } from "./weather";

const MAX_SOCKETS_PER_IP = 5;
const FEED_SIZE = 30;
const LINES_SHOWN = 20;
const WEATHER_EVERY = 15 * 60_000; // Open-Meteo refreshes every 15 minutes

/** What Ohm remembers about each open WebSocket. Stored on the socket, so it survives hibernation. */
type Visitor = { ip: string; id: string; name: string; helloAt: number };

// The one and only Ohm. Every visitor connects to this single object, and it handles
// one message at a time, so there is never more than one copy of Ohm's state.
export class Ohm extends DurableObject<Env> {
  private sql: SqlStorage;
  private careAllowed = cooldown(3_000);
  private sayAllowed = cooldown(10_000);
  private reportAllowed = cooldown(30_000);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER, type TEXT, who_id TEXT, who_name TEXT)",
    );
    this.sql.exec("CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY, at INTEGER, text TEXT, to_name TEXT)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, at INTEGER, line_id INTEGER, text TEXT, by_id TEXT)",
    );
    createBrainTables(this.sql);
    // Schema changes for tables that already exist on the live Ohm. Each runs once, in order.
    if ((this.kvGet<number>("schema") ?? 1) < 2) {
      this.sql.exec("ALTER TABLE events ADD COLUMN detail TEXT");
      this.kvSet("schema", 2);
    }
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
      this.send(ws, { t: "lines", lines: this.lines() });
      this.broadcast({ t: "online", online: this.online() });
      return;
    }
    if (msg.t === "say") return this.say(ws, me, msg.text, now);
    if (msg.t === "report") return this.report(ws, me, msg.lineId, now);

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

  /** A visitor talks to Ohm. Ohm learns from it and answers everyone, using only words it knows. */
  private say(ws: WebSocket, me: Visitor, text: string, now: number) {
    if (!this.sayAllowed(me.ip, now)) {
      return this.send(ws, { t: "error", msg: "Ohm is still thinking: one message every 10 seconds" });
    }
    const pet = this.load(now);
    if (pet.status === "off") return this.send(ws, { t: "error", msg: "Ohm is off. Reboot it first" });

    const words = tokenize(text);
    const heard = hear(this.sql, lexicon, words, me, now);
    if (heard.blocked) return this.send(ws, { t: "error", msg: "Ohm covers its ears 🙉 That word isn't allowed" });
    if (heard.learned.length > 0) {
      this.kvSet("brain", brainStats(this.sql));
      this.broadcast({ t: "event", e: this.log(now, "taught", me.id, me.name, heard.learned.join(", ")) });
    }

    let answer: string;
    if (isSulking(pet, now)) {
      answer = "… (Ohm is sulking. Play with it first)";
    } else {
      act(pet, "chat", now, this.weather());
      this.save(pet);
      answer = reply(this.sql, words) ?? "beep?";
      if (!this.weather().isDay) answer = `zzz… ${answer}`; // it talks in its sleep
    }
    const line = this.sql
      .exec<Line>(
        `INSERT INTO lines (at, text, to_name) VALUES (?, ?, ?) RETURNING id, at, text, to_name AS "to"`,
        now,
        answer,
        me.name,
      )
      .one();
    this.broadcast({ t: "line", line });
    this.broadcast(this.stateMsg(pet, now));
  }

  /** A visitor flags one of Ohm's lines. You'll review reports on the admin page (Phase 3b). */
  private report(ws: WebSocket, me: Visitor, lineId: number, now: number) {
    if (!this.reportAllowed(me.ip, now)) return this.send(ws, { t: "error", msg: "One report every 30 seconds" });
    const line = this.sql.exec<{ text: string }>("SELECT text FROM lines WHERE id = ?", lineId).toArray()[0];
    if (!line) return this.send(ws, { t: "error", msg: "That line doesn't exist" });
    this.sql.exec("INSERT INTO reports (at, line_id, text, by_id) VALUES (?, ?, ?, ?)", now, lineId, line.text, me.id);
    this.send(ws, { t: "notice", msg: "Thanks! The report was sent for review." });
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
    return { pet: this.load(now), weather: this.weather(), brain: this.brain(), online: this.online(), now };
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

  /** Kept in kv and recalculated only when Ohm learns a word, so it's cheap to send often. */
  private brain(): Brain {
    let brain = this.kvGet<Brain>("brain");
    if (!brain) {
      brain = brainStats(this.sql);
      this.kvSet("brain", brain);
    }
    return brain;
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
    return { t: "state", pet, weather: this.weather(), brain: this.brain(), now };
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

  private log(at: number, type: FeedEvent["type"], whoId: string, name: string, detail: string | null = null) {
    const { id } = this.sql
      .exec<{ id: number }>(
        "INSERT INTO events (at, type, who_id, who_name, detail) VALUES (?, ?, ?, ?, ?) RETURNING id",
        at,
        type,
        whoId,
        name,
        detail,
      )
      .one();
    return { id, at, type, name, detail } satisfies FeedEvent;
  }

  private feed(): FeedEvent[] {
    return this.sql
      .exec<FeedEvent>(
        `SELECT id, at, type, who_name AS name, detail FROM events ORDER BY id DESC LIMIT ${FEED_SIZE}`,
      )
      .toArray();
  }

  /** Ohm's last lines, oldest first, for visitors who just arrived. */
  private lines(): Line[] {
    return this.sql
      .exec<Line>(`SELECT id, at, text, to_name AS "to" FROM lines ORDER BY id DESC LIMIT ${LINES_SHOWN}`)
      .toArray()
      .reverse();
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