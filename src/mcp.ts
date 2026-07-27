// MCP server factory.
// Uses the @modelcontextprotocol/sdk McpServer class to expose 9 tools via Streamable HTTP at /mcp.
// Stateless: src/index.ts creates a fresh server per request.
// v0.2 -> v0.3: Tool 3 schema accepts optional moodProfile + includePlaceContext (route to score-v3).
// Tool 8 (get_place_context) added; remaining 7 tools unchanged in name + required fields.
// v0.3 -> v0.4: Tool 3 schema accepts optional includeSpaceWeather (route to score-v4).
// Tool 9 (get_space_weather_context) added; returns global NOAA SWPC space weather bundle.
// Version string bumped to "0.4.0".

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CompareInputSchema,
  compareLocations,
  validateCompareInput,
  explainLocationScore,
  findReflectionWindow,
  generateAgentBrief,
  MoodProfileSchema,
  CompareInputV3Schema,
  compareLocationsV3,
  validateCompareInputV3,
} from "./scoring";
import {
  validateCompareInputV4,
  compareLocationsV4,
} from "./scoring-v4";
import { fetchWesternSkyProfile } from "./astro";
import { fetchLocationWeather } from "./weather";
import { fetchPlaceContext } from "./place";
import { fetchSpaceWeatherBundle } from "./spaceweather";

const CityShape = {
  name: z.string().min(1).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1).describe("IANA timezone identifier, e.g. Asia/Ho_Chi_Minh"),
};

const MoodAxesShape = {
  energy: z.number().min(0).max(10).optional().describe("Self-reported energy level: 0 = depleted, 10 = very high."),
  stress: z.number().min(0).max(10).optional().describe("Self-reported stress level: 0 = none, 10 = very high."),
  focus: z.number().min(0).max(10).optional().describe("Self-reported focus/clarity: 0 = scattered, 10 = razor-sharp."),
  socialBattery: z.number().min(0).max(10).optional().describe("Self-reported social energy: 0 = hermit, 10 = peak sociability."),
};

