import { DurableObject } from "cloudflare:workers";
import { approveWord, blockWord, overview, parseAdminCommand, search, unblockWord } from "./admin";
import { brainStats, hasBlocked, hear, reply, tokenize } from "./brain";
import { cooldown, hashIp, parseClientMessage } from "./guard";
import { lexicon } from "./lexicon";
import { act, applyConditions, catchUp, isSulking, newPet, type Conditions } from "./pet";
import {
  BANNED,
  DEFAULT_SETTINGS,
  type Brain,
  type FeedEvent,
  type Line,
  type MilestoneId,
  type Pet,
  type ServerMsg,
  type Settings,
  type Vitals,
  type Weather,
} from "./protocol";
import { migrate } from "./schema";
import { away, reached, snapshot, standing, vitals } from "./vitals";
import { DEFAULT_WEATHER, fetchBandungWeather, parseWeather } from "./weather";

const MAX_SOCKETS_PER_IP = 5;
const FEED_SIZE = 30;
const LINES_SHOWN = 20;
const WEATHER_EVERY = 15 * 60_000; // Open-Meteo refreshes every 15 minutes
const VITALS_EVERY = 5 * 60_000; // GET /vitals is recalculated at most this often

/** What Ohm remembers about each open WebSocket. Stored on the socket, so it survives hibernation. */
type Visitor = { ipHash: string; id: string; name: string; helloAt: number };

// The one and only Ohm. Every visitor connects to this single object, and it handles
// one message at a time, so there is never more than one copy of Ohm's state.
export class Ohm extends DurableObject<Env> {
  private sql: SqlStorage;
  private careAllowed = cooldown(3_000);
  private sayAllowed = cooldown(10_000);
  private reportAllowed = cooldown(30_000);
  private vitalsCache: Vitals | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    migrate(this.sql); // creates or updates the tables: see schema.ts
    // Start the weather alarm if it isn't running yet. With FAKE_WEATHER (local testing only),
    // run it right away, so a changed .dev.vars shows up after a restart.
    ctx.blockConcurrencyWhile(async () => {
      if (env.FAKE_WEATHER || (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
    });
  }

  // A browser opens a WebSocket. The Worker has already checked its Origin.
  async fetch(request: Request): Promise<Response> {
    const ipHash = await hashIp(request.headers.get("CF-Connecting-IP") ?? "local", this.env.IP_SALT ?? "");
    if (this.banned(ipHash)) {
      // Browsers hide why a WebSocket was refused, so accept it and close it straight away with
      // the "banned" code. The page can read that, show "Banned" and stop retrying.
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(BANNED, "Banned");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const mine = this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Visitor).ipHash === ipHash);
    if (mine.length >= MAX_SOCKETS_PER_IP) return new Response("Too many connections", { status: 429 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]); // hibernation API: Ohm can sleep while sockets stay open
    pair[1].serializeAttachment({ ipHash, id: "", name: "Guest", helloAt: 0 } satisfies Visitor);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const me = ws.deserializeAttachment() as Visitor;
    if (this.banned(me.ipHash)) return ws.close(BANNED, "Banned");
    const msg = parseClientMessage(raw);
    if (!msg) return this.send(ws, { t: "error", msg: "Ohm didn't understand that message" });
    const now = Date.now();

    if (msg.t === "hello") {
      // One hello per socket every 2 s: it's sent once on connect and again on rename.
      if (now - me.helloAt < 2_000) return this.send(ws, { t: "error", msg: "Slow down: try again in a moment" });
            // Names show up in everyone's feed, so they pass the same word check as chat messages.
      const nameOk = !hasBlocked(this.sql, lexicon, tokenize(msg.name));
      if (!nameOk) this.send(ws, { t: "error", msg: "That name isn't allowed. Pick another one" });
      ws.serializeAttachment({ ...me, id: msg.id, name: nameOk ? msg.name : me.name, helloAt: now } satisfies Visitor);
      this.send(ws, this.stateMsg(this.load(now), now));
      this.send(ws, { t: "feed", events: this.feed() });
      this.send(ws, { t: "lines", lines: this.lines() });
      if (msg.lastSeen) {
        const summary = away(this.sql, msg.id, msg.lastSeen);
        if (summary.learned > 0 || summary.shutdowns > 0) this.send(ws, { t: "away", ...summary });
      }
      this.broadcast({ t: "online", online: this.online() });
      return;
    }
    if (msg.t === "say") return this.say(ws, me, msg.text, now);
    if (msg.t === "report") return this.report(ws, me, msg.lineId, now);

    if (!this.careAllowed(me.ipHash, now)) {
      return this.send(ws, { t: "error", msg: "Slow down: one action every 3 seconds" });
    }
    const pet = this.load(now);
    const problem = act(pet, msg.t, now, this.conditions());
    if (problem) return this.send(ws, { t: "error", msg: problem });
    this.save(pet);
    this.broadcast({ t: "event", e: this.log(now, msg.t, me.id, me.name) });
    this.unlock(pet, now);
    this.broadcast(this.stateMsg(pet, now));
  }

