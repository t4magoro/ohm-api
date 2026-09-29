// What happened: the live feed (the events table) and what Ohm said (the lines table). See schema.ts.
import type { FeedEvent, Line } from "./protocol";

const FEED_SIZE = 30;
const LINES_SHOWN = 20;

/** Adds one event to the feed and returns it, ready to broadcast. */
export function logEvent(
  sql: SqlStorage,
  at: number,
  type: FeedEvent["type"],
  whoId: string,
  name: string,
  detail: string | null = null,
) {
  const { id } = sql
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

/** The newest events, newest first, for visitors who just arrived. */
export function feed(sql: SqlStorage): FeedEvent[] {
  return sql
    .exec<FeedEvent>(`SELECT id, at, type, who_name AS name, detail FROM events ORDER BY id DESC LIMIT ${FEED_SIZE}`)
    .toArray();
}

/** Saves something Ohm said to a visitor and returns it, ready to broadcast. */
export function saveLine(sql: SqlStorage, at: number, text: string, toName: string, ipHash: string): Line {
  return sql
    .exec<Line>(
      `INSERT INTO lines (at, text, to_name, ip_hash) VALUES (?, ?, ?, ?) RETURNING id, at, text, to_name AS "to"`,
      at,
      text,
      toName,
      ipHash,
    )
    .one();
}

/** Ohm's last lines, oldest first, for visitors who just arrived. */
export function lines(sql: SqlStorage): Line[] {
  return sql
    .exec<Line>(`SELECT id, at, text, to_name AS "to" FROM lines ORDER BY id DESC LIMIT ${LINES_SHOWN}`)
    .toArray()
    .reverse();
}
