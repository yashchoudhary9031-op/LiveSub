// content.js - LiveSub YouTube Subtitle Overlay & Multi-Mode Sync Engine

let state = {
  enabled: false,
  targetLang: "hi",
  langHint: "",
  subMode: "auto",
  fontSize: "22px",
};

let videoElement = null;
let overlayContainer = null;
let captionBox = null;
let currentCueTimeout = null;
let lastTranslatedText = "";
let subtitleHistory = [];

let captionPollInterval = null;
const translationCache = new Map();
let requestId = 0;
let lastCaptionTime = 0;

// ----------------------------------------------------------------------------
// 1. Overlay Lifecycle & Injection
// ----------------------------------------------------------------------------
function initOverlay() {
  const existing = document.getElementById("livesub-container");
  const player = document.querySelector("#movie_player") || document.querySelector(".html5-video-player");

  if (existing) {
    overlayContainer = existing;
    captionBox = overlayContainer.querySelector(".livesub-caption-box");

    // Move into movie_player if it was on body, so fullscreen shows it
    if (player && overlayContainer.parentElement !== player) {
      player.appendChild(overlayContainer);
    }
    return;
  }

  const mountTarget = player || document.body;
  if (!mountTarget) return;

  overlayContainer = document.createElement("div");
  overlayContainer.id = "livesub-container";
  overlayContainer.className = "hidden";

  captionBox = document.createElement("div");
  captionBox.className = "livesub-caption-box";
  captionBox.style.fontSize = state.fontSize || "22px";

  overlayContainer.appendChild(captionBox);
  mountTarget.appendChild(overlayContainer);
  console.log("[LiveSub] Overlay mounted into", mountTarget.tagName);
}

function showSubtitle(translation, original = null) {
  if (!captionBox || !overlayContainer) {
    initOverlay();
  }
  if (!captionBox || !overlayContainer) return;

  let html = `<div class="livesub-translation">${escapeHtml(translation)}</div>`;
  if (original && original !== translation && original !== "[stub transcript]") {
    html += `<div class="livesub-original">${escapeHtml(original)}</div>`;
  }

  captionBox.innerHTML = html;
  captionBox.style.fontSize = state.fontSize || "22px";
  overlayContainer.classList.remove("hidden");
}

function hideSubtitle() {
  if (overlayContainer) {
    overlayContainer.classList.add("hidden");
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.innerText = text;
  return div.innerHTML;
}

function recordSubtitle(translation, original, start, end) {
  if (!translation) return;
  const cueStart = Number.isFinite(Number(start)) ? Number(start) : (videoElement?.currentTime || 0);
  const cueEnd = Number.isFinite(Number(end)) && Number(end) > cueStart ? Number(end) : cueStart + 2.5;
  const cue = { start: cueStart, end: cueEnd, original: original || "", translation };
  const prev = subtitleHistory[subtitleHistory.length - 1];
  if (prev && prev.start === cue.start && prev.translation === cue.translation) return;
  subtitleHistory.push(cue);
}

// ----------------------------------------------------------------------------
// 2. Video Player Binding
// ----------------------------------------------------------------------------
function bindVideo() {
  videoElement = document.querySelector("video");
  if (!videoElement) return;

  videoElement.removeEventListener("play", onPlay);
  videoElement.removeEventListener("pause", onPause);
  videoElement.removeEventListener("seeking", onSeeking);

  videoElement.addEventListener("play", onPlay);
  videoElement.addEventListener("pause", onPause);
  videoElement.addEventListener("seeking", onSeeking);
}

function onPlay() {
  if (state.enabled) {
    startSubtitles();
  }
}

function onPause() {
  // Keep last subtitle on screen during pause for readability
}

function onSeeking() {
  hideSubtitle();
}

// ----------------------------------------------------------------------------
// 3. YouTube Caption Translation Engine
// ----------------------------------------------------------------------------
async function translateDirect(text, targetLang) {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const parts = (data[0] || []).map((s) => (s && s[0]) || "").join("");
    if (parts) {
      if (translationCache.size > 800) translationCache.delete(translationCache.keys().next().value);
      translationCache.set(cacheKey, parts);
      return parts;
    }
  } catch (e) {}
  return text;
}

