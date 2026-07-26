// Validation + scoring + comparison orchestration.
// All scoring math is deterministic and grounded in:
//   - the dominant elements of the sky profile (from src/astro.ts)
//   - current + 24-hour weather at each candidate location (from src/weather.ts)
//   - the user's self-reported mood activation (0 = very low, 10 = very high)
//
// v0.3 (added at end of file) extends this with:
//   - MoodProfileSchema (optional 4-axis mood: energy, stress, focus, socialBattery)
//   - PlaceContext import from src/place.ts
//   - CompareInputV3Schema and compareLocationsV3 orchestrator
//   - RankedLocationV3 extension and ComparisonResultV3 type
//   - score-v3 = weighted combination of score-v1 + moodFit + placeFit
//   - If neither v0.3 field is present, score-v1 path is preserved exactly

import { z } from "zod";
import type { Element, WesternSkyProfile } from "./astro";
import { fetchWesternSkyProfile } from "./astro";
import type { City, Weather, WeatherHourly } from "./weather";
import { fetchLocationWeather } from "./weather";

// ----- Schemas -----

export const CitySchema = z.object({
  name: z.string().min(1).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
});

export const CompareInputSchema = z.object({
  moodScore: z.number().min(0).max(10),
  candidates: z.array(CitySchema).min(2).max(3),
  asOfUtc: z.string().datetime().optional(),
});

export type CompareInput = z.infer<typeof CompareInputSchema>;

export type MoodLabel = "very low" | "low" | "neutral" | "elevated" | "high";

export function moodLabel(score: number): MoodLabel {
  if (score <= 2) return "very low";
  if (score <= 4) return "low";
  if (score <= 6) return "neutral";
  if (score <= 8) return "elevated";
  return "high";
}

// ----- Validation entry point -----

export function validateCompareInput(
  body: unknown
): { ok: true; value: CompareInput } | { ok: false; error: string } {
  const result = CompareInputSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, value: result.data };
}

// ----- Scoring primitives -----

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// 0-10 activation score from current conditions.
// Higher = more activated / energetic outdoor conditions.
export function weatherActivation(w: Weather): number {
  const c = w.current;

  const tempScore =
    c.apparentTemperature >= 18 && c.apparentTemperature <= 24
      ? 10
      : c.apparentTemperature >= 12 && c.apparentTemperature <= 28
      ? 7
      : 4;

  const dayScore = c.isDay ? 7 : 3;

  const windScore =
    c.windSpeed <= 5 ? 6 : c.windSpeed <= 20 ? 10 : c.windSpeed <= 40 ? 6 : 3;

  const cloudScore =
    c.cloudCover <= 25 ? 9 : c.cloudCover <= 60 ? 10 : c.cloudCover <= 85 ? 6 : 4;

  const precipScore = c.precipitation === 0 ? 10 : c.precipitation < 1 ? 7 : 3;

  return Math.round(
    tempScore * 0.30 +
      dayScore * 0.20 +
      windScore * 0.20 +
      cloudScore * 0.15 +
      precipScore * 0.15
  );
}

// 0-100 alignment score: how well the dominant sky elements "match" current weather.
function elementWeatherAlignment(
  dominantElements: Element[],
  w: Weather
): { score: number; explanation: string[] } {
  const c = w.current;
  const explanation: string[] = [];
  let score = 50;

  for (const elem of dominantElements) {
    if (elem === "fire") {
      const dayBonus = c.isDay ? 15 : -10;
      const tempBonus = c.apparentTemperature >= 20 ? 10 : -5;
      const cloudBonus = c.cloudCover <= 40 ? 10 : -10;
      score += dayBonus + tempBonus + cloudBonus;
      explanation.push(
        `Fire element: ${c.isDay ? "daylight" : "night"}, ${c.apparentTemperature >= 20 ? "warm" : "cool"}, ${c.cloudCover <= 40 ? "open sky" : "cloudy"}`
      );
    } else if (elem === "water") {
      const humidBonus = c.humidity >= 60 ? 10 : -5;
      const cloudBonus = c.cloudCover >= 40 ? 10 : -5;
      const precipBonus = c.precipitation > 0 ? 5 : 0;
      score += humidBonus + cloudBonus + precipBonus;
      explanation.push(
        `Water element: humidity ${c.humidity}%, cloud ${c.cloudCover}%, precipitation ${c.precipitation}mm`
      );
    } else if (elem === "air") {
      const windBonus = c.windSpeed >= 5 && c.windSpeed <= 25 ? 12 : -3;
      const cloudBonus = c.cloudCover <= 70 ? 6 : -2;
      score += windBonus + cloudBonus;
      explanation.push(`Air element: wind ${c.windSpeed}km/h, cloud ${c.cloudCover}%`);
    } else if (elem === "earth") {
      const stableBonus = c.windSpeed <= 15 ? 12 : -5;
      const mildBonus = c.apparentTemperature >= 10 && c.apparentTemperature <= 26 ? 10 : -3;
      score += stableBonus + mildBonus;
      explanation.push(
        `Earth element: stable wind ${c.windSpeed}km/h, mild temperature ${c.apparentTemperature}C`
      );
    }
  }

  return { score: clamp(Math.round(score), 0, 100), explanation };
}

