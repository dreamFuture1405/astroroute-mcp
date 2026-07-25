// AstroRoute Worker entry.
// Routes:
//   POST /mcp                - MCP Streamable HTTP (agents/mcp)
//   POST /api/compare        - REST adapter for the browser
//   GET  /healthz            - health check
//   GET  /agents-guide.md    - served from public/ assets
//   GET  /*                  - static assets (public/)
//
// CORS is open for any origin. Browser only calls same-origin /api/compare.

import { createAstroRouteMcpServer } from "./mcp";
import { compareLocations, validateCompareInput } from "./scoring";

export interface Env {
  ASSETS: Fetcher;
  FREE_ASTROLOGY_API_KEY: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Accept",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();

    // MCP endpoint (Streamable HTTP). Stateless: new server per request.
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      const server = createAstroRouteMcpServer();
      const handler = (await import("agents/mcp")).createMcpHandler(server);
      return handler.fetch(request, env, ctx);
    }

    // Health check (no provider calls).
    if (url.pathname === "/healthz") {
      return jsonResponse(
        { status: "ok", service: "astroroute", scoring: "score-v1" },
        200
      );
    }

    // REST adapter: same domain service as compare_astro_weather_locations MCP tool.
    if (url.pathname === "/api/compare" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "invalid_input",
              message: "Request body must be valid JSON.",
              retryable: false,
            },
          },
          400
        );
      }
      const validation = validateCompareInput(body);
      if (!validation.ok) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "invalid_input",
              message: validation.error,
              retryable: false,
            },
          },
          400
        );
      }
      try {
        const result = await compareLocations(env, validation.value);
        return jsonResponse({ ok: true, ...result }, 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const code = message.includes("Free Astrology API")
          ? "upstream_unavailable"
          : message.includes("Open-Meteo")
          ? "upstream_unavailable"
          : "internal_error";
        return jsonResponse(
          {
            ok: false,
            error: { code, message: "Provider or internal error.", retryable: true },
          },
          502
        );
      }
    }

    // Fallback: static assets (public/). Serves index.html, app.js, styles.css, agents-guide.md, etc.
    return env.ASSETS.fetch(request);
  },
};