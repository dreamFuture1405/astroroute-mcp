# AstroRoute

AstroRoute is an Astro-weather location comparison MCP server on Cloudflare Workers. It ranks two or three candidate cities for reflective practice using a Western sky profile, live weather, and optional place context.

## What it does

Given a mood activation score, candidate City objects, and optional rich context, AstroRoute returns:

- Ranked candidate locations
- `astroWeatherFitScore` and, on the rich path, `v3.finalScoreV3`
- `moodWeatherMismatch`
- `elementWeatherAlignment` with signal explanations
- `dayNightTimingNote`
- `bestReflectionWindow`
- `whyFirstPlace`
- Optional four-axis mood profile metadata
- Optional Wikimedia place context, tags, evidence terms, and fallback state
- The exact safety disclaimer

The deployed Worker version is 0.3.0.

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
- Deterministic scoring in `src/scoring.ts`
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

Required comparison fields are `moodScore` from 0 to 10 and two or three candidate cities. Optional v0.3 fields are:

```json
{
  "moodProfile": {
    "energy": 7,
    "stress": 4,
    "focus": 6,
    "socialBattery": 7
  },
  "includePlaceContext": true
}
```

A request without the optional rich fields keeps `methodVersion: "score-v1"`, the existing core response fields, and the existing score-v1 formula. A request with `moodProfile` or `includePlaceContext` uses `methodVersion: "score-v3"` and returns rich metadata such as `derivedMoodProfile`, `rankedLocations[].v3`, `placeContextList`, and `scoreV3Weights`.

The browser UI has four mood sliders, each defaulting to 5. It sends `moodScore` equal to the energy slider for compatibility, sends the full `moodProfile`, and provides an opt-in Wikimedia context checkbox.

## Scoring

The score-v1 path uses:

- `weatherActivation`: bounded 0 to 10 signal from temperature comfort, daylight, wind, cloud cover, and precipitation
- `moodWeatherMismatch`: `round(abs(moodScore - weatherActivation) * 10)`
- `elementWeatherAlignment`: bounded 0 to 100 signal from sky elements and observable weather
- `reflectionWindowQuality`: bounded 0 to 100 quality of the best one-hour slot
- `astroWeatherFitScore`: `round(0.45 * element + 0.35 * (100 - mismatch) + 0.20 * window)`

The score-v3 path keeps the score-v1 result as its base and adds bounded mood and place components. Baseline weights are base 0.70, mood 0.20, and place 0.10 when both components are active. Active weights adjust when only one optional component is active. These weights are design heuristics, not scientific or predictive conclusions.

Wikimedia tags use a closed taxonomy: `coastal`, `urban_dense`, `historic`, `green_space`, `creative`, `quiet`, `nightlife`, and `transit_hub`. Tags are inferred from bounded title, description, and extract text. They are heuristic context, not factual classifications.

## MCP tools

The server exposes exactly eight tools:

1. `get_western_sky_profile` returns a geocentric tropical Western sky snapshot.
2. `get_location_weather` returns current conditions, 24 hourly records, sunrise, and sunset.
3. `compare_astro_weather_locations` ranks candidate cities and returns windows and explanations.
4. `get_agent_test_fixture` returns fixed inputs, expected fields, invariants, and the eight-tool set.
5. `explain_score_components` explains a selected candidate's weighted score.
6. `find_reflection_window` returns the strongest one-hour and three-hour windows for one City.
7. `generate_agent_brief` returns a compact downstream-agent handoff.
8. `get_place_context` returns Wikimedia place context directly to an agent.

See `public/agents-guide.md` for request examples and response fields.

## Core file set

The runtime implementation and documentation set contains 14 core files:

1. `package.json`
2. `wrangler.jsonc`
3. `src/index.ts`
4. `src/astro.ts`
5. `src/weather.ts`
6. `src/scoring.ts`
7. `src/mcp.ts`
8. `src/place.ts`
9. `public/index.html`
10. `public/styles.css`
11. `public/app.js`
12. `public/agents-guide.md`
13. `README.md`
14. `test-plan.md`

The repository also contains a pre-existing `test_connection_check.txt` file. It is not part of the runtime contract and is intentionally unchanged by the v0.3 UI and documentation update.

## Local development

```bash
npm install
npx wrangler dev
```

For local development, provide the Worker secret through an uncommitted `.dev.vars` file or the normal Wrangler secret workflow:

```text
FREE_ASTROLOGY_API_KEY=your_key_here
```

Never commit `.dev.vars` or a real key.

## Deployment

1. Connect the repository to a Cloudflare Worker through the Cloudflare Dashboard, or authenticate Wrangler locally.
2. Set `FREE_ASTROLOGY_API_KEY` as a Worker secret.
3. Run `npx wrangler deploy` when deploying manually.
4. Verify `GET /healthz`, the static UI, `/agents-guide.md`, the REST comparison, and the MCP endpoint.

The v0.3 test sequence and stop conditions are in `test-plan.md`.

## Security

- `FREE_ASTROLOGY_API_KEY` is used only server-side by the Worker.
- The browser calls only same-origin `/api/compare`.
- No provider key is included in public assets, response bodies, or response headers.
- Upstream errors are sanitized and raw upstream bodies are not returned.
- No LLM is used in the scoring path.

## Limitations

- Weather and rankings are dynamic and can change between requests.
- The geocentric sky profile is shared across candidate cities in one comparison.
- Wikimedia summaries can be incomplete or unavailable.
- Scoring weights and tag mappings are explicit heuristics.
- The tool does not provide medical, financial, legal, or predictive advice.

## Disclaimer

Reflective practice only. Not medical, financial, legal, or predictive advice.