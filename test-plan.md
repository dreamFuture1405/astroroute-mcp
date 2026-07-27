# AstroRoute v0.4 Release Validation Checklist

Version 0.4.0 adds NOAA SWPC space weather as the fourth dataset. Key changes:

- NEW: `src/spaceweather.ts` (NOAA SWPC adapter, keyless, 3 endpoints, 3600s cache)
- NEW: `src/scoring-v4.ts` (score-v4 path, imports from scoring.ts and spaceweather.ts)
- MODIFIED: `src/mcp.ts` (9th tool get_space_weather_context, Tool 3 extend, version 0.4.0)
- MODIFIED: `src/index.ts` (import scoring-v4, /api/compare v4 routing, /healthz v0.4.0)
- MODIFIED: `public/index.html` (space weather checkbox)
- MODIFIED: `public/app.js` (includeSpaceWeather in request, render v4 data)
- MODIFIED: `public/styles.css` (v4 weight and space weather CSS classes)
- MODIFIED: `public/agents-guide.md` (9 tools documented, score-v4 section)
- MODIFIED: `README.md` (v0.4.0, 15 core files, NOAA SWPC)
- UNCHANGED: `src/scoring.ts` (v1 and v3 paths byte-identical)
- UNCHANGED: `src/astro.ts`, `src/weather.ts`, `src/place.ts`

## Mandatory progress gate: test suite A-J

Run these 10 tests in order against the deployed Worker. Record the HTTP status and a concise response summary for each.

### Test A: GET /healthz

- HTTP 200.
- `version` is `0.4.0`.
- `scoring` is `score-v1-or-score-v3-or-score-v4`.
- `tools` is `9`.

### Test B: MCP initialize

- JSON-RPC initialize returns HTTP 200.
- `serverInfo.name` is `astroroute`.
- `serverInfo.version` is `0.4.0`.

### Test C: MCP tools/list

- HTTP 200.
- Exactly 9 tools returned.
- Includes `get_space_weather_context`.
- All 8 prior tools present: `get_western_sky_profile`, `get_location_weather`, `compare_astro_weather_locations`, `get_agent_test_fixture`, `explain_score_components`, `find_reflection_window`, `generate_agent_brief`, `get_place_context`.

### Test D: MCP get_space_weather_context

- Call with empty params `{}`.
- HTTP 200, `isError: false` (when NOAA succeeds).
- Body has `currentKpIndex` (number 0-9), `geomagneticActivity` (string), `solarActivity` (string), `sunspotCount` (number), `spaceWeatherFit` (number 0-100), `sourceRecords` (array with 3 entries, `provider: "services.swpc.noaa.gov"`).
- If NOAA fails: `spaceWeatherFit: null`, `fallback.reason` present.

### Test E: POST /api/compare with includeSpaceWeather=true

```json
{
  "moodScore": 7,
  "candidates": [
    { "name": "Tokyo", "latitude": 35.6762, "longitude": 139.6503, "timezone": "Asia/Tokyo" },
    { "name": "Reykjavik", "latitude": 64.1466, "longitude": -21.9426, "timezone": "Atlantic/Reykjavik" },
    { "name": "Buenos Aires", "latitude": -34.6037, "longitude": -58.3816, "timezone": "America/Argentina/Buenos_Aires" }
  ],
  "includeSpaceWeather": true
}
```

- HTTP 200.
- `methodVersion: "score-v4"`.
- `scoreV4Weights` present with base + mood + place + spaceWeather summing to 1.0.
- `spaceWeatherBundle` present (or null with fallback if NOAA failed).
- Each ranked location has `v4.spaceWeatherFit`.

### Test F: POST /api/compare without includeSpaceWeather (regression)

```json
{
  "moodScore": 5,
  "candidates": [
    { "name": "Tokyo", "latitude": 35.6762, "longitude": 139.6503, "timezone": "Asia/Tokyo" },
    { "name": "Reykjavik", "latitude": 64.1466, "longitude": -21.9426, "timezone": "Atlantic/Reykjavik" }
  ]
}
```

- HTTP 200.
- `methodVersion: "score-v1"`.
- No v4 fields in response.
- v1 fields unchanged.

### Test G: NOAA fail-soft behavior

If NOAA SWPC returns 429 or 5xx:

- `POST /api/compare` with `includeSpaceWeather: true` still returns HTTP 200 (not 500/502).
- `methodVersion: "score-v4"`.
- `spaceWeatherBundle: null`.
- `spaceWeatherFallback.reason` populated.
- `scoreV4Weights.spaceWeather: 0`.
- Weights renormalized to {base: 0.65, mood: 0.22, place: 0.13}.

### Test H: GET /agents-guide.md

- HTTP 200.
- Lists exactly 9 tools including `get_space_weather_context`.
- Documents NOAA SWPC endpoints and score-v4 weights.

### Test I: Secret scan

- Scan repository source and public assets.
- Confirm no `FREE_ASTROLOGY_API_KEY` value in any public file.
- Confirm no NOAA API key (none needed).
- Confirm no `GEMINI_API_KEY`.
- Confirm no credentials in response headers.

### Test J: GET / (UI)

- HTTP 200.
- HTML contains "Include space weather (NOAA SWPC)" checkbox.
- HTML contains "Include Wikimedia place context" checkbox.
- Four mood sliders present.
- Disclaimer text present.

## Architecture note

The v0.4 score-v4 code lives in `src/scoring-v4.ts` rather than appended to `src/scoring.ts`. This is an architectural choice: scoring.ts (32KB) is preserved byte-identical for v1 and v3 paths. scoring-v4.ts imports from scoring.ts and spaceweather.ts. The functional result is identical: mcp.ts and index.ts route to the v4 path when `includeSpaceWeather=true`.

## Stop and report rule

If any live test fails:

1. Stop immediately at the first failing test.
2. Do not patch, redeploy, retry destructively, or submit.
3. Report the exact HTTP status, response body, relevant headers, test number, and timestamp.
4. Wait for explicit steward approval before changing code or running a new deployment.
