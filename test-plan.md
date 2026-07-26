# AstroRoute v0.3 Release Validation Checklist

This checklist covers static review, local smoke checks, legacy regression, v0.3 behavior, MCP protocol behavior, security, and release evidence. Execute gates in order. Do not proceed after a failed live test.

## Scope and invariants

- Worker version is `0.3.0`.
- No new external API, dependency, Worker route, or secret is permitted in this UI and documentation update.
- Wikimedia is the existing keyless third provider implemented in `src/place.ts`.
- Requests without `moodProfile` and `includePlaceContext` must retain `methodVersion: "score-v1"`, the legacy core response fields, and the legacy formula.
- Rich requests with `moodProfile` or `includePlaceContext` must use `methodVersion: "score-v3"` and expose the documented rich metadata.
- The exact safety disclaimer is: `Reflective practice only. Not medical, financial, legal, or predictive advice.`
- The exact MCP tool set is: `get_western_sky_profile`, `get_location_weather`, `compare_astro_weather_locations`, `get_agent_test_fixture`, `explain_score_components`, `find_reflection_window`, `generate_agent_brief`, `get_place_context`. Tool order is not a contract.

## G0 Repository and static checks

- [ ] `npm install` completes without errors.
- [ ] `npx tsc --noEmit` reports zero errors.
- [ ] Source files contain no literal value for `FREE_ASTROLOGY_API_KEY`.
- [ ] `public/` contains no API key, `AIza`, `x-api-key`, or `x-goog-api-key` value.
- [ ] `public/app.js` contains only a relative `fetch("/api/compare")` call and no provider URL.
- [ ] Free Astrology API endpoint appears only in the server-side astrology adapter.
- [ ] Open-Meteo endpoint appears only in the server-side weather adapter.
- [ ] Wikimedia calls appear only in `src/place.ts`.
- [ ] `wrangler.jsonc` still points Static Assets at `./public`.
- [ ] The repository has 14 core implementation and documentation files plus the pre-existing `test_connection_check.txt` file.
- [ ] The v0.3 UI and documentation update added no file and deleted no file.
- [ ] No unimplemented scoring label appears in source, docs, tests, or UI.

## G1 Local smoke checks

Run with `npx wrangler dev` when a local Worker environment is available.

- [ ] Worker starts without a boot error.
- [ ] `GET /healthz` returns HTTP 200 and includes `status: "ok"`, `service: "astroroute"`, `scoring: "score-v1-or-score-v3"`, and `version: "0.3.0"`.
- [ ] `GET /` returns HTTP 200 and contains the four mood slider controls, candidate form, opt-in place-context checkbox, and exact disclaimer.
- [ ] `GET /agents-guide.md` returns HTTP 200 and documents all eight tools.
- [ ] `POST /api/compare` with `{}` returns HTTP 400 with sanitized validation details.

## G2 Legacy REST regression

Use two or three full City objects and omit both optional rich fields.

- [ ] `POST /api/compare` returns HTTP 200.
- [ ] Response has `ok: true` and `methodVersion: "score-v1"`.
- [ ] Response includes `moodInterpretation`, `skyProfile`, `rankedLocations`, `whyFirstPlace`, `dataFreshness`, and `disclaimer`.
- [ ] Every ranked location includes the legacy score fields, window fields, weather evidence, and score components.
- [ ] `astroWeatherFitScore` equals the documented score-v1 composition for the returned components.
- [ ] No place context request is made when `includePlaceContext` is absent.
- [ ] No credential appears in the response body or headers.

## G3 Rich REST and UI checks

Use `moodScore`, two or three full City objects, a four-axis `moodProfile`, and `includePlaceContext: true`.

