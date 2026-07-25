// Free Astrology API client (https://json.freeastrologyapi.com/western/planets)
// Server-side only. x-api-key header carries the secret from env.

export type Element = "fire" | "earth" | "air" | "water";

export type Planet = {
  name: string;
  fullDegree: number;
  normDegree: number;
  isRetro: boolean;
  zodiacSign: string;
  element: Element;
};

export type WesternSkyProfile = {
  asOfUtc: string;
  observationPoint: { name: string; latitude: number; longitude: number; timezone: string };
  scope: "geocentric";
  planets: Planet[];
  elementBalance: { fire: number; earth: number; air: number; water: number };
  dominantElements: Element[];
  provider: string;
  fetchedAtUtc: string;
};

const FREE_ASTROLOGY_URL = "https://json.freeastrologyapi.com/western/planets";

const SIGN_ELEMENT: Record<string, Element> = {
  Aries: "fire",
  Leo: "fire",
  Sagittarius: "fire",
  Taurus: "earth",
  Virgo: "earth",
  Capricorn: "earth",
  Gemini: "air",
  Libra: "air",
  Aquarius: "air",
  Cancer: "water",
  Scorpio: "water",
  Pisces: "water",
};

function inferElement(zodiacName: string): Element {
  return SIGN_ELEMENT[zodiacName] ?? "earth";
}

// Compute the UTC offset (in minutes) for a given IANA timezone at a given instant.
// Uses Intl.DateTimeFormat so DST transitions are handled.
export function getUtcOffsetMinutes(date: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "longOffset")?.value ?? "GMT+00:00";
    const match = tzPart.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!match) return 0;
    const sign = match[1] === "+" ? 1 : -1;
    return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
  } catch {
    return 0;
  }
}

// Safe normalization for boolean isRetro.
// true only for boolean true, "true", or "True". false for everything else.
function normalizeIsRetro(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const v = value.trim();
    if (v === "true" || v === "True") return true;
  }
  return false;
}

// Safe normalization for planet name from item.name, item.planet.en, item.planet.
function normalizePlanetName(item: any): string {
  if (typeof item?.name === "string" && item.name.length > 0) return item.name;
  if (item?.planet && typeof item.planet.en === "string" && item.planet.en.length > 0) {
    return item.planet.en;
  }
  if (typeof item?.planet === "string" && item.planet.length > 0) return item.planet;
  return "Unknown";
}

// Safe normalization for zodiac sign from item.zodiacSignName, item.zodiacSign, item.sign, item.zodiac_sign.name.en.
function normalizeZodiacSign(item: any): string {
  if (typeof item?.zodiacSignName === "string" && item.zodiacSignName.length > 0) {
    return item.zodiacSignName;
  }
  if (typeof item?.zodiacSign === "string" && item.zodiacSign.length > 0) {
    return item.zodiacSign;
  }
  if (typeof item?.sign === "string" && item.sign.length > 0) return item.sign;
  if (
    item?.zodiac_sign &&
    item.zodiac_sign.name &&
    typeof item.zodiac_sign.name.en === "string" &&
    item.zodiac_sign.name.en.length > 0
  ) {
    return item.zodiac_sign.name.en;
  }
  return "Aries";
}

export async function fetchWesternSkyProfile(
  apiKey: string,
  asOfUtc: string,
  referenceLocation: { name: string; latitude: number; longitude: number; timezone: string }
): Promise<WesternSkyProfile> {
  const date = new Date(asOfUtc);
  const offsetMinutes = getUtcOffsetMinutes(date, referenceLocation.timezone);

  // Free Astrology expects the local civil time at the reference location.
  const localMillis = date.getTime() + offsetMinutes * 60_000;
  const local = new Date(localMillis);

  const body = {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    date: local.getUTCDate(),
    hours: local.getUTCHours(),
    minutes: local.getUTCMinutes(),
    seconds: local.getUTCSeconds(),
    latitude: referenceLocation.latitude,
    longitude: referenceLocation.longitude,
    timezone: offsetMinutes / 60,
    config: {
      observation_point: "geocentric",
      ayanamsha: "tropical",
      language: "en",
    },
  };

  const response = await fetch(FREE_ASTROLOGY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Free Astrology API responded ${response.status}`);
  }

  const data: any = await response.json();

  // Safe-error context: top-level keys only (no upstream body leak).
  const topLevelKeys: string[] =
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.keys(data)
      : Array.isArray(data)
        ? ["<root array>"]
        : [];

  // Accept planet arrays from: root, output, data, result, planets.
  const rawPlanets: any[] | null = Array.isArray(data)
    ? data
    : Array.isArray(data?.output)
      ? data.output
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.result)
          ? data.result
          : Array.isArray(data?.planets)
            ? data.planets
            : null;

  if (rawPlanets === null) {
    throw new Error(
      `Free Astrology API responded ${response.status} with top-level keys: ${topLevelKeys.join(", ")}`
    );
  }

  const planets: Planet[] = rawPlanets.map((item: any) => {
    const name = normalizePlanetName(item);
    const fullDegree = Number(item.fullDegree ?? item.degree ?? 0);
    const normDegree = Number(item.normDegree ?? ((fullDegree % 30 + 30) % 30));
    const isRetro = normalizeIsRetro(item.isRetro ?? item.retrograde);
    const zodiacSign = normalizeZodiacSign(item);
    const element = inferElement(zodiacSign);
    return { name, fullDegree, normDegree, isRetro, zodiacSign, element };
  });

  if (planets.length === 0) {
    throw new Error(`Free Astrology API responded ${response.status} but returned 0 planets`);
  }

  const counts = { fire: 0, earth: 0, air: 0, water: 0 };
  for (const p of planets) counts[p.element]++;
  const total = planets.length || 1;
  const elementBalance = {
    fire: Math.round((counts.fire / total) * 100),
    earth: Math.round((counts.earth / total) * 100),
    air: Math.round((counts.air / total) * 100),
    water: Math.round((counts.water / total) * 100),
  };

  const sorted = (Object.entries(elementBalance) as [Element, number][])
    .sort((a, b) => b[1] - a[1]);
  const dominantElements = sorted
    .filter(([, pct]) => pct > 0)
    .slice(0, 2)
    .map(([k]) => k);

  return {
    asOfUtc,
    observationPoint: referenceLocation,
    scope: "geocentric",
    planets,
    elementBalance,
    dominantElements,
    provider: "freeastrologyapi.com",
    fetchedAtUtc: new Date().toISOString(),
  };
}
