// AstroRoute frontend.
// Communicates with the same-origin /api/compare endpoint only.
// No API keys, no third-party network calls, no model provider calls from the browser.
// v0.4: adds includeSpaceWeather checkbox support and renders score-v4 data.

const PRESETS = [
  { name: "Hanoi", latitude: 21.0285, longitude: 105.8542, timezone: "Asia/Ho_Chi_Minh" },
  { name: "Tokyo", latitude: 35.6762, longitude: 139.6503, timezone: "Asia/Tokyo" },
  { name: "Singapore", latitude: 1.3521, longitude: 103.8198, timezone: "Asia/Singapore" },
];

const EMPTY_CITY = { name: "", latitude: 0, longitude: 0, timezone: "UTC" };
const DISCLAIMER = "Reflective practice only. Not medical, financial, legal, or predictive advice.";
const MOOD_AXES = [
  { key: "energy", inputId: "moodEnergy", outputId: "moodEnergyOutput" },
  { key: "stress", inputId: "moodStress", outputId: "moodStressOutput" },
  { key: "focus", inputId: "moodFocus", outputId: "moodFocusOutput" },
  { key: "socialBattery", inputId: "moodSocialBattery", outputId: "moodSocialBatteryOutput" },
];

let candidateCount = 2;

function moodLabel(score) {
  if (score <= 2) return "very low";
  if (score <= 4) return "low";
  if (score <= 6) return "neutral";
  if (score <= 8) return "elevated";
  return "high";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function renderCandidates() {
  const container = document.getElementById("candidates-container");
  container.innerHTML = "";
  for (let i = 0; i < candidateCount; i += 1) {
    const preset = PRESETS[i] || EMPTY_CITY;
    const div = document.createElement("div");
    div.className = "candidate";
    div.innerHTML = `
      <h3>City ${i + 1}</h3>
      <label>Name
        <input type="text" data-field="name" value="${escapeHtml(preset.name)}" required maxlength="80">
      </label>
      <label>Latitude (-90 to 90)
        <input type="number" data-field="latitude" value="${preset.latitude}" min="-90" max="90" step="any" required>
      </label>
      <label>Longitude (-180 to 180)
        <input type="number" data-field="longitude" value="${preset.longitude}" min="-180" max="180" step="any" required>
      </label>
      <label>Timezone (IANA, e.g. Asia/Ho_Chi_Minh)
        <input type="text" data-field="timezone" value="${escapeHtml(preset.timezone)}" required>
      </label>
    `;
    container.appendChild(div);
  }
}

document.getElementById("add-city").addEventListener("click", () => {
  if (candidateCount < 3) {
    candidateCount += 1;
    renderCandidates();
  }
});

const moodControls = MOOD_AXES.map((axis) => ({
  axis,
  slider: document.getElementById(axis.inputId),
  output: document.getElementById(axis.outputId),
}));

function syncMoodLabels() {
  for (const control of moodControls) {
    if (!control.slider || !control.output) continue;
    const value = parseInt(control.slider.value, 10);
    control.output.textContent = `${value} (${moodLabel(value)})`;
  }
}

for (const control of moodControls) {
  if (control.slider) control.slider.addEventListener("input", syncMoodLabels);
}

syncMoodLabels();
renderCandidates();

document.getElementById("compare-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const resultDiv = document.getElementById("result-content");
  const resultsSection = document.getElementById("results");
  const submitButton = document.getElementById("submit-btn");
  const placeSection = document.getElementById("place-context-section");
  const placeContent = document.getElementById("place-context-content");
  const swSection = document.getElementById("space-weather-section");
  const swContent = document.getElementById("space-weather-content");

  submitButton.disabled = true;
  resultsSection.hidden = false;
  resultDiv.innerHTML = "<p>Loading comparison...</p>";
  if (placeSection) placeSection.hidden = true;
  if (placeContent) placeContent.innerHTML = "";
  if (swSection) swSection.hidden = true;
  if (swContent) swContent.innerHTML = "";

  const candidates = Array.from(document.querySelectorAll(".candidate")).map((div) => ({
    name: div.querySelector('[data-field="name"]').value.trim(),
    latitude: parseFloat(div.querySelector('[data-field="latitude"]').value),
    longitude: parseFloat(div.querySelector('[data-field="longitude"]').value),
    timezone: div.querySelector('[data-field="timezone"]').value.trim(),
  }));

  const moodProfile = {};
  for (const control of moodControls) {
    moodProfile[control.axis.key] = parseInt(control.slider.value, 10);
  }
  const contextCheckbox = document.getElementById("includePlaceContext");
  const swCheckbox = document.getElementById("includeSpaceWeather");

  const requestBody = {
    moodScore: moodProfile.energy,
    candidates,
    moodProfile,
    includePlaceContext: contextCheckbox ? contextCheckbox.checked : false,
    includeSpaceWeather: swCheckbox ? swCheckbox.checked : false,
  };

  try {
    const response = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const message = data && data.error ? data.error.message : `HTTP ${response.status}`;
      resultDiv.innerHTML = `<p class="error">Error: ${escapeHtml(message)}</p>`;
    } else {
      renderResult(data);
      renderPlaceContext(data);
      renderSpaceWeather(data);
    }
  } catch (error) {
    resultDiv.innerHTML = `<p class="error">Network error: ${escapeHtml(error.message)}</p>`;
  } finally {
    submitButton.disabled = false;
  }
});

