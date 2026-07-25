// Validation + scoring + comparison orchestration.
// All scoring math is deterministic and grounded in:
//   - the dominant elements of the sky profile (from src/astro.ts)
//   - current + 24-hour weather at each candidate location (from src/weather.ts)
//   - the user's self-reported mood activation (0 = very low, 10 = very high)

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

  // Comfort temperature (apparent). 18-24 ideal, 12-28 OK, else low.
  const tempScore =
    c.apparentTemperature >= 18 && c.apparentTemperature <= 24
      ? 10
      : c.apparentTemperature >= 12 && c.apparentTemperature <= 28
      ? 7
      : 4;

  // Daylight adds activation; night is calmer.
  const dayScore = c.isDay ? 7 : 3;

  // Wind: light-to-moderate energizes; very strong exhausts.
  const windScore =
    c.windSpeed <= 5 ? 6 : c.windSpeed <= 20 ? 10 : c.windSpeed <= 40 ? 6 : 3;

  // Clouds: partly cloudy is the most engaging band.
  const cloudScore =
    c.cloudCover <= 25 ? 9 : c.cloudCover <= 60 ? 10 : c.cloudCover <= 85 ? 6 : 4;

  // Any precipitation lowers activation.
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
// Each element contributes additive bonuses grounded in observable signals.
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
// Reflective = comfortable temperature, no precipitation, moderate wind, mild clouds, ideally daylight.
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

  // Geocentric: one astrology call shared across all cities in this comparison.
  const skyProfile: WesternSkyProfile = await fetchWesternSkyProfile(
    env.FREE_ASTROLOGY_API_KEY,
    asOfUtc,
    referenceCity
  );

  // Weather in parallel.
  const weathers: Weather[] = await Promise.all(
    input.candidates.map((c) => fetchLocationWeather(c))
  );

  const ranked: RankedLocation[] = weathers.map((w, idx) => {
    const wActivation = weatherActivation(w);
    const mismatch = Math.round(Math.abs(input.moodScore - wActivation) * 10); // 0-100
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

  // Sort: higher fit wins; tie-break on lower mismatch, then earlier window start, then input order.
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