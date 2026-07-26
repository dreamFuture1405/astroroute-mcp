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

### 5. explain_score_components
- **Input:** `{ moodScore: 0-10, candidates: City[2-3], asOfUtc?: ISO8601, targetLocationName: string }`
- **Output:** Detailed score breakdown for the named candidate: element weighted contribution, mood match inverse weighted contribution, window weighted contribution, recomputed total, element weather alignment explanation, best window reasoning, and caveats.
- **Validation:** `targetLocationName` must match exactly one `candidate.name`. Zero or duplicate matches return an MCP error before any provider call.
- **Use case:** After `compare_astro_weather_locations` ranks candidates, call this to explain why a specific city got its score.

**Sample request:**
```json
{
  "moodScore": 5,
  "candidates": [
    { "name": "Hanoi", "latitude": 21.0285, "longitude": 105.8542, "timezone": "Asia/Ho_Chi_Minh" },
    { "name": "Tokyo", "latitude": 35.6762, "longitude": 139.6503, "timezone": "Asia/Tokyo" }
  ],
  "targetLocationName": "Tokyo"
}
```

**Output fields:**
- `targetLocation.rank`, `targetLocation.location`, `targetLocation.astroWeatherFitScore`
- `scoreBreakdown.element.rawScore`, `.weight` (0.45), `.weightedContribution`
- `scoreBreakdown.moodMatch.moodWeatherMismatch`, `.inverseScore`, `.weight` (0.35), `.weightedContribution`
- `scoreBreakdown.window.rawScore`, `.weight` (0.20), `.weightedContribution`
- `scoreBreakdown.recomputedTotal` (must equal `round(0.45*element + 0.35*mismatchInverse + 0.20*window)`)
- `elementWeatherAlignment.score`, `.explanation[]`
- `bestWindowReasoning.startLocal`, `.endLocal`, `.quality`, `.reason`
- `caveats[]`, `disclaimer`

### 6. find_reflection_window
- **Input:** `{ location: City, moodScore: 0-10, asOfUtc?: ISO8601, windowHoursAhead?: 3-24 }`
- **Output:** Best 1-hour and 3-hour reflection windows with quality scores, weather reasons, astro reasons, mood reasoning, and fallback indicator.
- **Birth profile interpretation:** Geocentric tropical Western sky for `asOfUtc` at the concrete location. No birth data required.
- **Provider calls:** One Western sky profile + one Open-Meteo forecast (same as existing tools).
- **Scoring:** Uses the same three factor families as score-v1 (element-weather alignment 0.45, mood match inverse 0.35, weather window quality 0.20) applied per hourly slot.
- **Fallback:** If both best 1-hour and best 3-hour quality scores are below 65, returns `fallback.used: true` with best available windows.

**Sample request:**
```json
{
  "location": { "name": "Tokyo", "latitude": 35.6762, "longitude": 139.6503, "timezone": "Asia/Tokyo" },
  "moodScore": 7,
  "windowHoursAhead": 12
}
```

**Output fields:**
- `best1Hour.startLocal`, `.endLocal`, `.timezone`, `.qualityScore`, `.weatherReasons[]`, `.astroReasons[]`, `.moodReason`
- `best3Hours.startLocal`, `.endLocal`, `.timezone`, `.qualityScore`, `.weatherReasons[]`, `.astroReasons[]`, `.moodReason`
- `fallback.used`, `.threshold` (65), `.reason`, `.returnedBestAvailable`
- `sourceRecords.astrology`, `.weather`
- `caveats[]`, `disclaimer`

### 7. generate_agent_brief
- **Input:** `{ moodScore: 0-10, candidates: City[2-3], asOfUtc?: ISO8601 }`
- **Output:** Compact JSON brief with recommended city, best time window, reasoning, avoid-if conditions, and source records.
- **Use case:** Consumed by another agent that needs a quick recommendation without parsing the full ranked payload.

**Sample request:**
```json
{
  "moodScore": 5,
  "candidates": [
    { "name": "Hanoi", "latitude": 21.0285, "longitude": 105.8542, "timezone": "Asia/Ho_Chi_Minh" },
    { "name": "Tokyo", "latitude": 35.6762, "longitude": 139.6503, "timezone": "Asia/Tokyo" },
    { "name": "Singapore", "latitude": 1.3521, "longitude": 103.8198, "timezone": "Asia/Singapore" }
  ]
}
```

**Output fields:**
- `schemaVersion`: "agent-brief-v1"
- `recommendedCity`: City object of rank-1 candidate
- `bestTime.startLocal`, `.endLocal`, `.timezone`, `.qualityScore`
- `why`: one-line explanation from the comparison
- `avoidIfConditions[]`: array of strings flagging high mismatch, precipitation, strong wind, weak window, or nighttime
- `sourceRecords.astrology` (provider, endpointFamily, asOfUtc, dominantElements, keyPlanet)
- `sourceRecords.weather[]` (provider, location, weatherEvidence per candidate)
- `disclaimer`

## Recommended agent flow

1. Call `compare_astro_weather_locations` to rank cities.
2. Optionally call `explain_score_components` for the top-ranked city to understand why it won.
3. Optionally call `find_reflection_window` for the top city to get precise 1-hour and 3-hour windows.
4. Optionally call `generate_agent_brief` to produce a compact brief for downstream consumption.

**Quota note:** `explain_score_components` and `generate_agent_brief` each consume one full comparison (1 astrology call + N weather calls). `find_reflection_window` consumes one astrology call + one weather call. Sequential chained calls can approach the Free Astrology API rate limit (1/sec, 50/day free tier). Space calls and handle 429 gracefully.

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