// Find the most "reflective" 1-hour window in the next 24 hours.
function bestReflectionWindow(w: Weather): {
  startLocal: string;
  endLocal: string;
  quality: number;
  reason: string;
} {
  const hourly = w.hourly;
  if (hourly.length < 2) {
    const fallback = hourly[0] ?? null;
    return {
      startLocal: fallback?.time ?? w.current.time,
      endLocal: fallback?.time ?? w.current.time,
      quality: 0,
      reason: "Insufficient hourly data; window unavailable.",
    };
  }

  let bestIndex = 0;
  let bestQuality = -1;

  for (let i = 0; i < hourly.length - 1; i++) {
    const h = hourly[i];
    const next = hourly[i + 1];
    let q = 50;
    if (h.temperature >= 15 && h.temperature <= 25) q += 15;
    if (h.precipitation === 0) q += 15;
    if (h.cloudCover >= 20 && h.cloudCover <= 70) q += 10;
    if (h.windSpeed >= 3 && h.windSpeed <= 20) q += 10;
    if (h.isDay) q += 5;
    if (next.precipitation === 0) q += 5;
    if (q > bestQuality) {
      bestQuality = q;
      bestIndex = i;
    }
  }

  const start = hourly[bestIndex];
  const end = hourly[Math.min(bestIndex + 1, hourly.length - 1)];
  return {
    startLocal: start.time,
    endLocal: end.time,
    quality: clamp(Math.round(bestQuality), 0, 100),
    reason: `Best 1-hour slot: temperature ${start.temperature}C, cloud ${start.cloudCover}%, precipitation ${start.precipitation}mm, wind ${start.windSpeed}km/h`,
  };
}

// Score a single hourly slot using the same three factor families as score-v1.
function scoreHourlySlot(
  h: WeatherHourly,
  dominantElements: Element[],
  moodScore: number
): { qualityScore: number; weatherReasons: string[]; astroReasons: string[]; moodReason: string } {
  const weatherReasons: string[] = [];
  const astroReasons: string[] = [];
  let elementScore = 50;
  let weatherScore = 50;

  for (const elem of dominantElements) {
    if (elem === "fire") {
      if (h.isDay) { elementScore += 15; astroReasons.push("Fire: daylight"); }
      else { elementScore -= 10; astroReasons.push("Fire: nighttime"); }
      if (h.temperature >= 20) { elementScore += 10; astroReasons.push("Fire: warm"); }
      else { elementScore -= 5; }
      if (h.cloudCover <= 40) { elementScore += 10; astroReasons.push("Fire: open sky"); }
      else { elementScore -= 10; }
    } else if (elem === "water") {
      if (h.humidity >= 60) { elementScore += 10; astroReasons.push("Water: humid"); }
      if (h.cloudCover >= 40) { elementScore += 10; }
    } else if (elem === "air") {
      if (h.windSpeed >= 5 && h.windSpeed <= 25) { elementScore += 12; astroReasons.push("Air: moderate wind"); }
      if (h.cloudCover <= 70) { elementScore += 6; }
    } else if (elem === "earth") {
      if (h.windSpeed <= 15) { elementScore += 12; astroReasons.push("Earth: stable wind"); }
      if (h.temperature >= 10 && h.temperature <= 26) { elementScore += 10; }
    }
  }

  if (h.temperature >= 15 && h.temperature <= 25) { weatherScore += 15; weatherReasons.push(`Comfortable temp ${h.temperature}C`); }
  if (h.precipitation === 0) { weatherScore += 15; weatherReasons.push("No precipitation"); }
  if (h.cloudCover >= 20 && h.cloudCover <= 70) { weatherScore += 10; weatherReasons.push(`Partly cloudy ${h.cloudCover}%`); }
  if (h.windSpeed >= 3 && h.windSpeed <= 20) { weatherScore += 10; weatherReasons.push(`Moderate wind ${h.windSpeed}km/h`); }
  if (h.isDay) { weatherScore += 5; weatherReasons.push("Daylight"); }

  const wActivation = clamp(Math.round(
    (h.temperature >= 15 && h.temperature <= 25 ? 7 : 4) * 0.30 +
    (h.isDay ? 7 : 3) * 0.20 +
    (h.windSpeed <= 5 ? 6 : h.windSpeed <= 20 ? 10 : 6) * 0.20 +
    (h.cloudCover <= 60 ? 10 : 6) * 0.15 +
    (h.precipitation === 0 ? 10 : 5) * 0.15
  ), 0, 10);
  const mismatch = Math.round(Math.abs(moodScore - wActivation) * 10);
  const mismatchInverse = 100 - mismatch;
  const moodReason = `Mood activation ${moodScore}, weather activation ${wActivation}, mismatch ${mismatch}/100`;

  const qualityScore = clamp(Math.round(
    0.45 * clamp(elementScore, 0, 100) +
    0.35 * mismatchInverse +
    0.20 * clamp(weatherScore, 0, 100)
  ), 0, 100);

  return { qualityScore, weatherReasons, astroReasons, moodReason };
}