function renderResult(data) {
  const resultDiv = document.getElementById("result-content");
  const methodVersion = data.methodVersion || "score-v1";
  const mood = data.moodInterpretation || {};
  const sky = data.skyProfile || {};
  const elements = Array.isArray(sky.dominantElements) ? sky.dominantElements : [];
  const rankedLocations = Array.isArray(data.rankedLocations) ? data.rankedLocations : [];

  let html = `
    <div class="summary">
      <p><strong>Method:</strong> ${escapeHtml(methodVersion)}</p>
      <p><strong>Mood:</strong> ${escapeHtml(mood.score ?? "")} (${escapeHtml(mood.label ?? "")})</p>
      <p><strong>Sky:</strong> ${escapeHtml(sky.keyPlanet ?? "")}, dominant elements: ${elements.map(escapeHtml).join(", ")}</p>
  `;

  if (data.derivedMoodProfile && typeof data.derivedMoodProfile === "object") {
    const profile = data.derivedMoodProfile;
    html += `
      <div class="derived-mood">
        <strong>Derived mood profile:</strong>
        energy ${escapeHtml(profile.energy ?? "")},
        stress ${escapeHtml(profile.stress ?? "")},
        focus ${escapeHtml(profile.focus ?? "")},
        social battery ${escapeHtml(profile.socialBattery ?? "")}
      </div>
    `;
  }

  if (data.scoreV3Weights && typeof data.scoreV3Weights === "object" && methodVersion !== "score-v4") {
    const weights = data.scoreV3Weights;
    html += `
      <div class="v3-weights">
        <strong>Score-v3 weights:</strong>
        base ${escapeHtml(weights.base ?? "")},
        mood ${escapeHtml(weights.mood ?? "")},
        place ${escapeHtml(weights.place ?? "")}
      </div>
    `;
  }

  if (data.scoreV4Weights && typeof data.scoreV4Weights === "object") {
    const w = data.scoreV4Weights;
    html += `
      <div class="v4-weights">
        <strong>Score-v4 weights:</strong>
        base ${escapeHtml(w.base ?? "")},
        mood ${escapeHtml(w.mood ?? "")},
        place ${escapeHtml(w.place ?? "")},
        spaceWeather ${escapeHtml(w.spaceWeather ?? "")}
      </div>
    `;
  }

  html += "</div><h3>Ranked Locations</h3><ol class=\"ranked-list\">";

  for (const location of rankedLocations) {
    const baseScore = Number.isFinite(location.astroWeatherFitScore) ? location.astroWeatherFitScore : 0;
    const richScore = location.v3 && Number.isFinite(location.v3.finalScoreV3)
      ? location.v3.finalScoreV3
      : null;
    const displayScore = richScore === null ? baseScore : richScore;
    const window = location.bestReflectionWindow || {};
    const alignment = location.elementWeatherAlignment || {};

    html += `
      <li class="ranked-item">
        <h4>Rank ${escapeHtml(location.rank)}: ${escapeHtml(location.location.name)}</h4>
        <div class="score-bar">
          <div class="score-fill" style="width: ${clampScore(displayScore)}%"></div>
          <span class="score-label">${escapeHtml(displayScore)}/100</span>
        </div>
        ${richScore === null ? "" : `<p><strong>Base score:</strong> ${escapeHtml(baseScore)}/100</p><p><strong>Final score:</strong> ${escapeHtml(richScore)}/100</p>`}
        ${location.v4 && location.v4.spaceWeatherFit !== null ? `<p><strong>Space weather fit (global):</strong> ${escapeHtml(location.v4.spaceWeatherFit)}/100</p>` : ""}
        <p>Mood-weather mismatch: <strong>${escapeHtml(location.moodWeatherMismatch)}/100</strong> (lower is closer to your activation)</p>
        <p>Element alignment: <strong>${escapeHtml(alignment.score ?? "")}/100</strong></p>
        <p>${escapeHtml(location.dayNightTimingNote ?? "")}</p>
        <p><strong>Best window:</strong> ${escapeHtml(window.startLocal ?? "")} to ${escapeHtml(window.endLocal ?? "")} (quality ${escapeHtml(window.quality ?? "")}/100)</p>
        <p>${escapeHtml(window.reason ?? "")}</p>
      </li>
    `;
  }

  html += "</ol>";
  if (rankedLocations[0]) {
    html += `
      <div class="why-first">
        <h3>Why ${escapeHtml(rankedLocations[0].location.name)}?</h3>
        <p>${escapeHtml(data.whyFirstPlace ?? "")}</p>
      </div>
    `;
  }
  html += `<p class="freshness">${escapeHtml(data.dataFreshness ?? "")}</p>`;
  html += `<p class="disclaimer">${escapeHtml(data.disclaimer || DISCLAIMER)}</p>`;
  resultDiv.innerHTML = html;
}