- [ ] `POST /api/compare` returns HTTP 200 with `ok: true`.
- [ ] Response has `methodVersion: "score-v3"`.
- [ ] Response includes `derivedMoodProfile`, `placeContextList`, `moodProfileFit`, and `scoreV3Weights`.
- [ ] Each ranked location has a `v3` object containing `moodFitScore`, `placeFitScore`, `placeContext`, `finalScoreV3`, and `weights`.
- [ ] `finalScoreV3` values are in the range 0 to 100.
- [ ] `placeContextList` entries contain sanitized Wikimedia fields and no raw upstream body.
- [ ] With `includePlaceContext: false` and a supplied mood profile, the response remains score-v3 but does not fetch place context.
- [ ] The UI sends `moodScore` equal to the energy slider and sends all four mood axes.
- [ ] The UI renders the score method, derived mood profile, score weights, final score, place tags, evidence terms, confidence, and fallback state when supplied.
- [ ] Two-city and three-city UI flows render without console errors.
- [ ] The UI browser network shows only same-origin `/api/compare`.
- [ ] The UI displays the exact disclaimer.

## G4 Exact ordered production test suite

Run these 15 tests in this order against the deployed Worker. Record the HTTP status and a concise response summary for each.

1. **GET `/healthz`**
   - [ ] HTTP 200.
   - [ ] `version` is `0.3.0`.
   - [ ] `scoring` is `score-v1-or-score-v3`.

2. **GET `/`**
   - [ ] HTTP 200.
   - [ ] HTML contains four mood sliders, candidate inputs, the place-context checkbox, and the disclaimer.

3. **GET `/agents-guide.md`**
   - [ ] HTTP 200.
   - [ ] Markdown documents the exact eight-tool set, mood profile, place context, and score versions.

4. **POST `/api/compare` legacy**
   - [ ] Valid legacy body returns HTTP 200 and `methodVersion: "score-v1"`.
   - [ ] Ranked locations and legacy score fields are present.

5. **POST `/api/compare` rich**
   - [ ] Valid body with `moodProfile` and `includePlaceContext: true` returns HTTP 200 and `methodVersion: "score-v3"`.
   - [ ] `derivedMoodProfile`, `placeContextList`, `rankedLocations[].v3`, and `scoreV3Weights` are present.

6. **MCP initialize**
   - [ ] JSON-RPC initialize returns HTTP 200.
   - [ ] `serverInfo.name` is `astroroute`.
   - [ ] `serverInfo.version` is `0.3.0`.
   - [ ] Protocol version and capabilities are present.

7. **MCP `tools/list`**
   - [ ] HTTP 200.
   - [ ] The returned set is exactly the eight names listed in the invariants section.
   - [ ] The check ignores order and rejects missing or extra tools.

8. **MCP `get_western_sky_profile`**
   - [ ] Valid City input returns HTTP 200 and `isError: false`.
   - [ ] `planets` is non-empty, with element balance and dominant elements.
   - [ ] Provider and fetch timestamp are present.
   - [ ] No API key, authorization value, or raw upstream body appears.

9. **MCP `get_location_weather`**
   - [ ] Valid City input returns HTTP 200 and `isError: false`.
   - [ ] `current`, 24 hourly records, sunrise, sunset, provider, and timestamp are present.
   - [ ] No credentials appear.

10. **MCP `get_place_context`**
    - [ ] Valid city input returns HTTP 200 and `isError: false` when Wikimedia resolves the city.
    - [ ] Response contains `provider: "wikimedia.org"`, resolved title, bounded description or extract, tags, evidence terms, confidence tier, fallback object, disclaimers, and fetch timestamp.
    - [ ] Each tag contains `tag`, `evidence`, and `confidence`.
    - [ ] A city with no result or a simulated upstream failure returns a sanitized `fallback.used: true` state rather than raw upstream content.

11. **MCP `compare_astro_weather_locations` rich**
    - [ ] Valid full City objects, mood profile, and `includePlaceContext: true` return HTTP 200 and `isError: false`.
    - [ ] The response uses score-v3 and includes place context plus mood metadata.
    - [ ] Ranking invariants hold: ranks are unique, scores are bounded, and the first rank is 1.
    - [ ] The exact disclaimer is present.

