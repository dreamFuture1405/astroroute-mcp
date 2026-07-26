# AstroRoute Local Validation Checklist (v2)

This checklist covers pre-deploy and post-deploy gates **without automated tests** (per the Step 2 simplification directive). Each gate must pass by hand before the next.

## G0 Static checks

- [ ] `npm install` completes without errors
- [ ] `npx tsc --noEmit` reports 0 errors
- [ ] Source files contain no `FREE_ASTROLOGY_API_KEY` literal value
- [ ] `public/` files contain no `x-goog-api-key`, `AIza`, or any key literal
- [ ] `wrangler.jsonc` has `assets.directory` pointing to `./public`
- [ ] Exactly 13 files in the repo (matching the locked file list)

## G1 Local dev (`npx wrangler dev`)

- [ ] Worker boots without errors
- [ ] `GET http://localhost:8787/healthz` returns 200 with `{"status":"ok","service":"astroroute","scoring":"score-v1"}`
- [ ] `GET http://localhost:8787/` returns 200 with the HTML form
- [ ] `GET http://localhost:8787/agents-guide.md` returns 200 with markdown
- [ ] `GET http://localhost:8787/styles.css` returns 200
- [ ] `GET http://localhost:8787/app.js` returns 200
- [ ] `POST http://localhost:8787/api/compare` with `{}` returns 400 with field-level errors mentioning moodScore/candidates
- [ ] `POST http://localhost:8787/api/compare` with a valid 3-city body (moodScore 5, Hanoi/Tokyo/Singapore) returns 200 with a `ComparisonResult`

## G2 MCP endpoint (existing 4 tools)

- [ ] `POST http://localhost:8787/mcp` with `initialize` returns 200 with `serverInfo.name === "astroroute"` and `serverInfo.version === "0.2.0"`
- [ ] `POST http://localhost:8787/mcp` with `tools/list` returns exactly **7 tools** with strict JSON Schema (`additionalProperties: false`)
- [ ] `POST http://localhost:8787/mcp` with `tools/call` for `get_agent_test_fixture` (fixtureId `three_city_live_v1`) returns the fixture JSON including the `sevenTools` array
- [ ] `POST http://localhost:8787/mcp` with `tools/call` for `get_western_sky_profile` (any reference location, default `asOfUtc`) returns a `WesternSkyProfile`
- [ ] `POST http://localhost:8787/mcp` with `tools/call` for `get_location_weather` (Hanoi) returns a `Weather`
- [ ] `POST http://localhost:8787/mcp` with `tools/call` for `compare_astro_weather_locations` (moodScore 5, Hanoi/Tokyo/Singapore) returns a `ComparisonResult`
- [ ] Two concurrent MCP sessions do not see each other's responses (stateless)

## G3 MCP endpoint (new 3 tools)

### Tool 5: explain_score_components (valid)

- [ ] Input: `{ moodScore: 5, candidates: [Hanoi, Tokyo, Singapore], targetLocationName: "Tokyo" }`
- [ ] Returns `methodVersion: "score-v1"`, `targetLocation.rank`, `targetLocation.location`, `targetLocation.astroWeatherFitScore`
- [ ] Returns `scoreBreakdown.element.rawScore`, `.weight` (0.45), `.weightedContribution`
- [ ] Returns `scoreBreakdown.moodMatch.moodWeatherMismatch`, `.inverseScore`, `.weight` (0.35), `.weightedContribution`
- [ ] Returns `scoreBreakdown.window.rawScore`, `.weight` (0.20), `.weightedContribution`
- [ ] `scoreBreakdown.recomputedTotal` equals `round(0.45 * element + 0.35 * mismatchInverse + 0.20 * window)` and matches `astroWeatherFitScore`
- [ ] Returns `elementWeatherAlignment.score` and `elementWeatherAlignment.explanation[]` non-empty
- [ ] Returns `bestWindowReasoning.startLocal`, `.endLocal`, `.quality`, `.reason`
- [ ] Returns `caveats[]` with 3 entries and `disclaimer` exact string
- [ ] `targetLocationName` matches exactly one candidate name

