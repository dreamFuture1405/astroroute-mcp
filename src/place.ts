// Wikimedia place-context adapter for AstroRoute v0.3.
// Uses keyless public APIs:
//   - MediaWiki OpenSearch for page title resolution (returns flat array: [query, titles[], descriptions[], urls[]])
//   - Wikimedia REST Page Summary for description, extract, coordinates (returns object with title/description/extract/coordinates)
// Strictly bounded:
//   - descriptive User-Agent
//   - 3 second timeout per upstream request
//   - sanitized error reasons, no raw upstream body leakage
//   - never sends user secrets
//   - tag inference uses a closed 8-tag keyword taxonomy

const TIMEOUT_MS = 3000;
const USER_AGENT =
  "AstroRoute/0.3 (+https://astroroute-mcp.qn14051991.workers.dev) keyless-research";
const OPENSEARCH =
  "https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json";
const SUMMARY_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary/";

export type PlaceTagName =
  | "coastal"
  | "urban_dense"
  | "historic"
  | "green_space"
  | "creative"
  | "quiet"
  | "nightlife"
  | "transit_hub";

export interface PlaceTag {
  tag: PlaceTagName;
  evidence: string[];
  confidence: "high" | "medium" | "low";
}

export interface PlaceContext {
  provider: "wikimedia.org";
  resolvedTitle: string | null;
  description: string | null;
  extractSnippet: string | null;
  coordinates: { latitude: number; longitude: number } | null;
  tags: PlaceTag[];
  evidenceTerms: string[];
  confidenceTier: "high" | "medium" | "low" | "unavailable";
  fallback: { used: boolean; reason: string | null };
  disclaimers: string[];
  fetchedAtUtc: string;
}

export interface FetchPlaceContextInput {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface PlaceMoodCompatibility {
  energy?: number;
  stress?: number;
  focus?: number;
  socialBattery?: number;
}

const TAG_KEYWORDS: Record<PlaceTagName, string[]> = {
  coastal: ["bay", "beach", "coast", "coastal", "harbor", "harbour", "ocean", "port", "river", "sea", "shore", "strait", "waterfront"],
  urban_dense: ["capital", "city", "conurbation", "dense", "metropolitan", "municipality", "population", "skyscraper", "urban"],
  historic: ["ancient", "castle", "cathedral", "century", "dynasty", "fortress", "heritage", "historic", "medieval", "old town", "shrine", "temple", "unesco", "walled"],
  green_space: ["botanical", "forest", "garden", "mountain", "national park", "park", "resort", "tropical", "valley", "volcano"],
  creative: ["art", "arts", "creative", "design", "fashion", "film", "gallery", "literary", "media", "museum", "music", "theater", "theatre"],
  quiet: ["peaceful", "quiet", "retreat", "serene", "tranquil"],
  nightlife: ["bars", "club", "clubs", "entertainment", "karaoke", "nightlife", "night market"],
  transit_hub: ["airport", "hub", "rail", "railway", "station", "subway", "terminal", "train", "transit"],
};

// Mood-axis compatibility per tag (heuristic, documented in README and Agents Guide).
// Used by score-v3 to compute a bounded placeFit from moodProfile + tag set.
export const PLACE_MOOD_COMPATIBILITY: Record<PlaceTagName, PlaceMoodCompatibility> = {
  coastal: { stress: -1, focus: 1 },
  urban_dense: { energy: 2, socialBattery: 2, focus: 1 },
  historic: { focus: 2 },
  green_space: { stress: -2, focus: 1, energy: 1 },
  creative: { focus: 1, socialBattery: 1 },
  quiet: { stress: -2, focus: 2 },
  nightlife: { energy: 2, socialBattery: 2 },
  transit_hub: { focus: 1 },
};

async function fetchJson(
  url: string
): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      return { ok: false, reason: "non-JSON response" };
    }
    return { ok: true, data };
  } catch (e: any) {
    const reason =
      e?.name === "AbortError" ? "timeout" : e?.message ?? "fetch failed";
    return { ok: false, reason };
  } finally {
    clearTimeout(t);
  }
}

function clampString(
  s: string | null | undefined,
  max: number
): string | null {
  if (s === null || s === undefined) return null;
  const trimmed = String(s).replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max - 1) + "\u2026";
}