// ----- Public types -----

export type RankedLocation = {
  rank: number;
  location: City;
  astroWeatherFitScore: number;
  moodWeatherMismatch: number;
  elementWeatherAlignment: { score: number; explanation: string[] };
  dayNightTimingNote: string;
  bestReflectionWindow: { startLocal: string; endLocal: string; quality: number; reason: string };
  weatherEvidence: {
    temperature: number;
    cloudCover: number;
    precipitation: number;
    windSpeed: number;
    isDay: boolean;
  };
  scoreComponents: { element: number; mismatchInverse: number; window: number };
};

export type ComparisonResult = {
  methodVersion: "score-v1";
  asOfUtc: string;
  moodInterpretation: { score: number; label: MoodLabel };
  skyProfile: { dominantElements: string[]; keyPlanet: string };
  rankedLocations: RankedLocation[];
  whyFirstPlace: string;
  dataFreshness: string;
  disclaimer: string;
};

// ----- Comparison orchestration -----

export async function compareLocations(
  env: { FREE_ASTROLOGY_API_KEY: string },
  input: CompareInput
): Promise<ComparisonResult> {
  const asOfUtc = input.asOfUtc ?? new Date().toISOString();
  const referenceCity = input.candidates[0];

  const skyProfile: WesternSkyProfile = await fetchWesternSkyProfile(
    env.FREE_ASTROLOGY_API_KEY,
    asOfUtc,
    referenceCity
  );

  const weathers: Weather[] = await Promise.all(
    input.candidates.map((c) => fetchLocationWeather(c))
  );

  const ranked: RankedLocation[] = weathers.map((w, idx) => {
    const wActivation = weatherActivation(w);
    const mismatch = Math.round(Math.abs(input.moodScore - wActivation) * 10);
    const align = elementWeatherAlignment(skyProfile.dominantElements, w);
    const window = bestReflectionWindow(w);

    const fit = Math.round(
      0.45 * align.score + 0.35 * (100 - mismatch) + 0.2 * window.quality
    );

    return {
      rank: 0,
      location: input.candidates[idx],
      astroWeatherFitScore: fit,
      moodWeatherMismatch: mismatch,
      elementWeatherAlignment: align,
      dayNightTimingNote: w.current.isDay
        ? `Daytime: apparent temperature ${w.current.apparentTemperature}C, feels like ${w.current.apparentTemperature}C`
        : `Nighttime: apparent temperature ${w.current.apparentTemperature}C`,
      bestReflectionWindow: window,
      weatherEvidence: {
        temperature: w.current.apparentTemperature,
        cloudCover: w.current.cloudCover,
        precipitation: w.current.precipitation,
        windSpeed: w.current.windSpeed,
        isDay: w.current.isDay,
      },
      scoreComponents: {
        element: align.score,
        mismatchInverse: 100 - mismatch,
        window: window.quality,
      },
    };
  });

  ranked.sort((a, b) => {
    if (b.astroWeatherFitScore !== a.astroWeatherFitScore) {
      return b.astroWeatherFitScore - a.astroWeatherFitScore;
    }
    if (a.moodWeatherMismatch !== b.moodWeatherMismatch) {
      return a.moodWeatherMismatch - b.moodWeatherMismatch;
    }
    if (a.bestReflectionWindow.startLocal !== b.bestReflectionWindow.startLocal) {
      return a.bestReflectionWindow.startLocal < b.bestReflectionWindow.startLocal ? -1 : 1;
    }
    return 0;
  });
  ranked.forEach((r, i) => (r.rank = i + 1));

  const sun = skyProfile.planets.find((p) => p.name.toLowerCase() === "sun");
  const moon = skyProfile.planets.find((p) => p.name.toLowerCase() === "moon");
  const keyPlanet = sun?.zodiacSign
    ? `Sun in ${sun.zodiacSign}`
    : moon?.zodiacSign
    ? `Moon in ${moon.zodiacSign}`
    : skyProfile.planets[0]?.zodiacSign
    ? `${skyProfile.planets[0].name} in ${skyProfile.planets[0].zodiacSign}`
    : "Unknown";

  const first = ranked[0];
  const whyFirstPlace = `${first.location.name} ranked first because ${first.elementWeatherAlignment.explanation.join(
    "; "
  )}. Mood-weather mismatch is ${first.moodWeatherMismatch}/100 (lower is closer to your activation). Best reflection window starts at ${first.bestReflectionWindow.startLocal} with quality ${first.bestReflectionWindow.quality}/100.`;

  return {
    methodVersion: "score-v1",
    asOfUtc,
    moodInterpretation: { score: input.moodScore, label: moodLabel(input.moodScore) },
    skyProfile: { dominantElements: skyProfile.dominantElements, keyPlanet },
    rankedLocations: ranked,
    whyFirstPlace,
    dataFreshness: `Sky profile fetched ${skyProfile.fetchedAtUtc}; weather data current as of comparison time.`,
    disclaimer:
      "Reflective practice only. Not medical, financial, legal, or predictive advice.",
  };
}