function startCaptionObserver() {
  if (captionPollInterval) clearInterval(captionPollInterval);

  captionPollInterval = setInterval(async () => {
    if (!state.enabled) return;
    if (state.subMode !== "caption_translate" && state.subMode !== "auto") return;

    const captionEl =
      document.querySelector(".ytp-caption-segment") ||
      document.querySelector(".ytp-caption-window-container .caption-visual-line") ||
      document.querySelector(".caption-window span");

    if (!captionEl) return;

    // Use textContent so opacity: 0 does not block text extraction
    const rawText = (captionEl.textContent || captionEl.innerText || "").trim();
    if (!rawText || rawText === lastTranslatedText) return;

    lastTranslatedText = rawText;
    lastCaptionTime = Date.now();
    const myRequestId = ++requestId;

    const cacheKey = `${state.targetLang}:${rawText}`;

    // Instant cache hit
    if (translationCache.has(cacheKey)) {
      if (myRequestId === requestId) {
        const cached = translationCache.get(cacheKey);
        showSubtitle(cached, rawText);
        recordSubtitle(cached, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
      }
      return;
    }

    // Immediately show original while translation loads
    showSubtitle(rawText, "");

    try {
      const translation = await translateDirect(rawText, state.targetLang);
      if (myRequestId === requestId) {
        showSubtitle(translation, rawText);
        recordSubtitle(translation, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
      }
    } catch (e) {}
  }, 100);
}

function stopCaptionObserver() {
  if (captionPollInterval) {
    clearInterval(captionPollInterval);
    captionPollInterval = null;
  }
  requestId = 0;
  lastTranslatedText = "";
}

// ----------------------------------------------------------------------------
// 4. Master Lifecycle (Start / Stop)
// ----------------------------------------------------------------------------
function startSubtitles() {
  initOverlay();
  bindVideo();

  if (!state.enabled) {
    stopSubtitles();
    return;
  }

  console.log("[LiveSub] Starting subtitles in mode:", state.subMode);

  document.body.classList.add("livesub-active");

  // Show a brief badge so user sees LiveSub is ON
  showSubtitle("LiveSub Active 🟢", "");
  setTimeout(() => {
    if (lastTranslatedText === "") hideSubtitle();
  }, 1200);

  if (state.subMode === "caption_translate") {
    // CC only
    chrome.runtime.sendMessage({ action: "STOP_AUDIO_SESSION" }).catch(() => {});
    startCaptionObserver();
  } else if (state.subMode === "audio_stt") {
    // STT only
    stopCaptionObserver();
    chrome.runtime.sendMessage({ action: "START_AUDIO_SESSION", settings: state }).catch(() => {});
  } else {
    // Auto / Hybrid: observe CC AND start live audio STT
    startCaptionObserver();
    chrome.runtime.sendMessage({ action: "START_AUDIO_SESSION", settings: state }).catch(() => {});
  }
}

function stopSubtitles() {
  document.body.classList.remove("livesub-active");
  stopCaptionObserver();
  chrome.runtime.sendMessage({ action: "STOP_AUDIO_SESSION" }).catch(() => {});
  hideSubtitle();
}

// ----------------------------------------------------------------------------
// 5. Settings & Cue Listener
// ----------------------------------------------------------------------------
chrome.storage.local.get(
  { enabled: false, targetLang: "hi", langHint: "", subMode: "auto", fontSize: "22px" },
  (saved) => {
    state = saved;
    initOverlay();
    bindVideo();
    if (state.enabled) {
      startSubtitles();
    }
  }
);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. Export Subtitles
  if (request.action === "EXPORT_SUBTITLES") {
    sendResponse({
      subtitles: subtitleHistory,
      title: document.title.replace(/\s*-\s*YouTube$/, "").trim() || "LiveSub subtitles",
    });
    return true;
  }

  // 2. Subtitle Cue from Audio STT (offscreen.js)
  if (request.action === "SHOW_CUE" && request.cue) {
    const cue = request.cue;
    // In auto mode, if YouTube CC was active in the last 2 seconds, ignore STT to avoid collisions
    if (state.subMode === "auto" && Date.now() - lastCaptionTime < 2000) {
      sendResponse({ status: "skipped_for_cc" });
      return true;
    }

    if (cue.translation && cue.translation.trim() && cue.translation !== "[stub transcript]") {
      showSubtitle(cue.translation, cue.text);
      recordSubtitle(cue.translation, cue.text, cue.start, cue.end);

      if (currentCueTimeout) clearTimeout(currentCueTimeout);
      // Keep visible for 2.8s so sequential audio chunks overlap smoothly
      currentCueTimeout = setTimeout(hideSubtitle, 2800);
    }
    sendResponse({ status: "ok" });
    return true;
  }

  // 3. Settings changed from popup
  if (request.action === "SETTINGS_CHANGED") {
    const prevLang = state.targetLang;
    state = request.settings;
    if (captionBox) captionBox.style.fontSize = state.fontSize || "22px";

    if (prevLang !== state.targetLang) {
      translationCache.clear();
    }

    if (state.enabled) {
      startSubtitles();
    } else {
      stopSubtitles();
    }
    sendResponse({ status: "ok" });
    return true;
  }
});

// Periodic mount check (ensures overlay stays attached to movie_player after video change)
setInterval(() => {
  if (state.enabled) {
    initOverlay();
    if (!videoElement) bindVideo();
  }
}, 1500);

// Re-hook on YouTube SPA navigation
window.addEventListener("yt-navigate-finish", () => {
  subtitleHistory = [];
  lastTranslatedText = "";
  initOverlay();
  bindVideo();
  if (state.enabled) {
    startSubtitles();
  }
});
