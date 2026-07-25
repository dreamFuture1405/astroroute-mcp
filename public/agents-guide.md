# AstroRoute Agent Guide

AstroRoute is an MCP-accessible astro-weather location comparison tool. It compares 2-3 candidate cities and recommends the best reflection window based on the user's mood, the current astrological sky profile, and the weather at each location.

## MCP endpoint

URL: `https://<your-worker>.workers.dev/mcp`
Transport: Streamable HTTP (stateless, no session required)

## Tools

### 1. get_western_sky_profile
- **Input:** `{ asOfUtc?: ISO8601, referenceLocation: { name, latitude, longitude, timezone } }`
- **Output:** `WesternSkyProfile` with `planets[]`, `elementBalance`, `dominantElements`
- **Provider:** freeastrologyapi.com (geocentric, tropical, English)

### 2. get_location_weather
- **Input:** `{ city: { name, latitude, longitude, timezone } }`
- **Output:** `Weather` with current conditions, 24-hour hourly forecast, and sunrise/sunset
- **Provider:** open-meteo.com (no API key required)

### 3. compare_astro_weather_locations
- **Input:** `{ moodScore: 0-10, candidates: City[2-3], asOfUtc?: ISO8601 }`
- **Output:** `ComparisonResult` with ranked locations, `astroWeatherFitScore`, `moodWeatherMismatch`, `elementWeatherAlignment`, `dayNightTimingNote`, `bestReflectionWindow`, `whyFirstPlace`, and the safety disclaimer
- **Note:** moodScore is a self-reported activation (0 = very low / quiet energy, 10 = very high / activated energy), not a medical mood diagnosis.

### 4. get_agent_test_fixture
- **Input:** `{ fixtureId?: "three_city_live_v1" | "validation_errors_v1" }`
- **Output:** Fixed test inputs + expected schema/invariant assertions. Live scores are not guaranteed because weather changes.

## Scoring (version score-v1)

- `weatherActivation` (0-10): weighted score from apparent-temperature comfort, daylight, wind, cloud cover, and precipitation
- `moodWeatherMismatch` (0-100): `round(abs(moodScore - weatherActivation) * 10)` (lower is closer to your activation)
- `elementWeatherAlignment` (0-100): element-based bonuses that match dominant sky elements against observable weather signals
- `reflectionWindowQuality` (0-100): the most "reflective" 1-hour window in the next 24 hours
- `astroWeatherFitScore` (0-100): `round(0.45 * element + 0.35 * (100 - mismatch) + 0.20 * window)`

**Tie-break:** lower mismatch wins, then earlier window start, then input order.

The weight set is a design assumption; the local validation checklist includes a human-interpretation gate before any production use.

## REST adapter

`POST /api/compare` with the same body as `compare_astro_weather_locations` returns the same `ComparisonResult` JSON. Used by the in-page frontend.

## Health check

`GET /healthz` returns `{ status: "ok", service: "astroroute", scoring: "score-v1" }`.

## Security

- `FREE_ASTROLOGY_API_KEY` is a Worker secret; never exposed to the browser or to MCP clients.
- All inputs are validated with strict zod schemas (see `src/scoring.ts`).
- No LLM is involved in the comparison logic; scoring is fully deterministic.
- Browser only calls same-origin `/api/compare`. No third-party network calls from the frontend.

## Disclaimer

Reflective practice only. Not medical, financial, legal, or predictive advice.