import { DurableObject } from "cloudflare:workers";
import { cooldown, parseClientMessage } from "./guard";
import { act, catchUp, newPet } from "./pet";
import type { FeedEvent, Pet, ServerMsg } from "./protocol";

const MAX_SOCKETS_PER_IP = 5;
const FEED_SIZE = 30;

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
      this.send(ws, { t: "state", pet: this.load(now), now });
      this.send(ws, { t: "feed", events: this.feed() });
      this.broadcast({ t: "online", online: this.online() });
      return;
    }

    if (!this.careAllowed(me.ip, now)) {
      return this.send(ws, { t: "error", msg: "Slow down: one action every 3 seconds" });
    }
    const pet = this.load(now);
    const problem = act(pet, msg.t, now);
    if (problem) return this.send(ws, { t: "error", msg: problem });
    this.save(pet);
    this.broadcast({ t: "event", e: this.log(now, msg.t, me.id, me.name) });
    this.broadcast({ t: "state", pet, now });
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

  /** For GET /state: the smoke check now, your portfolio card later. */
  async getState() {
    const now = Date.now();
    return { pet: this.load(now), online: this.online(), now };
  }

  /** Reads Ohm from SQLite and applies the drain up to `now`. */
  private load(now: number): Pet {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'pet'").toArray()[0];
    const pet: Pet = row ? JSON.parse(row.value) : newPet(now);
    if (!row) this.save(pet);
    if (catchUp(pet, now)) {
      this.save(pet);
      this.broadcast({ t: "event", e: this.log(pet.offAt!, "shutdown", "", "Ohm") });
      this.broadcast({ t: "state", pet, now }); // everyone switches to "off" and sees the Reboot button
    }
    return pet;
  }

  private save(pet: Pet) {
    this.sql.exec(
      "INSERT INTO kv (key, value) VALUES ('pet', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      JSON.stringify(pet),
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