// ----- New helpers for MCP tools (Attempt #2) -----

/** Explain why one selected candidate received its score after a comparison. */
export async function explainLocationScore(
  env: { FREE_ASTROLOGY_API_KEY: string },
  input: CompareInput & { targetLocationName: string }
): Promise<{
  methodVersion: "score-v1";
  asOfUtc: string;
  targetLocation: { rank: number; location: City; astroWeatherFitScore: number };
  scoreBreakdown: {
    element: { rawScore: number; weight: 0.45; weightedContribution: number };
    moodMatch: { moodWeatherMismatch: number; inverseScore: number; weight: 0.35; weightedContribution: number };
    window: { rawScore: number; weight: 0.20; weightedContribution: number };
    recomputedTotal: number;
  };
  elementWeatherAlignment: { score: number; explanation: string[] };
  bestWindowReasoning: { startLocal: string; endLocal: string; quality: number; reason: string };
  caveats: string[];
  disclaimer: string;
}> {
  const asOfUtc = input.asOfUtc ?? new Date().toISOString();

  const matches = input.candidates.filter((c) => c.name === input.targetLocationName);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `targetLocationName "${input.targetLocationName}" does not match any candidate. Candidates: ${input.candidates.map((c) => c.name).join(", ")}`
        : `targetLocationName "${input.targetLocationName}" matches multiple candidates. Use an exact unique name.`
    );
  }

  const result = await compareLocations(env, input);
  const target = result.rankedLocations.find((r) => r.location.name === input.targetLocationName);
  if (!target) throw new Error("Internal error: target location not found in ranked results.");

  const { element, mismatchInverse, window: windowScore } = target.scoreComponents;
  const weightedElement = Math.round(element * 0.45 * 100) / 100;
  const weightedMood = Math.round(mismatchInverse * 0.35 * 100) / 100;
  const weightedWindow = Math.round(windowScore * 0.20 * 100) / 100;
  const recomputedTotal = Math.round(0.45 * element + 0.35 * mismatchInverse + 0.20 * windowScore);

  return {
    methodVersion: "score-v1",
    asOfUtc,
    targetLocation: {
      rank: target.rank,
      location: target.location,
      astroWeatherFitScore: target.astroWeatherFitScore,
    },
    scoreBreakdown: {
      element: { rawScore: element, weight: 0.45, weightedContribution: weightedElement },
      moodMatch: { moodWeatherMismatch: target.moodWeatherMismatch, inverseScore: mismatchInverse, weight: 0.35, weightedContribution: weightedMood },
      window: { rawScore: windowScore, weight: 0.20, weightedContribution: weightedWindow },
      recomputedTotal,
    },
    elementWeatherAlignment: target.elementWeatherAlignment,
    bestWindowReasoning: target.bestReflectionWindow,
    caveats: [
      "Scoring weights (0.45/0.35/0.20) are design assumptions, not validated truth.",
      "Geocentric sky profile is shared across all cities; individual local celestial positions may vary.",
      "Weather data is current as of the comparison timestamp and may change.",
    ],
    disclaimer: result.disclaimer,
  };
}