12. **MCP `explain_score_components`**
    - [ ] Valid full comparison input plus a unique `targetLocationName` returns HTTP 200 and `isError: false`.
    - [ ] Element, mood-match, and window weights are present with 0.45, 0.35, and 0.20.
    - [ ] `recomputedTotal` matches the selected location score.
    - [ ] A target name that matches no candidate returns an MCP error before provider work.
    - [ ] Duplicate candidate names produce an ambiguous-target error if submitted.

13. **MCP `find_reflection_window`**
    - [ ] Valid City, mood score, and `windowHoursAhead` from 3 through 24 return HTTP 200.
    - [ ] `best1Hour` and `best3Hours` contain local times, timezone, bounded quality scores, weather reasons, astro reasons, and mood reason.
    - [ ] `fallback.threshold` is 65 and fallback state is explicit.
    - [ ] `sourceRecords`, caveats, and exact disclaimer are present.
    - [ ] Horizons below 3 or above 24 produce validation errors without provider work.
    - [ ] No birth data or natal-chart endpoint is required.

14. **MCP `generate_agent_brief`**
    - [ ] Full comparison input returns HTTP 200 and `isError: false`.
    - [ ] `schemaVersion` is `agent-brief-v1` and `methodVersion` is `score-v1`.
    - [ ] `recommendedCity`, `bestTime`, `why`, `avoidIfConditions`, source records, and disclaimer are present.
    - [ ] Missing candidates or an out-of-range mood score returns a validation error.

15. **Secret scan**
    - [ ] Scan repository source and public assets.
    - [ ] Scan all response bodies from tests 1 through 14.
    - [ ] Scan response headers for API keys, bearer values, authorization values, `x-api-key`, and `x-goog-api-key`.
    - [ ] Confirm no secret value or raw upstream body is exposed.

## G5 Fixture and provider checks

- [ ] `get_agent_test_fixture` accepts `three_city_live_v1`, `validation_errors_v1`, and `v0_3_wikimedia_tokyo`.
- [ ] The fixture's `tools` array contains all eight tool names.
- [ ] Live scores are treated as dynamic. Do not assert a historical city order as a fixed invariant.
- [ ] Free Astrology API provider errors are sanitized.
- [ ] Open-Meteo provider errors are sanitized.
- [ ] Wikimedia timeout, malformed response, no-result, and non-200 behavior produces a bounded fallback state.

## G6 Documentation and repository parity

- [ ] Tool names in `src/mcp.ts`, `public/agents-guide.md`, `README.md`, and fixture responses match exactly as a set.
- [ ] `README.md` describes the 14 core files and notes the pre-existing `test_connection_check.txt` file.
- [ ] `public/agents-guide.md` describes the actual PlaceContext fields and tag taxonomy.
- [ ] `test-plan.md` contains no stale tool count or health response.
- [ ] No new file was created and no existing file was deleted by this patch.

## G7 Human and independent Mind evidence

- [ ] The Human Steward runs the ordered production suite and saves timestamped result summaries.
- [ ] An independent other Mind uses its own MCP client against the public endpoint.
- [ ] The independent client verifies initialize, tools/list, one legacy comparison, one rich comparison, and get_place_context.
- [ ] The independent report records observed fields and errors without receiving an application secret.

## G8 Stop and report rule

If any live test fails:

1. Stop immediately at the first failing test.
2. Do not patch, redeploy, retry destructively, or submit.
3. Report the exact HTTP status, response body, relevant headers, test number, and timestamp.
4. Wait for explicit steward approval before changing code or running a new deployment.

Suggested failure report:

```text
Test number:
Endpoint or tool:
HTTP status:
Response body summary:
Relevant headers:
Observed failure:
No patch or retry performed: yes
```

## G9 Release readiness

- [ ] G0 through G8 are complete.
- [ ] Production URL and version are recorded.
- [ ] Human and independent Mind evidence are recorded.
- [ ] Secret scan is clean.
- [ ] Steward gives explicit approval before any tournament submission.