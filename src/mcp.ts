// MCP server factory.
// Uses the @modelcontextprotocol/sdk McpServer class to expose 4 tools via Streamable HTTP at /mcp.
// Stateless: src/index.ts creates a fresh server per request.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CompareInputSchema,
  compareLocations,
  validateCompareInput,
} from "./scoring";
import { fetchWesternSkyProfile } from "./astro";
import { fetchLocationWeather } from "./weather";

const CityShape = {
  name: z.string().min(1).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1).describe("IANA timezone identifier, e.g. Asia/Ho_Chi_Minh"),
};

export function createAstroRouteMcpServer(): McpServer {
  const server = new McpServer({
    name: "astroroute",
    version: "0.1.0",
  });

  // --- Tool 1: get_western_sky_profile ---
  server.tool(
    "get_western_sky_profile",
    "Fetch the current Western astrological sky profile (geocentric, tropical, English). " +
      "Geocentric means the same profile applies to all candidate cities in a comparison; " +
      "pass any one of your candidates as the referenceLocation.",
    {
      asOfUtc: z
        .string()
        .datetime()
        .optional()
        .describe("ISO 8601 UTC timestamp. Defaults to current time if omitted."),
      referenceLocation: z
        .object(CityShape)
        .describe(
          "Reference location for the sky profile (any one of your candidate cities works)."
        ),
    },
    async (args, env) => {
      const asOfUtc = args.asOfUtc ?? new Date().toISOString();
      const apiKey = (env as any)?.FREE_ASTROLOGY_API_KEY;
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
    "Compare 2-3 candidate cities and recommend the best reflection window. Inputs are mood activation (0 = very low, 10 = very high) and 2-3 cities. Returns ranked locations with astroWeatherFitScore, moodWeatherMismatch, elementWeatherAlignment, bestReflectionWindow, whyFirstPlace, and a safety disclaimer.",
    {
      moodScore: z
        .number()
        .min(0)
        .max(10)
        .describe("Self-reported mood activation: 0 = very low/quiet energy, 10 = very high/activated energy."),
      candidates: z
        .array(z.object(CityShape))
        .min(2)
        .max(3)
        .describe("Candidate cities to compare."),
      asOfUtc: z.string().datetime().optional().describe("ISO 8601 UTC timestamp. Defaults to now."),
    },
    async (args, env) => {
      const validation = validateCompareInput(args);
      if (!validation.ok) {
        return {
          content: [{ type: "text", text: `Invalid input: ${validation.error}` }],
          isError: true,
        };
      }
      const result = await compareLocations(env as any, validation.value);
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
        .enum(["three_city_live_v1", "validation_errors_v1"])
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
            moodInterpretation: "{ score: number, label: 'neutral' | 'very low' | 'low' | 'elevated' | 'high' }",
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
      };

      const fixture = fixtures[args.fixtureId];
      return {
        content: [{ type: "text", text: JSON.stringify(fixture, null, 2) }],
        structuredContent: fixture,
      };
    }
  );

  return server;
}