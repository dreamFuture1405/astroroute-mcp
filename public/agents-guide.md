# AstroRoute Agent Guide

AstroRoute is an MCP-accessible astro-weather location comparison tool. It compares 2 to 3 candidate cities and returns ranked locations, reflection windows, score explanations, and a compact agent brief. Version 0.4.0 adds NOAA SWPC space weather as a fourth dataset for score-v4 while preserving the legacy score-v1 and score-v3 paths.

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

The deployed server exposes exactly these nine tools. Tool order is not a contract.

1. `get_western_sky_profile`
2. `get_location_weather`
3. `compare_astro_weather_locations`
4. `get_agent_test_fixture`
5. `explain_score_components`
6. `find_reflection_window`
7. `generate_agent_brief`
8. `get_place_context`
9. `get_space_weather_context`

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

Required input fields are `moodScore` and `candidates`. Candidates are two or three full `City` objects. Optional fields are `asOfUtc`, `moodProfile`, `includePlaceContext`, and `includeSpaceWeather`.

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
  "includeSpaceWeather": true
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

When no optional fields are active, `methodVersion` is `score-v1` and the existing score-v1 formula and core behavior are preserved. When `moodProfile` or `includePlaceContext` is active, `methodVersion` is `score-v3`. When `includeSpaceWeather` is true, `methodVersion` is `score-v4`.

Score-v4 uses these weights when NOAA SWPC succeeds: base 0.55, mood 0.18, place 0.10, spaceWeather 0.17. When NOAA SWPC is unavailable, score-v4 renormalizes to base 0.65, mood 0.22, place 0.13, spaceWeather 0, and sets `spaceWeather=null` with a populated `spaceWeatherFallback` object.

The `v3` object contains `moodFitScore`, `placeFitScore`, `placeContext`, `finalScoreV3`, and `weights`. `placeContextList` follows candidate input order.

The `v4` object contains `spaceWeatherFit`, `spaceWeatherBundle`, and `spaceWeatherFallback`. `spaceWeatherFit` is the same for all cities because space weather is global.

### 4. get_agent_test_fixture

Input:

```json
{
  "fixtureId": "v0_4_space_weather"
}
```

Supported fixture IDs are:

- `three_city_live_v1`
- `validation_errors_v1`
- `v0_3_wikimedia_tokyo`
- `v0_4_space_weather`

### 5. explain_score_components

Input is the full legacy comparison request plus `targetLocationName`.

The target name must match exactly one candidate. The successful response includes `targetLocation`, `scoreBreakdown`, `elementWeatherAlignment`, `bestWindowReasoning`, `caveats`, and `disclaimer`.

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

### 7. generate_agent_brief

Input is the full legacy comparison request. Returns `schemaVersion: "agent-brief-v1"`, `methodVersion`, `recommendedCity`, `bestTime`, `why`, `avoidIfConditions`, `sourceRecords`, and `disclaimer`.

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

Returns Wikimedia context with resolved title, description, extract, coordinates, tags, evidence terms, confidence tier, and fallback state.

### 9. get_space_weather_context (NEW in v0.4)

Input: none (empty object `{}`). Space weather is global.

```json
{}
```

Returns the current global space weather bundle from NOAA SWPC:

- `currentKpIndex`: integer 0-9, planetary Kp index
- `estimatedKp`: float, estimated Kp
- `geomagneticActivity`: string category ("quiet", "unsettled", "active", "minor storm (G1)", etc.)
- `cClassProbToday`, `mClassProbToday`, `xClassProbToday`: solar flare probabilities as percentages
- `solarActivity`: string category ("low", "moderate", "elevated", "high")
- `sunspotCount`: integer, total sunspots across all stations
- `activeRegions`: integer, distinct active region count
- `spaceWeatherFit`: number 0-100, derived fitness score for astrotourism/stargazing
- `sourceRecords`: array of `{ provider, endpoint, timestamp, value, url }` entries for audit
- `fetchedAt`: ISO 8601 timestamp
- `cacheTtlSeconds`: 3600

If NOAA SWPC is unavailable, returns `spaceWeatherFit: null` and a `fallback` object with `reason` and `httpStatuses`.

No API key is required. Data sources: `services.swpc.noaa.gov/json/planetary_k_index_1m.json`, `services.swpc.noaa.gov/json/solar_probabilities.json`, `services.swpc.noaa.gov/json/sunspot_report.json`.

## Recommended agent flow

1. Call `get_agent_test_fixture` when discovering the contract.
2. Call `compare_astro_weather_locations` to rank two or three cities.
3. Call `explain_score_components` for a city whose score needs explanation.
4. Call `find_reflection_window` when a precise one-hour or three-hour window is needed.
5. Call `generate_agent_brief` when another agent needs a compact handoff.
6. Call `get_place_context` directly when place evidence must be inspected independently.
7. Call `get_space_weather_context` directly when space weather conditions must be inspected independently.

Space provider calls and handle sanitized upstream errors. Weather, place, and space weather results are time-dependent.

## Scoring

### score-v1

The score-v1 path uses these components:

- `weatherActivation`: bounded 0 to 10 signal from temperature comfort, daylight, wind, cloud cover, and precipitation
- `moodWeatherMismatch`: `round(abs(moodScore - weatherActivation) * 10)`
- `elementWeatherAlignment`: bounded 0 to 100 signal based on dominant sky elements and observable weather
- `reflectionWindowQuality`: bounded 0 to 100 quality of the best one-hour slot
- `astroWeatherFitScore`: `round(0.45 * element + 0.35 * (100 - mismatch) + 0.20 * window)`

### score-v3

The score-v3 path keeps the score-v1 result as its base and adds bounded mood-profile and place-context components. Baseline weights are base 0.70, mood 0.20, and place 0.10 when both rich components are active.

### score-v4 (NEW in v0.4)

The score-v4 path keeps the score-v3 result as its base and adds the global spaceWeatherFit component from NOAA SWPC. When NOAA SWPC succeeds:

- base 0.55, mood 0.18, place 0.10, spaceWeather 0.17

When NOAA SWPC is unavailable:

- base 0.65, mood 0.22, place 0.13, spaceWeather 0 (renormalized)

Space weather is global: all candidate cities share the same spaceWeatherFit value. The overall score still varies per city because base, mood, and place components vary.

These weights are design heuristics, not scientific or predictive conclusions.

## REST adapter and UI

`POST /api/compare` accepts the same comparison fields as the MCP comparison tool. When `includeSpaceWeather` is true, it routes through score-v4. The static UI has four mood sliders, a place-context checkbox, and a space-weather checkbox.

## Security

- `FREE_ASTROLOGY_API_KEY` is a Cloudflare Worker secret.
- The browser never receives the astrology key.
- NOAA SWPC endpoints are keyless and public.
- No LLM is used in the scoring path.

## Limitations

- Weather and rankings are dynamic and can change between requests.
- The geocentric sky profile is shared across cities in one comparison.
- Wikimedia summaries can be incomplete or unavailable.
- NOAA SWPC data is global, not per-city.
- Scoring weights are heuristics and should not be treated as scientific conclusions.

## Disclaimer

Reflective practice only. Not medical, financial, legal, or predictive advice.