### Tool 5: explain_score_components (invalid - zero match)

- [ ] Input: `{ moodScore: 5, candidates: [Hanoi, Tokyo], targetLocationName: "Mars" }`
- [ ] Returns MCP `isError: true` with message mentioning no match and listing candidate names
- [ ] No provider call made (error before `compareLocations`)

### Tool 5: explain_score_components (invalid - ambiguous)

- [ ] Input: `{ moodScore: 5, candidates: ["Tokyo", "Tokyo"], targetLocationName: "Tokyo" }` (if validation allows duplicate names)
- [ ] Returns MCP `isError: true` with message mentioning multiple matches

### Tool 6: find_reflection_window (valid)

- [ ] Input: `{ location: Tokyo full City object, moodScore: 5, windowHoursAhead: 24 }`
- [ ] Returns `methodVersion: "reflection-window-v1"`
- [ ] Returns `best1Hour.startLocal`, `.endLocal`, `.timezone`, `.qualityScore` (0-100), `.weatherReasons[]`, `.astroReasons[]`, `.moodReason`
- [ ] Returns `best3Hours.startLocal`, `.endLocal`, `.timezone`, `.qualityScore` (0-100), `.weatherReasons[]`, `.astroReasons[]`, `.moodReason`
- [ ] `best1Hour` and `best3Hours` use consecutive hourly array indices
- [ ] `best3Hours.qualityScore` equals the rounded mean of three consecutive hourly scores
- [ ] `fallback.used` is exactly `true` if and only if both best scores < 65
- [ ] Returns `sourceRecords.astrology.provider`, `.endpointFamily`, `.fetchedAtUtc`
- [ ] Returns `sourceRecords.weather.provider`, `.fetchedAtUtc`, `.horizonHours`
- [ ] Returns `caveats[]` and `disclaimer` exact string

### Tool 6: find_reflection_window (validation errors)

- [ ] Input: `{ location: Tokyo, moodScore: 11, ... }` - schema error, no provider call
- [ ] Input: `{ location: Tokyo, moodScore: 5, windowHoursAhead: 2 }` - schema error (min 3), no provider call
- [ ] Input: `{ location: Tokyo, moodScore: 5, windowHoursAhead: 25 }` - schema error (max 24), no provider call

### Tool 7: generate_agent_brief (valid)

- [ ] Input: `{ moodScore: 5, candidates: [Hanoi, Tokyo, Singapore] }`
- [ ] Returns `schemaVersion: "agent-brief-v1"`, `methodVersion: "score-v1"`
- [ ] Returns `recommendedCity` as full City object matching `rankedLocations[0].location` from a comparison with same inputs
- [ ] Returns `bestTime.startLocal`, `.endLocal`, `.timezone`, `.qualityScore` matching rank-1 `bestReflectionWindow`
- [ ] Returns `why` as non-empty string referencing `recommendedCity.name`
- [ ] Returns `avoidIfConditions[]` as array of strings (may be empty if conditions are mild)
- [ ] Returns `sourceRecords.astrology` with `provider`, `endpointFamily`, `asOfUtc`, `dominantElements[]`, `keyPlanet`
- [ ] Returns `sourceRecords.weather[]` with entries for each candidate: `provider`, `location`, `weatherEvidence`
- [ ] Returns `disclaimer` exact string

### Tool 7: generate_agent_brief (invalid input)

- [ ] Input: `{ moodScore: 5 }` (missing candidates) - returns `isError: true` with validation error
- [ ] Input: `{ moodScore: 11, candidates: [...] }` - returns `isError: true`

## G4 Provider contracts