/** Find the best 1-hour and 3-hour reflection windows for a single location. */
export async function findReflectionWindow(
  env: { FREE_ASTROLOGY_API_KEY: string },
  input: {
    location: City;
    moodScore: number;
    asOfUtc?: string;
    windowHoursAhead?: number;
  }
): Promise<{
  methodVersion: "reflection-window-v1";
  asOfUtc: string;
  location: City;
  moodInterpretation: { score: number; label: MoodLabel };
  skyProfile: { dominantElements: string[]; keyPlanet: string };
  best1Hour: {
    startLocal: string;
    endLocal: string;
    timezone: string;
    qualityScore: number;
    weatherReasons: string[];
    astroReasons: string[];
    moodReason: string;
  };
  best3Hours: {
    startLocal: string;
    endLocal: string;
    timezone: string;
    qualityScore: number;
    weatherReasons: string[];
    astroReasons: string[];
    moodReason: string;
  };
  fallback: { used: boolean; threshold: number; reason: string | null; returnedBestAvailable: boolean };
  sourceRecords: {
    astrology: { provider: string; endpointFamily: string; fetchedAtUtc: string };
    weather: { provider: string; fetchedAtUtc: string; horizonHours: number };
  };
  caveats: string[];
  disclaimer: string;
}> {
  const asOfUtc = input.asOfUtc ?? new Date().toISOString();
  const windowHoursAhead = clamp(input.windowHoursAhead ?? 24, 3, 24);

  const skyProfile = await fetchWesternSkyProfile(env.FREE_ASTROLOGY_API_KEY, asOfUtc, input.location);
  const weather = await fetchLocationWeather(input.location);

  const hourlySlice = weather.hourly.slice(0, windowHoursAhead);

  const slotResults = hourlySlice.map((h, idx) => ({
    idx,
    ...scoreHourlySlot(h, skyProfile.dominantElements, input.moodScore),
    time: h.time,
  }));

  const best1HourIdx = slotResults.reduce((best, cur, idx) =>
    cur.qualityScore > slotResults[best].qualityScore ? idx : best, 0);
  const best1HourSlot = slotResults[best1HourIdx];
  const best1HourEnd = hourlySlice[Math.min(best1HourIdx + 1, hourlySlice.length - 1)];

  let best3HourStartIdx = 0;
  let best3HourMean = -1;
  for (let i = 0; i <= slotResults.length - 3; i++) {
    const mean = Math.round((slotResults[i].qualityScore + slotResults[i + 1].qualityScore + slotResults[i + 2].qualityScore) / 3);
    if (mean > best3HourMean) {
      best3HourMean = mean;
      best3HourStartIdx = i;
    }
  }
  const best3HourEnd = hourlySlice[Math.min(best3HourStartIdx + 2, hourlySlice.length - 1)];

  const threshold = 65;
  const bothBelowThreshold = best1HourSlot.qualityScore < threshold && best3HourMean < threshold;
  const fallbackUsed = bothBelowThreshold;

  const sun = skyProfile.planets.find((p) => p.name.toLowerCase() === "sun");
  const moon = skyProfile.planets.find((p) => p.name.toLowerCase() === "moon");
  const keyPlanet = sun?.zodiacSign
    ? `Sun in ${sun.zodiacSign}`
    : moon?.zodiacSign
    ? `Moon in ${moon.zodiacSign}`
    : skyProfile.planets[0]?.zodiacSign
    ? `${skyProfile.planets[0].name} in ${skyProfile.planets[0].zodiacSign}`
    : "Unknown";

  const slot1 = slotResults[best3HourStartIdx];
  const slot2 = slotResults[best3HourStartIdx + 1];
  const slot3 = slotResults[best3HourStartIdx + 2];

  return {
    methodVersion: "reflection-window-v1",
    asOfUtc,
    location: input.location,
    moodInterpretation: { score: input.moodScore, label: moodLabel(input.moodScore) },
    skyProfile: { dominantElements: skyProfile.dominantElements, keyPlanet },
    best1Hour: {
      startLocal: best1HourSlot.time,
      endLocal: best1HourEnd.time,
      timezone: input.location.timezone,
      qualityScore: best1HourSlot.qualityScore,
      weatherReasons: best1HourSlot.weatherReasons,
      astroReasons: best1HourSlot.astroReasons,
      moodReason: best1HourSlot.moodReason,
    },
    best3Hours: {
      startLocal: slot1.time,
      endLocal: best3HourEnd.time,
      timezone: input.location.timezone,
      qualityScore: best3HourMean,
      weatherReasons: [
        ...slot1.weatherReasons,
        ...(slot2 ? slot2.weatherReasons : []),
        ...(slot3 ? slot3.weatherReasons : []),
      ],
      astroReasons: [
        ...slot1.astroReasons,
        ...(slot2 ? slot2.astroReasons : []),
        ...(slot3 ? slot3.astroReasons : []),
      ],
      moodReason: best1HourSlot.moodReason,
    },
    fallback: {
      used: fallbackUsed,
      threshold,
      reason: fallbackUsed
        ? "Both best 1-hour (" + best1HourSlot.qualityScore + "/100) and best 3-hour (" + best3HourMean + "/100) are below threshold " + threshold + ". Returned best available windows."
        : null,
      returnedBestAvailable: fallbackUsed,
    },
    sourceRecords: {
      astrology: {
        provider: "Free Astrology API",
        endpointFamily: "western/planets",
        fetchedAtUtc: skyProfile.fetchedAtUtc,
      },
      weather: {
        provider: "Open-Meteo",
        fetchedAtUtc: new Date().toISOString(),
        horizonHours: windowHoursAhead,
      },
    },
    caveats: [
      "reflection-window-v1 uses a threshold of " + threshold + " as a design assumption.",
      "Three-hour quality is the rounded mean of three consecutive hourly scores.",
      "Weather data is current and may change; window times are local to the requested location.",
    ],
    disclaimer: "Reflective practice only. Not medical, financial, legal, or predictive advice.",
  };
}

