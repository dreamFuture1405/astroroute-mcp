// score-v4 additions for AstroRoute v0.4.
// Imports from scoring.ts (v1/v3, unchanged) and spaceweather.ts.
// Adds: CompareInputV4Schema, validateCompareInputV4, compareLocationsV4.
// scoring.ts remains byte-identical for v1 and v3 paths.

import { z } from "zod";
import type { City } from "./weather";
import {
  CitySchema,
  MoodProfileSchema,
  CompareInputV3Schema,
  validateCompareInputV3,
  compareLocationsV3,
  type CompareInputV3,
  type RankedLocationV3,
  type ComparisonResultV3,
  type RankedLocation,
  type ComparisonResult,
  type MoodProfile,
  clamp01to100,
} from "./scoring";
import type { SpaceWeatherBundle } from "./spaceweather";
import { fetchSpaceWeatherBundle } from "./spaceweather";

// ----- Schemas -----

export const CompareInputV4Schema = z.object({
  moodScore: z.number().min(0).max(10),
  candidates: z.array(CitySchema).min(2).max(3),
  asOfUtc: z.string().datetime().optional(),
  moodProfile: MoodProfileSchema.optional(),
  includePlaceContext: z.boolean().optional(),
  includeSpaceWeather: z.boolean().optional(),
});

export type CompareInputV4 = z.infer<typeof CompareInputV4Schema>;

// ----- V4 extensions -----

export interface RankedLocationV4 {
  spaceWeatherFit: number | null;
  spaceWeatherBundle: SpaceWeatherBundle | null;
  spaceWeatherFallback: { reason: string; httpStatuses: number[] } | null;
}

export type ComparisonResultV4 = Omit<ComparisonResultV3, "methodVersion" | "rankedLocations"> & {
  methodVersion: "score-v1" | "score-v3" | "score-v4";
  rankedLocations: Array<
    RankedLocation &
    { v3: RankedLocationV3 | null } &
    { v4: RankedLocationV4 | null }
  >;
  spaceWeatherBundle: SpaceWeatherBundle | null;
  spaceWeatherFallback: { reason: string; httpStatuses: number[] } | null;
  scoreV4Weights: { base: number; mood: number; place: number; spaceWeather: number };
};

// ----- Validation -----

export function validateCompareInputV4(
  body: unknown
): { ok: true; value: CompareInputV4 } | { ok: false; error: string } {
  const result = CompareInputV4Schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, value: result.data };
}

// ----- Score-v4 comparison -----

