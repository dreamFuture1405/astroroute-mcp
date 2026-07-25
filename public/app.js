// AstroRoute frontend.
// Communicates with the same-origin /api/compare endpoint only.
// No API keys, no third-party network calls, no model provider calls from the browser.

const PRESETS = [
  { name: "Hanoi", latitude: 21.0285, longitude: 105.8542, timezone: "Asia/Ho_Chi_Minh" },
  { name: "Tokyo", latitude: 35.6762, longitude: 139.6503, timezone: "Asia/Tokyo" },
  { name: "Singapore", latitude: 1.3521, longitude: 103.8198, timezone: "Asia/Singapore" },
];

const EMPTY_CITY = { name: "", latitude: 0, longitude: 0, timezone: "UTC" };

let candidateCount = 2;

function moodLabel(score) {
  if (score <= 2) return "very low";
  if (score <= 4) return "low";
  if (score <= 6) return "neutral";
  if (score <= 8) return "elevated";
  return "high";
}

function renderCandidates() {
  const container = document.getElementById("candidates-container");
  container.innerHTML = "";
  for (let i = 0; i < candidateCount; i++) {
    const preset = PRESETS[i] || EMPTY_CITY;
    const div = document.createElement("div");
    div.className = "candidate";
    div.innerHTML = `
      <h3>City ${i + 1}</h3>
      <label>Name
        <input type="text" data-field="name" value="${preset.name.replace(/"/g, "&quot;")}" required maxlength="80">
      </label>
      <label>Latitude (-90 to 90)
        <input type="number" data-field="latitude" value="${preset.latitude}" min="-90" max="90" step="any" required>
      </label>
      <label>Longitude (-180 to 180)
        <input type="number" data-field="longitude" value="${preset.longitude}" min="-180" max="180" step="any" required>
      </label>
      <label>Timezone (IANA, e.g. Asia/Ho_Chi_Minh)
        <input type="text" data-field="timezone" value="${preset.timezone.replace(/"/g, "&quot;")}" required>
      </label>
    `;
    container.appendChild(div);
  }
}

document.getElementById("add-city").addEventListener("click", () => {
  if (candidateCount < 3) {
    candidateCount++;
    renderCandidates();
  }
});

const moodSlider = document.getElementById("moodScore");
const moodOutput = document.getElementById("moodScoreOutput");
function syncMoodLabel() {
  const v = parseInt(moodSlider.value, 10);
  moodOutput.textContent = `${v} (${moodLabel(v)})`;
}
moodSlider.addEventListener("input", syncMoodLabel);
syncMoodLabel();

renderCandidates();

document.getElementById("compare-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resultDiv = document.getElementById("result-content");
  const resultsSection = document.getElementById("results");
  const submitBtn = document.getElementById("submit-btn");
  submitBtn.disabled = true;
  resultDiv.innerHTML = "<p>Loading comparison...</p>";
  resultsSection.hidden = false;

  const candidates = [];
  document.querySelectorAll(".candidate").forEach((div) => {
    candidates.push({
      name: div.querySelector('[data-field="name"]').value.trim(),
      latitude: parseFloat(div.querySelector('[data-field="latitude"]').value),
      longitude: parseFloat(div.querySelector('[data-field="longitude"]').value),
      timezone: div.querySelector('[data-field="timezone"]').value.trim(),
    });
  });

  const body = {
    moodScore: parseInt(moodSlider.value, 10),
    candidates,
  };

  try {
    const response = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const message = data && data.error ? data.error.message : `HTTP ${response.status}`;
      resultDiv.innerHTML = `<p class="error">Error: ${escapeHtml(message)}</p>`;
      submitBtn.disabled = false;
      return;
    }
    renderResult(data);
  } catch (err) {
    resultDiv.innerHTML = `<p class="error">Network error: ${escapeHtml(err.message)}</p>`;
  }
  submitBtn.disabled = false;
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderResult(data) {
  const resultDiv = document.getElementById("result-content");
  let html = `
    <div class="summary">
      <p><strong>Mood:</strong> ${data.moodInterpretation.score} (${data.moodInterpretation.label})</p>
      <p><strong>Sky:</strong> ${escapeHtml(data.skyProfile.keyPlanet)}, dominant elements: ${data.skyProfile.dominantElements.map(escapeHtml).join(", ")}</p>
    </div>
    <h3>Ranked Locations</h3>
    <ol class="ranked-list">
  `;
  for (const loc of data.rankedLocations) {
    html += `
      <li class="ranked-item">
        <h4>Rank ${loc.rank}: ${escapeHtml(loc.location.name)}</h4>
        <div class="score-bar">
          <div class="score-fill" style="width: ${loc.astroWeatherFitScore}%"></div>
          <span class="score-label">${loc.astroWeatherFitScore}/100</span>
        </div>
        <p>Mood-weather mismatch: <strong>${loc.moodWeatherMismatch}/100</strong> (lower is closer to your activation)</p>
        <p>Element alignment: <strong>${loc.elementWeatherAlignment.score}/100</strong></p>
        <p>${escapeHtml(loc.dayNightTimingNote)}</p>
        <p><strong>Best window:</strong> ${escapeHtml(loc.bestReflectionWindow.startLocal)} to ${escapeHtml(loc.bestReflectionWindow.endLocal)} (quality ${loc.bestReflectionWindow.quality}/100)</p>
        <p>${escapeHtml(loc.bestReflectionWindow.reason)}</p>
      </li>
    `;
  }
  html += `</ol>`;

  if (data.rankedLocations[0]) {
    html += `
      <div class="why-first">
        <h3>Why ${escapeHtml(data.rankedLocations[0].location.name)}?</h3>
        <p>${escapeHtml(data.whyFirstPlace)}</p>
      </div>
    `;
  }

  html += `<p class="freshness">${escapeHtml(data.dataFreshness)}</p>`;
  html += `<p class="disclaimer">${escapeHtml(data.disclaimer)}</p>`;

  resultDiv.innerHTML = html;
}