/** Convert a full comparison into compact JSON another agent can consume. */
export async function generateAgentBrief(
  env: { FREE_ASTROLOGY_API_KEY: string },
  input: CompareInput
): Promise<{
  schemaVersion: "agent-brief-v1";
  methodVersion: "score-v1";
  asOfUtc: string;
  recommendedCity: City;
  bestTime: { startLocal: string; endLocal: string; timezone: string; qualityScore: number };
  why: string;
  avoidIfConditions: string[];
  sourceRecords: {
    astrology: {
      provider: string;
      endpointFamily: string;
      asOfUtc: string;
      dominantElements: string[];
      keyPlanet: string;
    };
    weather: Array<{ provider: string; location: City; weatherEvidence: RankedLocation["weatherEvidence"] }>;
  };
  disclaimer: string;
}> {
  const asOfUtc = input.asOfUtc ?? new Date().toISOString();
  const result = await compareLocations(env, input);
  const first = result.rankedLocations[0];

  const avoidIfConditions: string[] = [];
  if (first.moodWeatherMismatch > 50) {
    avoidIfConditions.push("High mood-weather mismatch (>50): activation level may not match outdoor conditions.");
  }
  if (first.weatherEvidence.precipitation > 0) {
    avoidIfConditions.push("Precipitation detected (" + first.weatherEvidence.precipitation + "mm): conditions may change.");
  }
  if (first.weatherEvidence.windSpeed > 30) {
    avoidIfConditions.push("Strong wind (" + first.weatherEvidence.windSpeed + "km/h): may affect outdoor plans.");
  }
  if (first.bestReflectionWindow.quality < 65) {
    avoidIfConditions.push("Best window quality below 65 (" + first.bestReflectionWindow.quality + "/100): no strong reflection window available.");
  }
  if (!first.weatherEvidence.isDay) {
    avoidIfConditions.push("Nighttime at recommended location: daytime may be more activating.");
  }

  return {
    schemaVersion: "agent-brief-v1",
    methodVersion: "score-v1",
    asOfUtc,
    recommendedCity: first.location,
    bestTime: {
      startLocal: first.bestReflectionWindow.startLocal,
      endLocal: first.bestReflectionWindow.endLocal,
      timezone: first.location.timezone,
      qualityScore: first.bestReflectionWindow.quality,
    },
    why: result.whyFirstPlace,
    avoidIfConditions,
    sourceRecords: {
      astrology: {
        provider: "Free Astrology API",
        endpointFamily: "western/planets",
        asOfUtc,
        dominantElements: result.skyProfile.dominantElements,
        keyPlanet: result.skyProfile.keyPlanet,
      },
      weather: result.rankedLocations.map((r) => ({
        provider: "Open-Meteo",
        location: r.location,
        weatherEvidence: r.weatherEvidence,
      })),
    },
    disclaimer: result.disclaimer,
  };
}