// MediaWiki OpenSearch returns a flat array: [query, titles[], descriptions[], urls[]].
// Index 1 contains resolved page titles, index 3 contains wikipedia urls.
type OpenSearchPayload = [unknown, string[], unknown[], unknown[]];

interface PageSummaryPayload {
  title?: string;
  description?: string;
  extract?: string;
  coordinates?: { lat?: number; lon?: number };
}

function deriveTags(
  title: string | null,
  description: string | null,
  extract: string | null
): { tags: PlaceTag[]; evidenceTerms: string[] } {
  const combined = [title ?? "", description ?? "", extract ?? ""]
    .join(" ")
    .toLowerCase();
  const tags: PlaceTag[] = [];
  const evidenceSet = new Set<string>();
  for (const tagName of Object.keys(TAG_KEYWORDS) as PlaceTagName[]) {
    const matches: string[] = [];
    for (const kw of TAG_KEYWORDS[tagName]) {
      if (combined.includes(kw)) {
        matches.push(kw);
        evidenceSet.add(kw);
      }
    }
    if (matches.length === 0) continue;
    const confidence: PlaceTag["confidence"] =
      matches.length >= 3 ? "high" : matches.length >= 2 ? "medium" : "low";
    tags.push({
      tag: tagName,
      evidence: matches.slice(0, 5),
      confidence,
    });
  }
  return { tags, evidenceTerms: Array.from(evidenceSet).sort().slice(0, 20) };
}

function tierFromTags(tags: PlaceTag[]): PlaceContext["confidenceTier"] {
  if (tags.length === 0) return "unavailable";
  if (tags.some((t) => t.confidence === "high")) return "high";
  if (tags.some((t) => t.confidence === "medium")) return "medium";
  return "low";
}

function unavailable(
  reason: string,
  resolvedTitle: string | null,
  fetchedAtUtc: string
): PlaceContext {
  return {
    provider: "wikimedia.org",
    resolvedTitle,
    description: null,
    extractSnippet: null,
    coordinates: null,
    tags: [],
    evidenceTerms: [],
    confidenceTier: "unavailable",
    fallback: { used: true, reason },
    disclaimers: [
      "Place context is a heuristic, not a factual classification of a city.",
    ],
    fetchedAtUtc,
  };
}

export async function fetchPlaceContext(
  input: FetchPlaceContextInput
): Promise<PlaceContext> {
  const fetchedAtUtc = new Date().toISOString();
  const name = (input.name ?? "").trim();
  if (!name) return unavailable("empty place name", null, fetchedAtUtc);

  const opensearchUrl = `${OPENSEARCH}&search=${encodeURIComponent(name)}`;
  const resolved = await fetchJson(opensearchUrl);
  if (!resolved.ok) return unavailable(`resolve failed (${resolved.reason})`, null, fetchedAtUtc);

  const os = resolved.data as OpenSearchPayload;
  const title = Array.isArray(os) && Array.isArray(os[1]) ? os[1][0] : undefined;
  if (!title) return unavailable("no open search result", null, fetchedAtUtc);

  const summaryUrl = `${SUMMARY_BASE}${encodeURIComponent(title)}`;
  const sum = await fetchJson(summaryUrl);
  if (!sum.ok) return unavailable(`summary failed (${sum.reason})`, title, fetchedAtUtc);

  const s = sum.data as PageSummaryPayload;
  const resolvedTitle = clampString(s.title ?? title, 200);
  const description = clampString(s.description ?? null, 300);
  const extractSnippet = clampString(s.extract ?? null, 600);
  const coords =
    s.coordinates &&
    typeof s.coordinates.lat === "number" &&
    typeof s.coordinates.lon === "number"
      ? { latitude: s.coordinates.lat, longitude: s.coordinates.lon }
      : null;
  const { tags, evidenceTerms } = deriveTags(
    resolvedTitle,
    description,
    extractSnippet
  );

  return {
    provider: "wikimedia.org",
    resolvedTitle,
    description,
    extractSnippet,
    coordinates: coords,
    tags,
    evidenceTerms,
    confidenceTier: tierFromTags(tags),
    fallback: { used: false, reason: null },
    disclaimers: [
      "Place tags are derived from a Wikimedia summary snippet. They are a heuristic, not a factual or scientific classification of a city.",
      "Tags should be read as evidence-backed context, not as truth about the place.",
    ],
    fetchedAtUtc,
  };
}
