# AstroRoute

AstroRoute is an Astro-weather location comparison MCP server on Cloudflare Workers. It ranks two or three candidate cities for reflective practice using a Western sky profile, live weather, optional Wikimedia place context, and optional NOAA SWPC space weather.

## What it does

Given a mood activation score, candidate City objects, and optional rich context, AstroRoute returns:

- Ranked candidate locations
- `astroWeatherFitScore` and, on the rich path, `v3.finalScoreV3` or `v4` composite score
- `moodWeatherMismatch`
- `elementWeatherAlignment` with signal explanations
- `dayNightTimingNote`
- `bestReflectionWindow`
- `whyFirstPlace`
- Optional four-axis mood profile metadata
- Optional Wikimedia place context, tags, evidence terms, and fallback state
- Optional NOAA SWPC global space weather data (Kp index, solar activity, sunspot count, spaceWeatherFit)
- The exact safety disclaimer

The deployed Worker version is 0.4.0.

## Architecture

- Cloudflare Worker with Static Assets
- Same-origin frontend at `/`
- MCP Streamable HTTP endpoint at `/mcp`
- REST adapter at `POST /api/compare`
- Health check at `GET /healthz`
- Agents Guide at `/agents-guide.md`
- Free Astrology API western/planets adapter in `src/astro.ts`
- Open-Meteo weather adapter in `src/weather.ts`
- Keyless Wikimedia OpenSearch and English Wikipedia Page Summary adapter in `src/place.ts`
- Keyless NOAA SWPC space weather adapter in `src/spaceweather.ts`
- Deterministic scoring in `src/scoring.ts` (v1 and v3)
- Score-v4 extension in `src/scoring-v4.ts` (imports from scoring.ts and spaceweather.ts)
- Stateless MCP server factory in `src/mcp.ts`
- No LLM, database, or new paid provider in the comparison path

## Input and compatibility

Every comparison uses this City shape:

```json
{
  "name": "Tokyo",
  "latitude": 35.6762,
  "longitude": 139.6503,
  "timezone": "Asia/Tokyo"
}
```

Required comparison fields are `moodScore` from 0 to 10 and two or three candidate cities. Optional fields are:

- `moodProfile` (v0.3): four-axis mood profile
- `includePlaceContext` (v0.3): boolean, fetches Wikimedia context
- `includeSpaceWeather` (v0.4): boolean, fetches NOAA SWPC space weather

A request without any optional fields keeps `methodVersion: "score-v1"`. With `moodProfile` or `includePlaceContext`, it uses `score-v3`. With `includeSpaceWeather: true`, it uses `score-v4`.

The browser UI has four mood sliders, a place-context checkbox, and a space-weather checkbox.

## Scoring

### score-v1

- `astroWeatherFitScore`: `round(0.45 * element + 0.35 * (100 - mismatch) + 0.20 * window)`

### score-v3

- base 0.70, mood 0.20, place 0.10 (when both active)

### score-v4 (NEW)

- When NOAA SWPC succeeds: base 0.55, mood 0.18, place 0.10, spaceWeather 0.17
- When NOAA SWPC unavailable: base 0.65, mood 0.22, place 0.13, spaceWeather 0 (renormalized)
- Space weather is global: all cities share the same spaceWeatherFit value

## MCP tools

The server exposes exactly nine tools:

1. `get_western_sky_profile` returns a geocentric tropical Western sky snapshot.
2. `get_location_weather` returns current conditions, 24 hourly records, sunrise, and sunset.
3. `compare_astro_weather_locations` ranks candidate cities and returns windows and explanations.
4. `get_agent_test_fixture` returns fixed inputs, expected fields, invariants, and the nine-tool set.
5. `explain_score_components` explains a selected candidate's weighted score.
6. `find_reflection_window` returns the strongest one-hour and three-hour windows for one City.
7. `generate_agent_brief` returns a compact downstream-agent handoff.
8. `get_place_context` returns Wikimedia place context directly to an agent.
9. `get_space_weather_context` returns global NOAA SWPC space weather data directly to an agent.

See `public/agents-guide.md` for request examples and response fields.

## Core file set

The runtime implementation and documentation set contains 15 core files:

1. `package.json`
2. `wrangler.jsonc`
3. `src/index.ts`
4. `src/astro.ts`
5. `src/weather.ts`
6. `src/scoring.ts`
7. `src/scoring-v4.ts`
8. `src/mcp.ts`
9. `src/place.ts`
10. `src/spaceweather.ts`
11. `public/index.html`
12. `public/styles.css`
13. `public/app.js`
14. `public/agents-guide.md`
15. `README.md`
16. `test-plan.md`

## Local development

```bash
npm install
npx wrangler dev
```

For local development, provide the Worker secret through an uncommitted `.dev.vars` file:

```text
FREE_ASTROLOGY_API_KEY=your_key_here
```

Never commit `.dev.vars` or a real key.

## Deployment

1. Connect the repository to a Cloudflare Worker through the Cloudflare Dashboard.
2. Set `FREE_ASTROLOGY_API_KEY` as a Worker secret.
3. NOAA SWPC endpoints are keyless and public; no additional secrets needed.
4. Run `npx wrangler deploy` when deploying manually.
5. Verify `GET /healthz`, the static UI, `/agents-guide.md`, the REST comparison, and the MCP endpoint.

## Security

- `FREE_ASTROLOGY_API_KEY` is used only server-side by the Worker.
- The browser calls only same-origin `/api/compare`.
- NOAA SWPC endpoints are keyless and public.
- No LLM is used in the scoring path.

## Limitations

- Weather and rankings are dynamic and can change between requests.
- The geocentric sky profile is shared across candidate cities in one comparison.
- Wikimedia summaries can be incomplete or unavailable.
- NOAA SWPC data is global, not per-city.
- Scoring weights are heuristics and should not be treated as scientific conclusions.

## Disclaimer

Reflective practice only. Not medical, financial, legal, or predictive advice.