    /** A visitor talks to Ohm. Ohm answers everyone with words it already knew, then learns from the message. */
  private say(ws: WebSocket, me: Visitor, text: string, now: number) {
    if (!this.sayAllowed(me.ipHash, now)) {
      return this.send(ws, { t: "error", msg: "Ohm is still thinking: one message every 10 seconds" });
    }
    const pet = this.load(now);
    if (pet.status === "off") return this.send(ws, { t: "error", msg: "Ohm is off. Reboot it first" });

    const words = tokenize(text);
    if (hasBlocked(this.sql, lexicon, words)) {
      return this.send(ws, { t: "error", msg: "Ohm covers its ears. That word isn't allowed" });
    }

    // Answer first, learn second. The other way round, a sentence full of new words comes
    // straight back out of Ohm, word for word, to everyone online.
    let answer: string;
    if (isSulking(pet, now)) {
      answer = "… (Ohm is sulking. Play with it first)";
    } else {
      act(pet, "chat", now, this.conditions());
      this.save(pet);
      answer = reply(this.sql, words) ?? "beep?";
      if (!this.weather().isDay) answer = `zzz… ${answer}`; // it talks in its sleep
    }

    const heard = hear(this.sql, lexicon, words, me, now);
    if (heard.learned.length > 0) {
      this.kvSet("brain", brainStats(this.sql));
      this.broadcast({ t: "event", e: this.log(now, "taught", me.id, me.name, heard.learned.join(", ")) });
      this.unlock(pet, now);
    }
    const line = this.sql
      .exec<Line>(
        `INSERT INTO lines (at, text, to_name, ip_hash) VALUES (?, ?, ?, ?) RETURNING id, at, text, to_name AS "to"`,
        now,
        answer,
        me.name,
        me.ipHash,
      )
      .one();
    this.broadcast({ t: "line", line });
    this.broadcast(this.stateMsg(pet, now));
  }

  /** A visitor flags one of Ohm's lines. It shows up on your admin page. */
  private report(ws: WebSocket, me: Visitor, lineId: number, now: number) {
    if (!this.reportAllowed(me.ipHash, now)) return this.send(ws, { t: "error", msg: "One report every 30 seconds" });
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

  /** Every 15 minutes: read Bandung's weather, change the drain speed, notice a shutdown, take the hourly snapshot. */
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
    const now = Date.now();
    const pet = this.load(now); // notices a shutdown even when nobody is online
    snapshot(this.sql, pet, this.brain().vocab, this.online(), now);
    if (this.unlock(pet, now)) this.broadcast(this.stateMsg(pet, now)); // "alive 7 days" grows with time alone
  }

  /** For GET /state: the smoke check now, your portfolio card later. */
  async getState() {
    const now = Date.now();
    const pet = this.load(now);
    return { pet, weather: this.weather(), brain: this.brain(), unlocked: this.unlocked(), online: this.online(), now };
  }

  /** For GET /vitals. Anyone can call it and it reads whole tables, so it's recalculated at most every 5 minutes. */
  async getVitals(): Promise<Vitals> {
    const now = Date.now();
    if (!this.vitalsCache || now - this.vitalsCache.now >= VITALS_EVERY) {
      const s = standing(this.load(now), this.brain().vocab, now);
      this.vitalsCache = vitals(this.sql, s, this.unlocked(), this.brain(), now);
    }
    return this.vitalsCache;
  }

  /** For the admin page. The Worker has already checked your token. */
  async adminOverview() {
    return overview(this.sql, this.settings());
  }

  /** For the admin search box. `q` is already tidied by cleanQuery. */
  async adminSearch(q: string) {
    return search(this.sql, q);
  }

