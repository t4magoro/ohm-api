export { Ohm } from "./ohm";

// Only these websites may call the API from a browser.
const ALLOWED_ORIGINS = ["https://t4magoro.github.io", "http://localhost:3001"];

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
    return new Response("Not found", { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Env>;