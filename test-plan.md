# AstroRoute Local Validation Checklist (v1)

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

## G2 MCP endpoint

- [ ] `POST http://localhost:8787/mcp` with `initialize` returns 200 with `serverInfo.name === "astroroute"`
- [ ] `POST http://localhost:8787/mcp` with `tools/list` returns exactly 4 tools with strict JSON Schema (`additionalProperties: false`)
- [ ] `POST http://localhost:8787/mcp` with `tools/call` for `get_agent_test_fixture` (fixtureId `three_city_live_v1`) returns the fixture JSON
- [ ] `POST http://localhost:8787/mcp` with `tools/call` for `get_western_sky_profile` (any reference location, default `asOfUtc`) returns a `WesternSkyProfile`
- [ ] `POST http://localhost:8787/mcp` with `tools/call` for `get_location_weather` (Hanoi) returns a `Weather`
- [ ] `POST http://localhost:8787/mcp` with `tools/call` for `compare_astro_weather_locations` (moodScore 5, Hanoi/Tokyo/Singapore) returns a `ComparisonResult`
- [ ] Two concurrent MCP sessions do not see each other's responses (stateless)

## G3 Provider contracts

- [ ] Free Astrology API responds 200 with `output[].name` and `output[].zodiacSign` populated for `observation_point: "geocentric"`, `ayanamsha: "tropical"`, `language: "en"`
- [ ] Open-Meteo responds 200 with `current`, `hourly.time` length 24, `daily.sunrise[0]`, `daily.sunset[0]`
- [ ] Provider 401 → response error code `upstream_unavailable` with sanitized message (no upstream body leaked)
- [ ] Provider 429 → response error code `upstream_unavailable` with `retryable: true`
- [ ] Provider timeout (artificial 5s sleep) → response error code `upstream_unavailable` with `retryable: true`

## G4 Same-site UI

- [ ] `/`, `/agents-guide.md`, `/healthz`, `/api/compare`, `/mcp` all on the same origin (no mixed content)
- [ ] Flow 2-city (Hanoi + Tokyo) renders ranked result without console errors
- [ ] Flow 3-city (Hanoi + Tokyo + Singapore) renders ranked result without console errors
- [ ] Result page does NOT contain horoscope, ritual, affirmation, or predictive language
- [ ] Result page contains the disclaimer verbatim: "Reflective practice only. Not medical, financial, legal, or predictive advice."

## G5 Security

- [ ] Worker secret `FREE_ASTROLOGY_API_KEY` is set via `wrangler secret put`
- [ ] `curl -X POST https://<worker>/api/compare -d '{...valid body...}'` does NOT include the secret in any field
- [ ] Browser DevTools Network tab shows only same-origin `fetch('/api/compare', ...)`
- [ ] Source files (`src/*.ts`, `public/*`) contain no API key, no token, no AIza prefix, no `x-goog-api-key` literal
- [ ] Build output (`dist/` or bundle) contains no secret value

## G6 Capacity (Free plan)

- [ ] `wrangler tail` shows no Workers CPU limit errors during 10 fixture calls
- [ ] p95 latency for one `compare_astro_weather_locations` call is under 5 seconds
- [ ] Free Astrology API quota not exceeded (50/day, 1/sec) during the test runs

## G7 Human Steward MCP test

- [ ] Human Steward opens an MCP client (Claude Desktop, MCP Inspector, or `curl` with manual JSON-RPC envelopes)
- [ ] Initialize → `tools/list` returns 4 tools
- [ ] Calls `get_agent_test_fixture` (fixtureId `three_city_live_v1`) and confirms fixture loads
- [ ] Calls `compare_astro_weather_locations` with moodScore 5 and Hanoi/Tokyo/Singapore
- [ ] Saves timestamp + result JSON for the submission evidence

## G8 Independent other-Mind MCP test

- [ ] Another Mind connects to the public `/mcp` endpoint using its own MCP client
- [ ] `tools/list` returns the 4 tools
- [ ] Calls `get_agent_test_fixture` then `compare_astro_weather_locations`
- [ ] Reports observed fields and any errors to the steward

## G9 Submission readiness

- [ ] All G0-G8 gates pass
- [ ] Live URL captured
- [ ] Independent MCP test result captured
- [ ] Steward approves explicitly before any submission to the tournament