- [ ] Free Astrology API responds 200 with `output[].name` and `output[].zodiacSign` populated for `observation_point: "geocentric"`, `ayanamsha: "tropical"`, `language: "en"`
- [ ] Open-Meteo responds 200 with `current`, `hourly.time` length 24, `daily.sunrise[0]`, `daily.sunset[0]`
- [ ] Provider 401 → response error code `upstream_unavailable` with sanitized message (no upstream body leaked)
- [ ] Provider 429 → response error code `upstream_unavailable` with `retryable: true`
- [ ] Provider timeout (artificial 5s sleep) → response error code `upstream_unavailable` with `retryable: true`

## G5 Same-site UI

- [ ] `/`, `/agents-guide.md`, `/healthz`, `/api/compare`, `/mcp` all on the same origin (no mixed content)
- [ ] Flow 2-city (Hanoi + Tokyo) renders ranked result without console errors
- [ ] Flow 3-city (Hanoi + Tokyo + Singapore) renders ranked result without console errors
- [ ] Result page does NOT contain horoscope, ritual, affirmation, or predictive language
- [ ] Result page contains the disclaimer verbatim: "Reflective practice only. Not medical, financial, legal, or predictive advice."

## G6 Security

- [ ] Worker secret `FREE_ASTROLOGY_API_KEY` is set via `wrangler secret put`
- [ ] `curl -X POST https://<worker>/api/compare -d '{...valid body...}'` does NOT include the secret in any field
- [ ] Browser DevTools Network tab shows only same-origin `fetch('/api/compare', ...)`
- [ ] Source files (`src/*.ts`, `public/*`) contain no API key, no token, no AIza prefix, no `x-goog-api-key` literal
- [ ] Build output (`dist/` or bundle) contains no secret value

## G7 Capacity (Free plan)

- [ ] `wrangler tail` shows no Workers CPU limit errors during 10 fixture calls
- [ ] p95 latency for one `compare_astro_weather_locations` call is under 5 seconds
- [ ] p95 latency for one `find_reflection_window` call is under 5 seconds
- [ ] p95 latency for one `generate_agent_brief` call is under 5 seconds
- [ ] Free Astrology API quota not exceeded (50/day, 1/sec) during the test runs

## G8 Human Steward MCP test

- [ ] Human Steward opens an MCP client (Claude Desktop, MCP Inspector, or `curl` with manual JSON-RPC envelopes)
- [ ] Initialize → `tools/list` returns 7 tools
- [ ] Calls `get_agent_test_fixture` (fixtureId `three_city_live_v1`) and confirms fixture loads with `sevenTools` array
- [ ] Calls `compare_astro_weather_locations` with moodScore 5 and Hanoi/Tokyo/Singapore
- [ ] Calls `explain_score_components` with the same inputs plus `targetLocationName: "Tokyo"`
- [ ] Calls `find_reflection_window` with Tokyo location and moodScore 7
- [ ] Calls `generate_agent_brief` with moodScore 5 and Hanoi/Tokyo/Singapore
- [ ] Saves timestamp + result JSON for the submission evidence

## G9 Independent other-Mind MCP test

- [ ] Another Mind connects to the public `/mcp` endpoint using its own MCP client
- [ ] `tools/list` returns the 7 tools
- [ ] Calls `get_agent_test_fixture` then `compare_astro_weather_locations`
- [ ] Calls `explain_score_components` for the top-ranked city
- [ ] Calls `find_reflection_window` for the top-ranked city
- [ ] Calls `generate_agent_brief`
- [ ] Reports observed fields and any errors to the steward

## G10 Documentation parity

- [ ] Tool-name set in `src/mcp.ts`, `public/agents-guide.md`, `README.md`, and fixture response all contain the same 7 names
- [ ] No tool name appears in one doc but not the others
- [ ] `README.md` file list says exactly 13 files
- [ ] Actual file count is exactly 13

## G11 Submission readiness

- [ ] All G0-G10 gates pass
- [ ] Live URL captured
- [ ] Independent MCP test result captured
- [ ] Steward approves explicitly before any submission to the tournament