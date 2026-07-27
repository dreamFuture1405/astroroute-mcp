// NOAA SWPC space weather adapter for AstroRoute v0.4.
// Uses keyless public JSON endpoints from services.swpc.noaa.gov.
// Fetches 3 endpoints in parallel with 8s timeout each and 3600s in-memory cache.
// Fail-soft: if all 3 fail, returns null bundle with fallback reason.
// If 1-2 fail, returns partial bundle with successful sourceRecords only.

const ENDPOINTS = {
  kIndex: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  solar: 'https://services.swpc.noaa.gov/json/solar_probabilities.json',
  sunspot: 'https://services.swpc.noaa.gov/json/sunspot_report.json',
} as const;

const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 3600 * 1000; // 1 hour

export interface SpaceWeatherSourceRecord {
  provider: string;
  endpoint: string;
  timestamp: string;
  value: string | number;
  url: string;
}

export interface SpaceWeatherBundle {
  currentKpIndex: number;
  estimatedKp: number;
  geomagneticActivity: string;
  cClassProbToday: number;
  mClassProbToday: number;
  xClassProbToday: number;
  solarActivity: string;
  sunspotCount: number;
  activeRegions: number;
  spaceWeatherFit: number;
  sourceRecords: SpaceWeatherSourceRecord[];
  fetchedAt: string;
  cacheTtlSeconds: number;
}

interface CacheEntry {
  bundle: SpaceWeatherBundle | null;
  fallback: { reason: string; httpStatuses: number[] } | null;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'AstroRoute/0.4 (+https://astroroute-mcp.qn14051991.workers.dev) noaa-swpc' },
      signal: ctrl.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function deriveGeomagneticActivity(kp: number): string {
  if (kp <= 2) return 'quiet';
  if (kp <= 3) return 'unsettled';
  if (kp <= 4) return 'active';
  if (kp <= 6) return 'minor storm (G1)';
  if (kp <= 7) return 'strong storm (G2)';
  if (kp <= 8) return 'severe storm (G3)';
  return 'extreme storm (G4-G5)';
}

function deriveSolarActivity(c: number, m: number, x: number): string {
  if (x >= 10) return 'high';
  if (m >= 30) return 'elevated';
  if (c >= 70) return 'moderate';
  return 'low';
}

function computeSpaceWeatherFit(
  kp: number,
  cProb: number,
  mProb: number,
  xProb: number,
  sunspotCount: number
): number {
  // Geomagnetic calmness: kp 0-2 = max, kp 3-4 = mid, kp 5+ = low
  const geoScore = kp <= 1 ? 30 : kp <= 2 ? 25 : kp <= 3 ? 18 : kp <= 4 ? 12 : kp <= 6 ? 6 : 0;
  // Solar calmness: low flare probability = good for stargazing
  const solarScore = (100 - cProb) * 0.15 + (100 - mProb) * 0.08 + (100 - xProb) * 0.07;
  // Sunspot bonus: more sunspots = more aurora potential (but only moderate)
  const sunBonus = Math.min(20, sunspotCount * 0.5);
  return Math.max(0, Math.min(100, Math.round(geoScore + solarScore + sunBonus)));
}

function deriveGeomagFieldFromKp(kp: number): number {
  // Map kp string to estimated_kp-like float
  return kp;
}