function renderPlaceContext(data) {
  const section = document.getElementById("place-context-section");
  const content = document.getElementById("place-context-content");
  if (!section || !content) return;

  const ranked = Array.isArray(data.rankedLocations) ? data.rankedLocations : [];
  const list = Array.isArray(data.placeContextList) ? data.placeContextList : [];
  const items = ranked
    .map((entry, index) => ({
      cityName: entry.location && entry.location.name ? entry.location.name : `Candidate ${index + 1}`,
      context: entry.v3 && entry.v3.placeContext ? entry.v3.placeContext : list[index],
    }))
    .filter((item) => item.context && typeof item.context === "object");

  if (items.length === 0) {
    section.hidden = true;
    content.innerHTML = "";
    return;
  }

  let html = "";
  for (const item of items) {
    const context = item.context;
    const title = context.resolvedTitle || item.cityName;
    const description = context.description || context.extractSnippet || "";
    const coordinates = context.coordinates;

    html += `<div class="place-context-item"><h4>${escapeHtml(title)}</h4>`;
    if (title !== item.cityName) {
      html += `<p class="place-context-city">For ${escapeHtml(item.cityName)}</p>`;
    }
    if (description) html += `<p>${escapeHtml(description)}</p>`;

    if (Array.isArray(context.tags) && context.tags.length > 0) {
      html += '<ul class="place-tags">';
      for (const tag of context.tags) {
        const evidence = Array.isArray(tag.evidence) ? tag.evidence.join(", ") : "";
        const detail = evidence ? ` (evidence: ${evidence})` : "";
        const confidence = tag.confidence ? ` [${tag.confidence}]` : "";
        html += `<li>${escapeHtml(`${tag.tag || ""}${confidence}${detail}`)}</li>`;
      }
      html += "</ul>";
    }

    if (coordinates && Number.isFinite(coordinates.latitude) && Number.isFinite(coordinates.longitude)) {
      html += `<p class="place-coords">Coordinates: ${escapeHtml(coordinates.latitude)}, ${escapeHtml(coordinates.longitude)}</p>`;
    }
    if (context.confidenceTier) {
      html += `<p><strong>Confidence tier:</strong> ${escapeHtml(context.confidenceTier)}</p>`;
    }
    if (context.fallback && context.fallback.used) {
      html += `<p class="fallback-note"><strong>Fallback:</strong> ${escapeHtml(context.fallback.reason || "unavailable")}</p>`;
    }
    if (context.provider) html += `<p class="place-provider"><strong>Provider:</strong> ${escapeHtml(context.provider)}</p>`;
    if (context.fetchedAtUtc) html += `<p class="place-fetched"><strong>Fetched:</strong> ${escapeHtml(context.fetchedAtUtc)}</p>`;
    html += "</div>";
  }

  content.innerHTML = html;
  section.hidden = false;
}

