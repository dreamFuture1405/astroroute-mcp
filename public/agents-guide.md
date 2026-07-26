# AstroRoute Agent Guide

AstroRoute is an MCP-accessible astro-weather location comparison tool. It compares 2 to 3 candidate cities and returns ranked locations, reflection windows, score explanations, and a compact agent brief. Version 0.3.0 adds an optional four-axis mood profile and keyless Wikimedia place context while preserving the legacy comparison path.

## Endpoint and transport

MCP endpoint: `https://<your-worker>.workers.dev/mcp`

Transport: Streamable HTTP. The Worker creates a stateless server and transport for each request.

The same Worker also serves:

- `POST /api/compare` for the browser REST adapter
- `GET /healthz` for service status and version
- `GET /agents-guide.md` for this guide
- Static UI assets at `/`

## Common input shapes

### City

```json
{
  "name": "Tokyo",
  "latitude": 35.6762,
  "longitude": 139.6503,
  "timezone": "Asia/Tokyo"
}
```

`name` is 1 to 80 characters. Latitude is -90 to 90. Longitude is -180 to 180. Timezone is a non-empty IANA timezone identifier.

### MoodProfile

```json
{
  "energy": 7,
  "stress": 4,
  "focus": 6,
  "socialBattery": 7
}
```

Each axis is optional and ranges from 0 to 10. Missing axes receive a deterministic default derived from `moodScore` when the rich path is active.

## MCP tools

The deployed server exposes exactly these eight tools. Tool order is not a contract.

1. `get_western_sky_profile`
2. `get_location_weather`
3. `compare_astro_weather_locations`
4. `get_agent_test_fixture`
5. `explain_score_components`
6. `find_reflection_window`
7. `generate_agent_brief`
8. `get_place_context`

### 1. get_western_sky_profile

Input:

```json
{
  "asOfUtc": "2026-07-26T12:00:00Z",
  "referenceLocation": {
    "name": "Tokyo",
    "latitude": 35.6762,
    "longitude": 139.6503,
    "timezone": "Asia/Tokyo"
  }
}
```

`asOfUtc` is optional. The response includes `asOfUtc`, `observationPoint`, `scope`, `planets`, `elementBalance`, `dominantElements`, `provider`, and `fetchedAtUtc`. The sky request uses the Free Astrology API western/planets flow with a geocentric, tropical, English profile. The geocentric profile is shared across candidate cities in a comparison.

### 2. get_location_weather

Input:

```json
{
  "city": {
    "name": "Tokyo",
    "latitude": 35.6762,
    "longitude": 139.6503,
    "timezone": "Asia/Tokyo"
  }
}
```

The response contains `location`, `current`, 24 hourly records, `sunrise`, `sunset`, `provider`, and `fetchedAtUtc`. Weather comes from Open-Meteo and does not require a client API key.

### 3. compare_astro_weather_locations

Required input fields are `moodScore` and `candidates`. Candidates are two or three full `City` objects. Optional fields are `asOfUtc`, `moodProfile`, and `includePlaceContext`.

```json
{
  "moodScore": 7,
  "candidates": [
    {
      "name": "Tokyo",
      "latitude": 35.6762,
      "longitude": 139.6503,
      "timezone": "Asia/Tokyo"
    },
    {
      "name": "Reykjavik",
      "latitude": 64.1466,
      "longitude": -21.9426,
      "timezone": "Atlantic/Reykjavik"
    }
  ],
  "moodProfile": {
    "energy": 7,
    "stress": 4,
    "focus": 6,
    "socialBattery": 7
  },
  "includePlaceContext": true
}
```

The response preserves the core comparison fields:

- `methodVersion`
- `asOfUtc`
- `moodInterpretation`
- `skyProfile`
- `rankedLocations`
- `whyFirstPlace`
- `dataFreshness`
- `disclaimer`

Each ranked location includes `astroWeatherFitScore`, `moodWeatherMismatch`, `elementWeatherAlignment`, `dayNightTimingNote`, `bestReflectionWindow`, `weatherEvidence`, and `scoreComponents`.