  async admin(action: string, body: unknown): Promise<{ ok: true } | { error: string }> {
    const cmd = parseAdminCommand(action, body);
    if (!cmd) return { error: `Bad "${action}" request` };
    const now = Date.now();

    if (cmd.do === "approve") approveWord(this.sql, cmd.word, cmd.lang, now);
    else if (cmd.do === "block") blockWord(this.sql, cmd.word);
    else if (cmd.do === "unblock") unblockWord(this.sql, cmd.word);
    else if (cmd.do === "unban") this.sql.exec("DELETE FROM bans WHERE ip_hash = ?", cmd.ipHash);
    else if (cmd.do === "dismiss") this.sql.exec("DELETE FROM reports WHERE id = ?", cmd.id);
    else if (cmd.do === "ban") {
      this.sql.exec("INSERT INTO bans (ip_hash, at) VALUES (?, ?) ON CONFLICT (ip_hash) DO NOTHING", cmd.ipHash, now);
      for (const ws of this.ctx.getWebSockets()) {
        if ((ws.deserializeAttachment() as Visitor).ipHash === cmd.ipHash) ws.close(BANNED, "Banned");
      }
    } else if (cmd.do === "unsay") {
      this.sql.exec("DELETE FROM lines WHERE id = ?", cmd.id);
      this.sql.exec("DELETE FROM reports WHERE line_id = ?", cmd.id);
      this.broadcast({ t: "unsay", id: cmd.id });
    } else if (cmd.do === "settings") {
      const pet = this.load(now); // catch up at the old speed first
      this.kvSet("settings", cmd.settings);
      applyConditions(pet, this.conditions(), now);
      this.save(pet);
      this.broadcast(this.stateMsg(pet, now)); // every open page switches speed right away
    }

    if (cmd.do === "approve" || cmd.do === "block") {
      this.kvSet("brain", brainStats(this.sql));
      this.broadcast(this.stateMsg(this.load(now), now)); // the Spellbook updates everywhere
    }
    return { ok: true };
  }

  private banned(ipHash: string) {
    return this.sql.exec("SELECT 1 FROM bans WHERE ip_hash = ?", ipHash).toArray().length > 0;
  }

  private setWeather(weather: Weather, now: number) {
    const pet = this.load(now); // catch up at the old speed first
    this.kvSet("weather", weather);
    applyConditions(pet, this.conditions(), now);
    this.save(pet);
    this.broadcast(this.stateMsg(pet, now));
  }

  private weather(): Weather {
    return this.kvGet<Weather>("weather") ?? DEFAULT_WEATHER;
  }

  private settings(): Settings {
    return this.kvGet<Settings>("settings") ?? DEFAULT_SETTINGS;
  }

  private conditions(): Conditions {
    return { weather: this.weather(), settings: this.settings() };
  }

  /** Kept in kv and recalculated only when the vocabulary changes, so it's cheap to send often. */
  private brain(): Brain {
    let brain = this.kvGet<Brain>("brain");
    if (!brain) {
      brain = brainStats(this.sql);
      this.kvSet("brain", brain);
    }
    return brain;
  }

  /** The parts Ohm has earned. Once unlocked, a milestone stays unlocked. */
  private unlocked(): MilestoneId[] {
    return this.kvGet<MilestoneId[]>("unlocked") ?? [];
  }

  /** Unlocks the milestones Ohm just reached and tells the feed. Returns true if there were any. */
  private unlock(pet: Pet, now: number) {
    const unlocked = this.unlocked();
    const fresh = reached(standing(pet, this.brain().vocab, now), unlocked);
    if (fresh.length === 0) return false;
    this.kvSet("unlocked", [...unlocked, ...fresh]);
    for (const id of fresh) this.broadcast({ t: "event", e: this.log(now, "unlocked", "", "Ohm", id) });
    return true;
  }

  /** Reads Ohm from SQLite and applies the drain up to `now`. */
  private load(now: number): Pet {
    let pet = this.kvGet<Pet>("pet");
    if (!pet) {
      pet = newPet(now, this.conditions());
      this.save(pet);
    }
    if (pet.charges === undefined) {
      // Ohm was saved before Phase 4: count the charges so far, once.
      pet.charges = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'charge'").one().n;
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
    return { t: "state", pet, weather: this.weather(), brain: this.brain(), unlocked: this.unlocked(), now };
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