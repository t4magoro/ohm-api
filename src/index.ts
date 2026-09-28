import { pet } from "./wasm";

// Only these websites may call the API from a browser.
const ALLOWED_ORIGINS = ["https://t4magoro.github.io", "http://localhost:3001"];

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    const cors: Record<string, string> = ALLOWED_ORIGINS.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : {};

    if (url.pathname === "/hello") {
      return Response.json({ message: "API says hi", cppSays: pet.add(1, 1) }, { headers: cors });
    }
    return new Response("Not found", { status: 404, headers: cors });
  },
} satisfies ExportedHandler;