When neither optional rich field is active, `methodVersion` is `score-v1` and the existing score-v1 formula and core behavior are preserved. When `moodProfile` or `includePlaceContext` is active, `methodVersion` is `score-v3`. Rich responses can additionally include `derivedMoodProfile`, `placeContextList`, `moodProfileFit`, `scoreV3Weights`, and `rankedLocations[].v3`.

The `v3` object contains `moodFitScore`, `placeFitScore`, `placeContext`, `finalScoreV3`, and `weights`. `placeContextList` follows candidate input order. A ranked location's `v3.placeContext` is the safest way to associate context with that ranked city.

### 4. get_agent_test_fixture

Input:

```json
{
  "fixtureId": "v0_3_wikimedia_tokyo"
}
```

Supported fixture IDs are:

- `three_city_live_v1`
- `validation_errors_v1`
- `v0_3_wikimedia_tokyo`

The fixture response contains fixed inputs, expected schema descriptions, invariants, the eight-tool set, and version metadata. Live weather scores can change. Validate response shape and invariants rather than hard-coding a historical ranking.

### 5. explain_score_components

Input is the full legacy comparison request plus `targetLocationName`.

```json
{
  "moodScore": 5,
  "candidates": [
    {
      "name": "Hanoi",
      "latitude": 21.0285,
      "longitude": 105.8542,
      "timezone": "Asia/Ho_Chi_Minh"
    },
    {
      "name": "Tokyo",
      "latitude": 35.6762,
      "longitude": 139.6503,
      "timezone": "Asia/Tokyo"
    }
  ],
  "targetLocationName": "Tokyo"
}
```

The target name must match exactly one candidate. A zero-match or duplicate-name request returns an MCP error before provider work. The successful response includes `targetLocation`, `scoreBreakdown`, `elementWeatherAlignment`, `bestWindowReasoning`, `caveats`, and `disclaimer`.

`scoreBreakdown` contains:

- `element`: raw score, weight 0.45, weighted contribution
- `moodMatch`: mismatch, inverse score, weight 0.35, weighted contribution
- `window`: raw score, weight 0.20, weighted contribution
- `recomputedTotal`

`recomputedTotal` is `round(0.45 * element + 0.35 * mismatchInverse + 0.20 * window)` and should match the selected location's score.

### 6. find_reflection_window

Input:

```json
{
  "location": {
    "name": "Tokyo",
    "latitude": 35.6762,
    "longitude": 139.6503,
    "timezone": "Asia/Tokyo"
  },
  "moodScore": 5,
  "windowHoursAhead": 24
}
```

`windowHoursAhead` is optional and is constrained to 3 through 24. This tool uses the existing western/planets and Open-Meteo adapters. It does not accept birth data or require a natal-chart endpoint.

The response has `methodVersion: "reflection-window-v1"`, `asOfUtc`, `location`, `moodInterpretation`, `skyProfile`, `best1Hour`, `best3Hours`, `fallback`, `sourceRecords`, `caveats`, and `disclaimer`.

Each window includes local start and end times, timezone, quality score, weather reasons, astro reasons, and mood reasoning. `fallback.used` is true when both best window scores are below threshold 65, and the response then identifies the best available windows.

### 7. generate_agent_brief

Input is the full legacy comparison request:

```json
{
  "moodScore": 5,
  "candidates": [
    {
      "name": "Hanoi",
      "latitude": 21.0285,
      "longitude": 105.8542,
      "timezone": "Asia/Ho_Chi_Minh"
    },
    {
      "name": "Tokyo",
      "latitude": 35.6762,
      "longitude": 139.6503,
      "timezone": "Asia/Tokyo"
    },
    {
      "name": "Singapore",
      "latitude": 1.3521,
      "longitude": 103.8198,
      "timezone": "Asia/Singapore"
    }
  ]
}
```