// =============================================================================
// v0.3 additions: MoodProfile, CompareInputV3, score-v3 path
// =============================================================================

import type { PlaceContext, PlaceTag } from "./place";
import { fetchPlaceContext, PLACE_MOOD_COMPATIBILITY } from "./place";

export const MoodProfileSchema = z
  .object({
    energy: z.number().min(0).max(10).optional(),
    stress: z.number().min(0).max(10).optional(),
    focus: z.number().min(0).max(10).optional(),
    socialBattery: z.number().min(0).max(10).optional(),
  })
  .strict();

export type MoodProfile = z.infer<typeof MoodProfileSchema>;

export const CompareInputV3Schema = z.object({
  moodScore: z.number().min(0).max(10),
  candidates: z.array(CitySchema).min(2).max(3),
  asOfUtc: z.string().datetime().optional(),
  moodProfile: MoodProfileSchema.optional(),
  includePlaceContext: z.boolean().optional(),
});

export type CompareInputV3 = z.infer<typeof CompareInputV3Schema>;

export interface RankedLocationV3 {
  moodFitScore: number | null;
  placeFitScore: number | null;
  placeContext: PlaceContext | null;
  finalScoreV3: number;
  weights: { base: number; mood: number; place: number } | null;
}

export type ComparisonResultV3 = Omit<ComparisonResult, "methodVersion" | "rankedLocations"> & {
  methodVersion: "score-v1" | "score-v3";
  rankedLocations: Array<RankedLocation & { v3: RankedLocationV3 | null }>;
  derivedMoodProfile: MoodProfile | null;
  placeContextList: PlaceContext[] | null;
  moodProfileFit: number | null;
  scoreV3Weights: { base: number; mood: number; place: number };
};

export function deriveDefaultMoodProfile(moodScore: number): Required<MoodProfile> {
  const m = Math.max(0, Math.min(10, moodScore));
  if (m <= 2) return { energy: 2, stress: 8, focus: 3, socialBattery: 2 };
  if (m <= 4) return { energy: 4, stress: 6, focus: 4, socialBattery: 4 };
  if (m <= 6) return { energy: 5, stress: 5, focus: 5, socialBattery: 5 };
  if (m <= 8) return { energy: 7, stress: 4, focus: 6, socialBattery: 7 };
  return { energy: 9, stress: 2, focus: 8, socialBattery: 8 };
}

function clamp01to100(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function computePlaceFit(profile: Required<MoodProfile>, tags: PlaceTag[]): number {
  if (tags.length === 0) return 50;
  let totalDelta = 0;
  let count = 0;
  const axes: Array<"energy" | "stress" | "focus" | "socialBattery"> = [
    "energy",
    "stress",
    "focus",
    "socialBattery",
  ];
  for (const tag of tags) {
    const compat = PLACE_MOOD_COMPATIBILITY[tag.tag];
    for (const axis of axes) {
      const delta = compat[axis] ?? 0;
      if (delta === 0) continue;
      const centerTarget = axis === "stress" ? 5 - profile[axis] : profile[axis] - 5;
      totalDelta += centerTarget * delta;
      count += 1;
    }
  }
  if (count === 0) return 50;
  const normalized = 50 + (totalDelta / Math.max(1, count)) * 6;
  return clamp01to100(normalized);
}

function resolveMoodProfile(
  input: CompareInputV3
): { profile: Required<MoodProfile>; provided: boolean } {
  const p = input.moodProfile;
  const provided = !!p && Object.keys(p).length > 0;
  const base = deriveDefaultMoodProfile(input.moodScore);
  if (!provided) return { profile: base, provided: false };
  return {
    profile: {
      energy: Math.max(0, Math.min(10, p!.energy ?? base.energy)),
      stress: Math.max(0, Math.min(10, p!.stress ?? base.stress)),
      focus: Math.max(0, Math.min(10, p!.focus ?? base.focus)),
      socialBattery: Math.max(0, Math.min(10, p!.socialBattery ?? base.socialBattery)),
    },
    provided: true,
  };
}

function computeMoodFitFromProfile(profile: Required<MoodProfile>): number {
  const sumDelta =
    Math.abs(profile.energy - 5) +
    Math.abs(profile.stress - 5) +
    Math.abs(profile.focus - 5) +
    Math.abs(profile.socialBattery - 5);
  return clamp01to100(100 - sumDelta * 5);
}

export function validateCompareInputV3(
  body: unknown
): { ok: true; value: CompareInputV3 } | { ok: false; error: string } {
  const result = CompareInputV3Schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, value: result.data };
}