export async function fetchSpaceWeatherBundle(): Promise<{
  bundle: SpaceWeatherBundle | null;
  fallback: { reason: string; httpStatuses: number[] } | null;
}> {
  // Check cache
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { bundle: cache.bundle, fallback: cache.fallback };
  }

  // Fetch all 3 in parallel
  const [kResult, sResult, ssResult] = await Promise.allSettled([
    fetchWithTimeout(ENDPOINTS.kIndex).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<any[]>;
    }),
    fetchWithTimeout(ENDPOINTS.solar).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<any[]>;
    }),
    fetchWithTimeout(ENDPOINTS.sunspot).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<any[]>;
    }),
  ]);

  const httpStatuses = [
    kResult.status === 'fulfilled' ? 200 : 0,
    sResult.status === 'fulfilled' ? 200 : 0,
    ssResult.status === 'fulfilled' ? 200 : 0,
  ];

  const kpData = kResult.status === 'fulfilled' ? kResult.value : null;
  const solarData = sResult.status === 'fulfilled' ? sResult.value : null;
  const sunspotData = ssResult.status === 'fulfilled' ? ssResult.value : null;

  // All 3 failed → hard fail
  if (!kpData && !solarData && !sunspotData) {
    const fallback = { reason: 'swpc_unavailable', httpStatuses };
    cache = { bundle: null, fallback, fetchedAt: Date.now() };
    return { bundle: null, fallback };
  }

  // Build from available data
  const sourceRecords: SpaceWeatherSourceRecord[] = [];
  const now = new Date().toISOString();

  // Kp index
  let currentKpIndex = 0;
  let estimatedKp = 0;
  let kpTimestamp = now;
  if (kpData && Array.isArray(kpData) && kpData.length > 0) {
    const latest = kpData[kpData.length - 1];
    currentKpIndex = typeof latest.kp_index === 'number' ? latest.kp_index : 0;
    estimatedKp = typeof latest.estimated_kp === 'number' ? latest.estimated_kp : currentKpIndex;
    kpTimestamp = latest.time_tag || now;
    sourceRecords.push({
      provider: 'services.swpc.noaa.gov',
      endpoint: 'planetary_k_index_1m.json',
      timestamp: kpTimestamp,
      value: currentKpIndex,
      url: ENDPOINTS.kIndex,
    });
  }

  // Solar probabilities
  let cProbToday = 0;
  let mProbToday = 0;
  let xProbToday = 0;
  let solarTimestamp = now;
  if (solarData && Array.isArray(solarData) && solarData.length > 0) {
    const latest = solarData[solarData.length - 1];
    cProbToday = typeof latest.c_class_1_day === 'number' ? latest.c_class_1_day : 0;
    mProbToday = typeof latest.m_class_1_day === 'number' ? latest.m_class_1_day : 0;
    xProbToday = typeof latest.x_class_1_day === 'number' ? latest.x_class_1_day : 0;
    solarTimestamp = latest.date || now;
    sourceRecords.push({
      provider: 'services.swpc.noaa.gov',
      endpoint: 'solar_probabilities.json',
      timestamp: solarTimestamp,
      value: { c: cProbToday, m: mProbToday, x: xProbToday },
      url: ENDPOINTS.solar,
    });
  }

  // Sunspot report
  let sunspotCount = 0;
  const regionSet = new Set<number>();
  let ssTimestamp = now;
  if (sunspotData && Array.isArray(sunspotData) && sunspotData.length > 0) {
    // Find latest date entries
    let maxDate = '';
    for (const entry of sunspotData) {
      const dateStr = entry.Obsdate || '';
      if (dateStr > maxDate) maxDate = dateStr;
    }
    const latestEntries = sunspotData.filter((e: any) => (e.Obsdate || '') === maxDate);
    for (const entry of latestEntries) {
      sunspotCount += typeof entry.Numspot === 'number' ? entry.Numspot : 0;
      if (entry.Region && typeof entry.Region === 'number') regionSet.add(entry.Region);
    }
    ssTimestamp = maxDate ? maxDate + 'T00:00:00Z' : now;
    sourceRecords.push({
      provider: 'services.swpc.noaa.gov',
      endpoint: 'sunspot_report.json',
      timestamp: ssTimestamp,
      value: { sunspotCount, activeRegions: regionSet.size },
      url: ENDPOINTS.sunspot,
    });
  }

  const geomagneticActivity = deriveGeomagneticActivity(currentKpIndex);
  const solarActivity = deriveSolarActivity(cProbToday, mProbToday, xProbToday);
  const spaceWeatherFit = computeSpaceWeatherFit(
    currentKpIndex, cProbToday, mProbToday, xProbToday, sunspotCount
  );

  const bundle: SpaceWeatherBundle = {
    currentKpIndex,
    estimatedKp,
    geomagneticActivity,
    cClassProbToday: cProbToday,
    mClassProbToday: mProbToday,
    xClassProbToday: xProbToday,
    solarActivity,
    sunspotCount,
    activeRegions: regionSet.size,
    spaceWeatherFit,
    sourceRecords,
    fetchedAt: now,
    cacheTtlSeconds: CACHE_TTL_MS / 1000,
  };

  cache = { bundle, fallback: null, fetchedAt: Date.now() };
  return { bundle, fallback: null };
}