function renderSpaceWeather(data) {
  const section = document.getElementById("space-weather-section");
  const content = document.getElementById("space-weather-content");
  if (!section || !content) return;

  const bundle = data.spaceWeatherBundle;
  const fallback = data.spaceWeatherFallback;

  if (!bundle && !fallback) {
    section.hidden = true;
    content.innerHTML = "";
    return;
  }

  let html = "";

  if (bundle) {
    html += `<div class="sw-bundle">`;
    html += `<h4>NOAA SWPC Space Weather</h4>`;
    html += `<p><strong>Kp Index:</strong> ${escapeHtml(bundle.currentKpIndex)} (estimated: ${escapeHtml(bundle.estimatedKp)})</p>`;
    html += `<p><strong>Geomagnetic activity:</strong> ${escapeHtml(bundle.geomagneticActivity)}</p>`;
    html += `<p><strong>Solar activity:</strong> ${escapeHtml(bundle.solarActivity)}</p>`;
    html += `<p><strong>Flare probabilities:</strong> C ${escapeHtml(bundle.cClassProbToday)}%, M ${escapeHtml(bundle.mClassProbToday)}%, X ${escapeHtml(bundle.xClassProbToday)}%</p>`;
    html += `<p><strong>Sunspot count:</strong> ${escapeHtml(bundle.sunspotCount)} (${escapeHtml(bundle.activeRegions)} active regions)</p>`;
    html += `<p><strong>Space weather fit:</strong> ${escapeHtml(bundle.spaceWeatherFit)}/100</p>`;
    if (Array.isArray(bundle.sourceRecords) && bundle.sourceRecords.length > 0) {
      html += `<p class="sw-sources"><strong>Source records:</strong> ${bundle.sourceRecords.map((r) => escapeHtml(r.endpoint)).join(", ")}</p>`;
    }
    html += `<p class="sw-fetched"><strong>Fetched:</strong> ${escapeHtml(bundle.fetchedAt)}</p>`;
    html += `</div>`;
  }

  if (fallback) {
    html += `<div class="sw-fallback">`;
    html += `<p class="fallback-note"><strong>Space weather fallback:</strong> ${escapeHtml(fallback.reason || "unknown")}</p>`;
    if (Array.isArray(fallback.httpStatuses)) {
      html += `<p>HTTP statuses: ${fallback.httpStatuses.map(escapeHtml).join(", ")}</p>`;
    }
    html += `</div>`;
  }

  content.innerHTML = html;
  section.hidden = false;
}