export async function compareLocationsV3(
  env: { FREE_ASTROLOGY_API_KEY: string },
  input: CompareInputV3
): Promise<ComparisonResultV3> {
  const v1Input: CompareInput = {
    moodScore: input.moodScore,
    candidates: input.candidates,
    asOfUtc: input.asOfUtc,
  };
  const base = await compareLocations(env, v1Input);

  const placeRequested = input.includePlaceContext === true;
  const { profile: moodProfile, provided: moodProvided } = resolveMoodProfile(input);

  let placeContexts: PlaceContext[] | null = null;
  if (placeRequested) {
    placeContexts = await Promise.all(
      input.candidates.map((c) => fetchPlaceContext(c))
    );
  }

  const moodActive = moodProvided;
  const placeActive = placeRequested;

  if (!moodActive && !placeActive) {
    return {
      ...base,
      methodVersion: "score-v1",
      rankedLocations: base.rankedLocations.map((r) => ({ ...r, v3: null })),
      derivedMoodProfile: null,
      placeContextList: null,
      moodProfileFit: null,
      scoreV3Weights: { base: 1, mood: 0, place: 0 },
    };
  }

  const wMood = moodActive ? 0.20 : 0;
  const wPlace = placeActive ? 0.10 : 0;
  const wBase = Math.round((1 - wMood - wPlace) * 100) / 100;
  const moodFit = moodActive ? computeMoodFitFromProfile(moodProfile) : null;

  const cityIdentity = (city: City): string =>
    `${city.name.trim().toLowerCase()}|${city.latitude.toFixed(4)}|${city.longitude.toFixed(4)}`;
  const placeContextByCity: Map<string, PlaceContext> | null = placeContexts
    ? new Map<string, PlaceContext>(
        input.candidates.map((c, i) => [cityIdentity(c), placeContexts[i]])
      )
    : null;

  const ranked = base.rankedLocations.map(
    (r): RankedLocation & { v3: RankedLocationV3 | null } => {
      const placeContext = placeContextByCity
        ? placeContextByCity.get(cityIdentity(r.location)) ?? null
        : null;
      const placeFit = placeContext ? computePlaceFit(moodProfile, placeContext.tags) : null;
      const m = moodFit ?? 50;
      const p = placeFit ?? 50;
      const finalScoreV3 = clamp01to100(
        wBase * r.astroWeatherFitScore + wMood * m + wPlace * p
      );
      return {
        ...r,
        v3: {
          moodFitScore: moodFit,
          placeFitScore: placeFit,
          placeContext,
          finalScoreV3,
          weights: { base: wBase, mood: wMood, place: wPlace },
        },
      };
    }
  );

  ranked.sort((a, b) => {
    const ba = b.v3?.finalScoreV3 ?? b.astroWeatherFitScore;
    const aa = a.v3?.finalScoreV3 ?? a.astroWeatherFitScore;
    if (ba !== aa) return ba - aa;
    return a.moodWeatherMismatch - b.moodWeatherMismatch;
  });
  ranked.forEach((r, i) => (r.rank = i + 1));

  const first = ranked[0];
  const whyFirstPlace = `Score-v3 ranked ${first.location.name} first using weights base=${wBase}, mood=${wMood}, place=${wPlace} with finalScoreV3=${first.v3?.finalScoreV3 ?? first.astroWeatherFitScore}/100. Mood-weather mismatch is ${first.moodWeatherMismatch}/100. Best reflection window starts at ${first.bestReflectionWindow.startLocal} with quality ${first.bestReflectionWindow.quality}/100.`;

  return {
    ...base,
    methodVersion: "score-v3",
    rankedLocations: ranked,
    derivedMoodProfile: moodProfile,
    placeContextList: placeContexts,
    moodProfileFit: moodFit,
    scoreV3Weights: { base: wBase, mood: wMood, place: wPlace },
    whyFirstPlace,
  };
}