The response has `schemaVersion: "agent-brief-v1"`, `methodVersion: "score-v1"`, `asOfUtc`, `recommendedCity`, `bestTime`, `why`, `avoidIfConditions`, `sourceRecords`, and `disclaimer`. It is intended for a downstream agent that needs a compact handoff rather than the complete ranked payload.

### 8. get_place_context

Input:

```json
{
  "city": {
    "name": "Tokyo",
    "latitude": 35.6762,
    "longitude": 139.6503,
    "timezone": "Asia/Tokyo"
  }
}
```

The tool uses keyless Wikimedia OpenSearch to resolve a page, then the English Wikipedia REST Page Summary endpoint. The sanitized `PlaceContext` response contains:

- `provider: "wikimedia.org"`
- `resolvedTitle`
- `description`
- `extractSnippet`
- `coordinates` or `null`
- `tags`
- `evidenceTerms`
- `confidenceTier`
- `fallback: { used, reason }`
- `disclaimers`
- `fetchedAtUtc`

Each tag has `tag`, `evidence`, and `confidence`. The closed tag taxonomy is `coastal`, `urban_dense`, `historic`, `green_space`, `creative`, `quiet`, `nightlife`, and `transit_hub`. Tags are bounded text heuristics, not factual or scientific classifications. If Wikimedia cannot resolve or retrieve a page, the tool returns a sanitized fallback state rather than raw upstream content.

## Recommended agent flow

1. Call `get_agent_test_fixture` when discovering the contract.
2. Call `compare_astro_weather_locations` to rank two or three cities.
3. Call `explain_score_components` for a city whose score needs explanation.
4. Call `find_reflection_window` when a precise one-hour or three-hour window is needed.
5. Call `generate_agent_brief` when another agent needs a compact handoff.
6. Call `get_place_context` directly when place evidence must be inspected independently.

Space provider calls and handle sanitized upstream errors. Weather and place results are time-dependent.

## Scoring

The score-v1 path uses these components:

- `weatherActivation`: bounded 0 to 10 signal from temperature comfort, daylight, wind, cloud cover, and precipitation
- `moodWeatherMismatch`: `round(abs(moodScore - weatherActivation) * 10)`
- `elementWeatherAlignment`: bounded 0 to 100 signal based on dominant sky elements and observable weather
- `reflectionWindowQuality`: bounded 0 to 100 quality of the best one-hour slot
- `astroWeatherFitScore`: `round(0.45 * element + 0.35 * (100 - mismatch) + 0.20 * window)`

The score-v3 path keeps the score-v1 result as its base and adds bounded mood-profile and place-context components. Baseline weights are base 0.70, mood 0.20, and place 0.10 when both rich components are active. Active weights adjust when only one rich component is present. These weights and tag mappings are design heuristics, not validated predictions.

## REST adapter and UI

`POST /api/compare` accepts the same comparison fields as the MCP comparison tool and returns a JSON object with `ok: true` plus the comparison result. Invalid input returns a structured error.

The static UI has four sliders for energy, stress, focus, and social battery, each defaulting to 5. It sends `moodScore` equal to the energy value for compatibility, sends the four-axis `moodProfile`, and provides an opt-in checkbox for Wikimedia place context. When rich fields are returned, the UI displays the method, mood profile, score weights, final scores, place tags, evidence terms, confidence, and fallback state.

## Security

- `FREE_ASTROLOGY_API_KEY` is a Cloudflare Worker secret.
- The browser never receives the astrology key.
- MCP responses, REST responses, and errors must not contain credentials or raw upstream bodies.
- The browser calls only same-origin `/api/compare`.
- No LLM is used in the scoring path.

## Limitations

- Weather changes over time, so rankings and windows can change between requests.
- The geocentric sky profile is shared across cities in one comparison.
- Wikimedia summaries and derived tags can be incomplete or unavailable.
- Scoring weights and tag compatibility are heuristics and should not be treated as scientific conclusions.

## Disclaimer

Reflective practice only. Not medical, financial, legal, or predictive advice.