export async function compareLocationsV4(
  env: { FREE_ASTROLOGY_API_KEY: string },
  input: CompareInputV4
): Promise<ComparisonResultV4> {
  // Build v3 input (v4 adds includeSpaceWeather on top of v3)
  const v3Input: CompareInputV3 = {
    moodScore: input.moodScore,
    candidates: input.candidates,
    asOfUtc: input.asOfUtc,
    moodProfile: input.moodProfile,
    includePlaceContext: input.includePlaceContext,
  };

  // Get v3 result as base
  const v3Result = await compareLocationsV3(env, v3Input);

  // Fetch space weather (global, same for all cities)
  const spaceWeatherActive = input.includeSpaceWeather === true;
  let spaceWeatherBundle: SpaceWeatherBundle | null = null;
  let spaceWeatherFallback: { reason: string; httpStatuses: number[] } | null = null;

  if (spaceWeatherActive) {
    const swResult = await fetchSpaceWeatherBundle();
    spaceWeatherBundle = swResult.bundle;
    spaceWeatherFallback = swResult.fallback;
  }

  // If no space weather requested, return v3 result with null v4
  if (!spaceWeatherActive) {
    return {
      ...v3Result,
      methodVersion: v3Result.methodVersion,
      rankedLocations: v3Result.rankedLocations.map((r) => ({ ...r, v4: null })),
      spaceWeatherBundle: null,
      spaceWeatherFallback: null,
      scoreV4Weights: { base: 1, mood: 0, place: 0, spaceWeather: 0 },
    } as any;
  }

  // Compute v4 weights with renormalization
  const hasMood = v3Result.moodProfileFit !== null;
  const hasPlace = v3Result.rankedLocations.some((r) => r.v3?.placeFitScore !== null);
  const swAvailable = spaceWeatherBundle !== null;

  // When spaceWeather is available: base 0.55, mood 0.18, place 0.10, spaceWeather 0.17
  // When spaceWeather is null (failed): renormalize to base 0.65, mood 0.22, place 0.13, spaceWeather 0
  const wSpaceWeather = swAvailable ? 0.17 : 0;
  const effectiveWMood = swAvailable ? 0.18 : (hasMood ? 0.22 : 0);
  const effectiveWPlace = swAvailable ? 0.10 : (hasPlace ? 0.13 : 0);
  const effectiveWBase = swAvailable ? 0.55 : 0.65;

  const swFit = spaceWeatherBundle?.spaceWeatherFit ?? null;

  const ranked = v3Result.rankedLocations.map(
    (r): RankedLocation & { v3: RankedLocationV3 | null } & { v4: RankedLocationV4 | null } => {
      const baseScore = r.v3?.finalScoreV3 ?? r.astroWeatherFitScore;
      const moodScore = r.v3?.moodFitScore ?? 50;
      const placeScore = r.v3?.placeFitScore ?? 50;

      const finalScoreV4 = clamp01to100(
        effectiveWBase * baseScore +
        effectiveWMood * moodScore +
        effectiveWPlace * placeScore +
        (swFit !== null ? wSpaceWeather * swFit : 0)
      );

      return {
        ...r,
        v4: {
          spaceWeatherFit: swFit,
          spaceWeatherBundle,
          spaceWeatherFallback,
        },
      };
    }
  );

  // Sort by v4 composite score
  ranked.sort((a, b) => {
    const aBase = a.v3?.finalScoreV3 ?? a.astroWeatherFitScore;
    const bBase = b.v3?.finalScoreV3 ?? b.astroWeatherFitScore;
    const aMood = a.v3?.moodFitScore ?? 50;
    const bMood = b.v3?.moodFitScore ?? 50;
    const aPlace = a.v3?.placeFitScore ?? 50;
    const bPlace = b.v3?.placeFitScore ?? 50;
    const aFinal = effectiveWBase * aBase + effectiveWMood * aMood + effectiveWPlace * aPlace + (swFit !== null ? wSpaceWeather * swFit : 0);
    const bFinal = effectiveWBase * bBase + effectiveWMood * bMood + effectiveWPlace * bPlace + (swFit !== null ? wSpaceWeather * swFit : 0);
    if (bFinal !== aFinal) return bFinal - aFinal;
    return a.moodWeatherMismatch - b.moodWeatherMismatch;
  });
  ranked.forEach((r, i) => (r.rank = i + 1));

  const first = ranked[0];
  const firstBase = first.v3?.finalScoreV3 ?? first.astroWeatherFitScore;
  const swLabel = swFit !== null ? `, spaceWeatherFit=${swFit}/100 (global)` : ", spaceWeather=unavailable (renormalized)";
  const whyFirstPlace = `Score-v4 ranked ${first.location.name} first using weights base=${effectiveWBase}, mood=${effectiveWMood}, place=${effectiveWPlace}, spaceWeather=${wSpaceWeather}${swLabel}. Base=${firstBase}/100. Best reflection window starts at ${first.bestReflectionWindow.startLocal} with quality ${first.bestReflectionWindow.quality}/100.`;

  return {
    ...v3Result,
    methodVersion: "score-v4",
    rankedLocations: ranked,
    spaceWeatherBundle,
    spaceWeatherFallback,
    scoreV4Weights: {
      base: effectiveWBase,
      mood: effectiveWMood,
      place: effectiveWPlace,
      spaceWeather: wSpaceWeather,
    },
    whyFirstPlace,
  } as any;
}
