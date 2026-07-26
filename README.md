# AstroRoute

Astro-Weather Location Comparison MCP server on Cloudflare Workers.

## What it does

Given the user's current mood activation (0-10) and 2-3 candidate cities, AstroRoute returns:

- Ranked candidate locations
- `astroWeatherFitScore` (0-100) per location
- `moodWeatherMismatch` (0-100) per location
- `elementWeatherAlignment` (0-100) per location with signal explanation
- `dayNightTimingNote` per location
- `bestReflectionWindow` (start, end, quality, reason) per location
- `whyFirstPlace` (top-level explanation)
- Safety disclaimer (reflective practice only; not medical, financial, legal, or predictive advice)

With Attempt #2, three additional agent-facing MCP tools are available:

- `explain_score_components` - detailed score breakdown for a selected candidate
- `find_reflection_window` - best 1-hour and 3-hour windows for a single location
- `generate_agent_brief` - compact JSON brief for downstream agent consumption

## Architecture

- Cloudflare Worker Free plan
- Static frontend served by the same Worker (via Static Assets)
- MCP Streamable HTTP endpoint at `/mcp`
- REST adapter at `/api/compare` (same domain service as the MCP tool)
- Health check at `/healthz`
- Agents Guide served as static asset at `/agents-guide.md`
- Free Astrology API for sky profiles (server-side key)
- Open-Meteo for weather (no key required)
- No LLM in the comparison path
- Deterministic scoring engine (`score-v1`)
- No Durable Objects (stateless McpServer per request)

## File list (v2, exactly 13 files)

1. `package.json` - dependencies and scripts
2. `wrangler.jsonc` - Cloudflare Worker config
3. `src/index.ts` - Worker entry: routing, MCP delegation, REST adapter, static asset fallback
4. `src/astro.ts` - Free Astrology API client (Western/Planets, geocentric)
5. `src/weather.ts` - Open-Meteo client (current + 24h hourly + sunrise/sunset)
6. `src/scoring.ts` - zod validation + scoring math + comparison orchestration + new agent helpers
7. `src/mcp.ts` - MCP server factory with 7 tools
8. `public/index.html` - frontend form + result display
9. `public/styles.css` - frontend styles
10. `public/app.js` - frontend logic
11. `public/agents-guide.md` - MCP integration guide (7 tools documented)
12. `README.md` - this file
13. `test-plan.md` - local validation checklist (no automated tests in v2)

## Local development

```bash
npm install
npx wrangler dev
```

The Worker expects `FREE_ASTROLOGY_API_KEY` to be set as a secret. For local dev, create a `.dev.vars` file (do not commit it):

```
FREE_ASTROLOGY_API_KEY=your_key_here
```

## Deploy (manual Cloudflare Git deployment)

1. Push this repository to GitHub.
2. In Cloudflare Dashboard, create a new Worker connected to the repository, OR run `npx wrangler deploy` after authenticating with Cloudflare.
3. Set the secret:
   ```bash
   npx wrangler secret put FREE_ASTROLOGY_API_KEY
   ```
4. Verify with `GET https://<your-worker>.workers.dev/healthz`.

## Required secrets

- `FREE_ASTROLOGY_API_KEY` - Free Astrology API key (server-side only)

Open-Meteo is keyless for normal public usage.

## MCP tools (7 total)

1. `get_western_sky_profile` - fetch geocentric sky profile for a reference location and timestamp
2. `get_location_weather` - fetch current + 24h hourly + sunrise/sunset for a city
3. `compare_astro_weather_locations` - main entry: rank 2-3 cities by reflection-window fit
4. `get_agent_test_fixture` - return a fixed test fixture with expected schema/invariants
5. `explain_score_components` - detailed score breakdown for a named candidate
6. `find_reflection_window` - best 1-hour and 3-hour windows for a single location
7. `generate_agent_brief` - compact brief for downstream agent consumption

## Scoring (score-v1)

- `weatherActivation` (0-10): weighted from temperature comfort, daylight, wind, cloud, precipitation
- `moodWeatherMismatch` (0-100): `round(abs(moodScore - weatherActivation) * 10)`
- `elementWeatherAlignment` (0-100): element-based bonuses grounded in observable weather signals
- `reflectionWindowQuality` (0-100): best 1-hour slot in the next 24 hours
- `astroWeatherFitScore` (0-100): `round(0.45 * element + 0.35 * (100 - mismatch) + 0.20 * window)`

Tie-break: lower mismatch, then earlier window, then input order.

## Reflection window scoring (reflection-window-v1)

- Uses same three factor families as score-v1 applied per hourly slot
- Three-hour quality is the rounded mean of three consecutive hourly scores
- Fallback threshold: 65 (both best 1-hour and best 3-hour below 65 triggers fallback)

## Limitations

- Free Astrology API: 50 calls/day free tier, 1 call/sec rate limit.
- Geocentric sky profile is shared across cities in one comparison (1 astrology call per comparison).
- Scoring weights are design assumptions; human-interpretation gates are described in `test-plan.md`.
- Reflective practice only. Not medical, financial, legal, or predictive advice.