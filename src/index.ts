export { Ohm } from "./ohm";

// Only these websites may call the API from a browser.
const ALLOWED_ORIGINS = ["https://t4magoro.github.io", "http://localhost:3001"];

/** Compares in constant time, so how long it takes doesn't reveal how much of a guess was right. */
function tokenOk(given: string, expected: string | undefined) {
  if (!expected) return false; // no ADMIN_TOKEN set: the admin API stays closed
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors: Record<string, string> = allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    // There is exactly one Ohm, so every request goes to the same Durable Object.
    const ohm = env.OHM.get(env.OHM.idFromName("ohm"));

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      // Stops other websites from connecting. Scripts can fake Origin; the rate limits handle those.
      if (!allowed) return new Response("Origin not allowed", { status: 403 });
      return ohm.fetch(request);
    }
    if (url.pathname === "/state") {
      return Response.json(await ohm.getState(), { headers: cors });
    }
    if (url.pathname === "/vitals") {
      return Response.json(await ohm.getVitals(), { headers: cors });
    }

    if (url.pathname.startsWith("/admin/")) {
      const headers = {
        ...cors,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST",
      };
      // The browser asks first ("preflight") before sending a request with a token header.
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      if (!tokenOk(token, env.ADMIN_TOKEN)) {
        return Response.json({ error: "Wrong or missing admin token" }, { status: 401, headers });
      }
      const action = url.pathname.slice("/admin/".length);
      if (request.method === "GET" && action === "overview") return Response.json(await ohm.adminOverview(), { headers });
      if (request.method === "POST") {
        const result = await ohm.admin(action, await request.json().catch(() => null));
        return Response.json(result, { status: "error" in result ? 400 : 200, headers });
      }
      return Response.json({ error: "Not found" }, { status: 404, headers });
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Env>;