export function createAstroRouteMcpServer(env?: { FREE_ASTROLOGY_API_KEY?: string }): McpServer {
  const server = new McpServer({
    name: "astroroute",
    version: "0.4.0",
  });

  // --- Tool 1: get_western_sky_profile ---
  server.tool(
    "get_western_sky_profile",
    "Fetch the current Western astrological sky profile (geocentric, tropical, English). Geocentric means the same profile applies to all candidate cities in a comparison; pass any one of your candidates as the referenceLocation.",
    {
      asOfUtc: z.string().datetime().optional().describe("ISO 8601 UTC timestamp. Defaults to current time if omitted."),
      referenceLocation: z.object(CityShape).describe("Reference location for the sky profile (any one of your candidate cities works)."),
    },
    async (args) => {
      const asOfUtc = args.asOfUtc ?? new Date().toISOString();
      const apiKey = env?.FREE_ASTROLOGY_API_KEY;
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Server is missing FREE_ASTROLOGY_API_KEY." }],
          isError: true,
        };
      }
      const profile = await fetchWesternSkyProfile(apiKey, asOfUtc, args.referenceLocation);
      return {
        content: [{ type: "text", text: JSON.stringify(profile, null, 2) }],
        structuredContent: profile,
      };
    }
  );

  // --- Tool 2: get_location_weather ---
  server.tool(
    "get_location_weather",
    "Fetch current weather, 24-hour hourly forecast, and sunrise/sunset for a single city from Open-Meteo. No API key required.",
    {
      city: z.object(CityShape),
    },
    async (args) => {
      const weather = await fetchLocationWeather(args.city);
      return {
        content: [{ type: "text", text: JSON.stringify(weather, null, 2) }],
        structuredContent: weather,
      };
    }
  );

  // --- Tool 3: compare_astro_weather_locations (main entry) ---
  server.tool(
    "compare_astro_weather_locations",
    "Compare 2-3 candidate cities and recommend the best reflection window. Required inputs: moodScore (0-10) and 2-3 candidates. Optional fields: moodProfile (energy, stress, focus, socialBattery; each 0-10), includePlaceContext (boolean), and includeSpaceWeather (boolean). When no optional fields are active the response uses score-v1. When moodProfile or includePlaceContext is active, score-v3 is used. When includeSpaceWeather is true, score-v4 is used with NOAA SWPC space weather data as a fourth scoring component (weights: base 0.55, mood 0.18, place 0.10, spaceWeather 0.17). If NOAA SWPC is unavailable, score-v4 renormalizes weights and sets spaceWeather=null. Returns ranked locations with all score components, bestReflectionWindow, whyFirstPlace, and a safety disclaimer.",
    {
      moodScore: z.number().min(0).max(10).describe("Self-reported mood activation: 0 = very low/quiet energy, 10 = very high/activated energy."),
      candidates: z.array(z.object(CityShape)).min(2).max(3).describe("Candidate cities to compare."),
      asOfUtc: z.string().datetime().optional().describe("ISO 8601 UTC timestamp. Defaults to now."),
      moodProfile: MoodProfileSchema.optional().describe("Optional v0.3 four-axis mood profile; defaults are derived from moodScore when omitted."),
      includePlaceContext: z.boolean().optional().describe("Optional v0.3: when true, fetch per-candidate Wikimedia place context for score-v3."),
      includeSpaceWeather: z.boolean().optional().describe("Optional v0.4: when true, fetch NOAA SWPC space weather for score-v4. Space weather is global, not per-city."),
    },
    async (args) => {
      const v4Validation = validateCompareInputV4(args);
      if (!v4Validation.ok) {
        return {
          content: [{ type: "text", text: `Invalid input: ${v4Validation.error}` }],
          isError: true,
        };
      }

      // v0.4 path: includeSpaceWeather=true
      if (args.includeSpaceWeather === true) {
        try {
          const result = await compareLocationsV4(env as any, v4Validation.value);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        } catch (e: any) {
          return {
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
          };
        }
      }

      // v0.3 path
      const moodProfileActive =
        args.moodProfile !== undefined && Object.keys(args.moodProfile).length > 0;
      const placeContextActive = args.includePlaceContext === true;
      if (!moodProfileActive && !placeContextActive) {
        const v1Validation = validateCompareInput(v4Validation.value);
        if (!v1Validation.ok) {
          return {
            content: [{ type: "text", text: `Invalid input: ${v1Validation.error}` }],
            isError: true,
          };
        }
        const result = await compareLocations(env as any, v1Validation.value);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }
      const result = await compareLocationsV3(env as any, v4Validation.value);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // --- Tool 4: get_agent_test_fixture ---
  server.tool(
    "get_agent_test_fixture",
    "Return a fixed test fixture (deterministic input + expected schema/assertions) for verifying MCP behavior. Weather scores will not match exactly because live weather changes, but the schema and ranking invariants hold.",
    {
      fixtureId: z
        .enum(["three_city_live_v1", "validation_errors_v1", "v0_3_wikimedia_tokyo", "v0_4_space_weather"])
        .optional()
        .default("three_city_live_v1"),
    },
    async (args) => {
      const fixtures: Record<string, any> = {
        three_city_live_v1: {
          description:
            "Three-city live comparison: Hanoi, Tokyo, Singapore. Use to verify all MCP outputs and the schema contract.",
          inputs: {
            moodScore: 5,
            candidates: [
              { name: "Hanoi", latitude: 21.0285, longitude: 105.8542, timezone: "Asia/Ho_Chi_Minh" },
              { name: "Tokyo", latitude: 35.6762, longitude: 139.6503, timezone: "Asia/Tokyo" },
              { name: "Singapore", latitude: 1.3521, longitude: 103.8198, timezone: "Asia/Singapore" },
            ],
            asOfUtc: "2026-07-25T12:00:00Z",
          },
          expectedSchema: {
            methodVersion: "score-v1",
            asOfUtc: "ISO 8601 string equal to inputs.asOfUtc",
            moodInterpretation:
              "{ score: number, label: 'neutral' | 'very low' | 'low' | 'elevated' | 'high' }",
            skyProfile:
              "{ dominantElements: array of 1-2 Element strings, keyPlanet: string }",
            rankedLocations:
              "array of length equal to inputs.candidates.length; each entry has rank (1..N), location, astroWeatherFitScore (0-100), moodWeatherMismatch (0-100), elementWeatherAlignment.score (0-100), dayNightTimingNote, bestReflectionWindow { startLocal, endLocal, quality (0-100), reason }, weatherEvidence, scoreComponents",
            whyFirstPlace: "non-empty string referencing rankedLocations[0].location.name",
            dataFreshness: "non-empty string",
            disclaimer:
              "'Reflective practice only. Not medical, financial, legal, or predictive advice.'",
          },
          invariants: [
            "rankedLocations[0].rank == 1",
            "rankedLocations has no duplicate ranks",
            "astroWeatherFitScore in [0, 100] for every entry",
            "moodWeatherMismatch in [0, 100] for every entry",
            "rankedLocations sorted by astroWeatherFitScore descending",
            "disclaimer exactly matches the safety string",
          ],
          tools: [
            "get_western_sky_profile",
            "get_location_weather",
            "compare_astro_weather_locations",
            "get_agent_test_fixture",
            "explain_score_components",
            "find_reflection_window",
            "generate_agent_brief",
            "get_place_context",
            "get_space_weather_context",
          ],
          version: "0.4.0",
        },
        validation_errors_v1: {
          description:
            "Inputs that should fail validation. Use to verify the server rejects bad payloads cleanly.",
          cases: [
            {
              input: { moodScore: 11, candidates: [] },
              expectedError: "invalid_input: moodScore must be <= 10 and candidates must have 2-3 entries",
            },
            {
              input: {
                moodScore: -1,
                candidates: [
                  { name: "X", latitude: 0, longitude: 0, timezone: "UTC" },
                ],
              },
              expectedError: "invalid_input: moodScore must be >= 0 and candidates must have 2-3 entries",
            },
            {
              input: { moodScore: 5 },
              expectedError: "invalid_input: missing required field candidates",
            },
            {
              input: {
                moodScore: 5,
                candidates: [
                  { name: "A", latitude: 91, longitude: 0, timezone: "UTC" },
                  { name: "B", latitude: 0, longitude: 0, timezone: "UTC" },
                ],
              },
              expectedError: "invalid_input: latitude must be in [-90, 90]",
            },
          ],
        },
        v0_3_wikimedia_tokyo: {
          description:
            "v0.3 schema: includePlaceContext + partial moodProfile. Use to verify get_place_context and score-v3 path.",
          inputs: {
            moodScore: 6,
            candidates: [
              { name: "Tokyo", latitude: 35.6762, longitude: 139.6503, timezone: "Asia/Tokyo" },
              { name: "Reykjavik", latitude: 64.1466, longitude: -21.9426, timezone: "Atlantic/Reykjavik" },
            ],
            asOfUtc: "2026-07-26T12:00:00Z",
            moodProfile: { energy: 7, focus: 6 },
            includePlaceContext: true,
          },
          expectedSchema: {
            methodVersion: "score-v3",
            derivedMoodProfile: "object with all four axes 0-10 (defaults filled from moodScore)",
            placeContextList: "array of length 2, each entry provider is 'wikimedia.org'",
            rankedLocations:
              "array; each entry has v3.moodFitScore (number|null), v3.placeFitScore (number|null), v3.placeContext (object|null), v3.finalScoreV3 (0-100), v3.weights ({base,mood,place})",
            scoreV3Weights: "{ base: 0.7, mood: 0.2, place: 0.1 }",
          },
          invariants: [
            "rankedLocations[0].v3.finalScoreV3 in [0, 100]",
            "sum of v3.weights == 1.0",
            "methodVersion == 'score-v3'",
            "placeContextList[*].provider == 'wikimedia.org'",
          ],
          tools: [
            "get_western_sky_profile",
            "get_location_weather",
            "compare_astro_weather_locations",
            "get_agent_test_fixture",
            "explain_score_components",
            "find_reflection_window",
            "generate_agent_brief",
            "get_place_context",
            "get_space_weather_context",
          ],
          version: "0.4.0",
        },
        v0_4_space_weather: {
          description:
            "v0.4 schema: includeSpaceWeather=true. Use to verify get_space_weather_context and score-v4 path.",
          inputs: {
            moodScore: 7,
            candidates: [
              { name: "Tokyo", latitude: 35.6762, longitude: 139.6503, timezone: "Asia/Tokyo" },
              { name: "Reykjavik", latitude: 64.1466, longitude: -21.9426, timezone: "Atlantic/Reykjavik" },
              { name: "Buenos Aires", latitude: -34.6037, longitude: -58.3816, timezone: "America/Argentina/Buenos_Aires" },
            ],
            asOfUtc: "2026-07-27T00:00:00Z",
            includeSpaceWeather: true,
          },
          expectedSchema: {
            methodVersion: "score-v4",
            spaceWeatherBundle: "object with currentKpIndex, geomagneticActivity, solarActivity, sunspotCount, spaceWeatherFit (0-100), sourceRecords",
            spaceWeatherFallback: "null when NOAA succeeds, object with reason when NOAA fails",
            rankedLocations:
              "array; each entry has v4.spaceWeatherFit (number|null), v4.spaceWeatherBundle (object|null), v4.spaceWeatherFallback",
            scoreV4Weights: "{ base: 0.55, mood: 0.18, place: 0.10, spaceWeather: 0.17 } when NOAA succeeds, renormalized when fails",
          },
          invariants: [
            "methodVersion == 'score-v4'",
            "sum of scoreV4Weights == 1.0",
            "scoreV4Weights.spaceWeather == 0.17 when NOAA succeeds, 0 when fails",
            "spaceWeatherBundle.sourceRecords[*].provider == 'services.swpc.noaa.gov' when NOAA succeeds",
          ],
          tools: [
            "get_western_sky_profile",
            "get_location_weather",
            "compare_astro_weather_locations",
            "get_agent_test_fixture",
            "explain_score_components",
            "find_reflection_window",
            "generate_agent_brief",
            "get_place_context",
            "get_space_weather_context",
          ],
          version: "0.4.0",
        },
      };

      const fixture = fixtures[args.fixtureId];
      return {
        content: [{ type: "text", text: JSON.stringify(fixture, null, 2) }],
        structuredContent: fixture,
      };
    }
  );

  // --- Tool 5: explain_score_components ---
  server.tool(
    "explain_score_components",
    "Explain why one selected candidate received its score after a comparison. Takes the full compare request plus a targetLocationName that must match exactly one candidate. Returns the score breakdown with weighted contributions, element alignment, and caveats. (v0.2 score-v1 path; for v0.3 explanations, use compare_astro_weather_locations with v0.3 fields and inspect the v3 block.)",
    {
      moodScore: z.number().min(0).max(10).describe("Self-reported mood activation: 0 = very low, 10 = very high."),
      candidates: z.array(z.object(CityShape)).min(2).max(3).describe("Candidate cities (must include the targetLocationName)."),
      asOfUtc: z.string().datetime().optional().describe("ISO 8601 UTC timestamp. Defaults to now."),
      targetLocationName: z.string().min(1).max(80).describe("Exact name of the candidate to explain. Must match one candidate.name exactly."),
    },
    async (args) => {
      const validation = validateCompareInput({
        moodScore: args.moodScore,
        candidates: args.candidates,
        asOfUtc: args.asOfUtc,
      });
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: `Invalid input: ${validation.error}` }],
          isError: true,
        };
      }
      try {
        const result = await explainLocationScore(env as any, {
          ...validation.value,
          targetLocationName: args.targetLocationName,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool 6: find_reflection_window ---
  server.tool(
    "find_reflection_window",
    "Find the best 1-hour and 3-hour reflection windows for a single location. Uses the existing Western sky snapshot and Open-Meteo forecast. (v0.2 reflection-window-v1 path.)",
    {
      location: z.object(CityShape).describe("Concrete location with name, latitude, longitude, and timezone."),
      moodScore: z.number().min(0).max(10).describe("Self-reported mood activation: 0 = very low, 10 = very high."),
      asOfUtc: z.string().datetime().optional().describe("ISO 8601 UTC timestamp. Defaults to now."),
      windowHoursAhead: z.number().int().min(3).max(24).optional().describe("How many hours ahead to search. Default 24, max 24 (matches Open-Meteo forecast horizon)."),
    },
    async (args) => {
      try {
        const result = await findReflectionWindow(env as any, {
          location: args.location,
          moodScore: args.moodScore,
          asOfUtc: args.asOfUtc,
          windowHoursAhead: args.windowHoursAhead,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool 7: generate_agent_brief ---
  server.tool(
    "generate_agent_brief",
    "Convert a full comparison into compact JSON another agent can consume without parsing the full ranked payload. Returns recommended city, best time window, reasoning, avoid-if conditions, and source records. (v0.2 agent-brief-v1 schema; uses score-v1 path.)",
    {
      moodScore: z.number().min(0).max(10).describe("Self-reported mood activation: 0 = very low, 10 = very high."),
      candidates: z.array(z.object(CityShape)).min(2).max(3).describe("Candidate cities to compare."),
      asOfUtc: z.string().datetime().optional().describe("ISO 8601 UTC timestamp. Defaults to now."),
    },
    async (args) => {
      const validation = validateCompareInput(args);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: `Invalid input: ${validation.error}` }],
          isError: true,
        };
      }
      try {
        const result = await generateAgentBrief(env as any, validation.value);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool 8: get_place_context (v0.3) ---
  server.tool(
    "get_place_context",
    "Fetch keyless Wikimedia context for a single city: resolved Wikipedia title, description, extract snippet, optional coordinates, and a derived 8-tag taxonomy (coastal, urban_dense, historic, green_space, creative, quiet, nightlife, transit_hub). Each tag carries matched evidence terms and a confidence tier (high/medium/low). Returns a sanitized unavailable state with fallback.reason when Wikimedia cannot be reached or the city cannot be resolved.",
    {
      city: z.object(CityShape).describe("City with name, latitude, longitude, timezone. Name is used for Wikimedia resolution."),
    },
    async (args) => {
      try {
        const ctx = await fetchPlaceContext(args.city);
        return {
          content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }],
          structuredContent: ctx,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  // --- Tool 9: get_space_weather_context (v0.4) ---
  server.tool(
    "get_space_weather_context",
    "Fetch current global space weather conditions from NOAA SWPC (keyless). Returns current Kp index, geomagnetic activity category, solar flare probabilities (C/M/X class), sunspot count, active regions, a derived spaceWeatherFit score (0-100 for astrotourism/stargazing suitability), and source records for audit. Space weather is GLOBAL (not per-city), so all candidate cities share the same spaceWeatherFit value. If NOAA SWPC is unavailable, returns a fallback state with reason. No API key required.",
    {},
    async () => {
      try {
        const result = await fetchSpaceWeatherBundle();
        if (result.bundle) {
          return {
            content: [{ type: "text", text: JSON.stringify(result.bundle, null, 2) }],
            structuredContent: result.bundle,
          };
        }
        // NOAA failed → return fallback with error info
        const fallbackResponse = {
          currentKpIndex: null,
          estimatedKp: null,
          geomagneticActivity: null,
          cClassProbToday: null,
          mClassProbToday: null,
          xClassProbToday: null,
          solarActivity: null,
          sunspotCount: null,
          activeRegions: null,
          spaceWeatherFit: null,
          sourceRecords: [],
          fetchedAt: new Date().toISOString(),
          cacheTtlSeconds: 0,
          fallback: result.fallback,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(fallbackResponse, null, 2) }],
          structuredContent: fallbackResponse,
          isError: true,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
