// content.js - LiveSub YouTube Subtitle Overlay & Caption Sync Engine

let state = {
  enabled: false,
  targetLang: "hi",
  langHint: "",
  subMode: "audio_stt",
  fontSize: "22px",
};

let videoElement = null;
let overlayContainer = null;
let captionBox = null;
let currentCueTimeout = null;
let lastTranslatedText = "";
let subtitleHistory = [];

// Caption translate state
let captionObserver = null;
let captionFallbackInterval = null;
let captionContainerRetry = null;   // retry timer to find caption container
const translationCache = new Map(); // kept across navigations — same words reused
let requestId = 0;
let isMutationHandling = false;     // guard against re-entrant mutation bursts

// ----------------------------------------------------------------------------
// 1. Overlay
// ----------------------------------------------------------------------------
function initOverlay() {
  if (document.getElementById("livesub-container")) {
    overlayContainer = document.getElementById("livesub-container");
    captionBox = overlayContainer.querySelector(".livesub-caption-box");
    return;
  }

  const player =
    document.querySelector("#movie_player") ||
    document.querySelector(".html5-video-player") ||
    document.body;
  if (!player) return;

  overlayContainer = document.createElement("div");
  overlayContainer.id = "livesub-container";
  overlayContainer.className = "hidden";

  captionBox = document.createElement("div");
  captionBox.className = "livesub-caption-box";
  captionBox.style.fontSize = state.fontSize || "22px";

  overlayContainer.appendChild(captionBox);
  player.appendChild(overlayContainer);
}

function showSubtitle(translation, original = null) {
  if (!captionBox || !overlayContainer) initOverlay();
  if (!captionBox || !overlayContainer) return;

  let html = `<div class="livesub-translation">${escapeHtml(translation)}</div>`;
  if (original && original !== translation && original !== "[stub transcript]") {
    html += `<div class="livesub-original">${escapeHtml(original)}</div>`;
  }

  captionBox.innerHTML = html;
  captionBox.style.fontSize = state.fontSize || "22px";
  overlayContainer.classList.remove("hidden");
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

function hideSubtitle() {
  overlayContainer?.classList.add("hidden");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.innerText = text;
  return div.innerHTML;
}

// ----------------------------------------------------------------------------
// 2. Video Binding
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
  chrome.runtime.sendMessage({ action: "VIDEO_STATUS", paused: false }).catch(() => {});
  if (state.enabled) startSubtitles();
}
function onPause() {
  chrome.runtime.sendMessage({ action: "VIDEO_STATUS", paused: true }).catch(() => {});
}
function onSeeking() {
  hideSubtitle();
}

// ----------------------------------------------------------------------------
// 3. Caption Translate Mode — MutationObserver + 100ms fallback
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
  } catch (e) { /* ignore — return original */ }
  return text;
}

function preCacheAllVisibleCaptions() {
  const allSegments = document.querySelectorAll(".ytp-caption-segment");
  allSegments.forEach((el) => {
    const t = el.innerText?.trim();
    if (t && t.length > 1) {
      const cacheKey = `${state.targetLang}:${t}`;
      if (!translationCache.has(cacheKey)) {
        translateDirect(t, state.targetLang).catch(() => {});
      }
    }
  });
}

async function onCaptionChange() {
  // Guard: don't let rapid mutations pile up async calls
  if (isMutationHandling) return;
  if (!state.enabled || state.subMode !== "caption_translate") return;

  const captionEl =
    document.querySelector(".ytp-caption-segment") ||
    document.querySelector(".ytp-caption-window-container .caption-visual-line") ||
    document.querySelector(".caption-window span");

  if (!captionEl) return;

  const rawText = captionEl.innerText?.trim();
  if (!rawText || rawText === lastTranslatedText) return;

  lastTranslatedText = rawText;
  const myRequestId = ++requestId;

  // Fire-and-forget pre-cache for upcoming lines
  preCacheAllVisibleCaptions();

  const cacheKey = `${state.targetLang}:${rawText}`;

  // INSTANT if cached
  if (translationCache.has(cacheKey)) {
    if (myRequestId !== requestId) return;
    const cached = translationCache.get(cacheKey);
    showSubtitle(cached, rawText);
    recordSubtitle(cached, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
    return;
  }

  // Show original immediately — never show blank
  showSubtitle(rawText, "");

  isMutationHandling = true;
  try {
    const translation = await translateDirect(rawText, state.targetLang);
    if (myRequestId !== requestId) return; // newer caption arrived — skip stale update
    showSubtitle(translation, rawText);
    recordSubtitle(translation, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
  } catch (e) { /* next caption will retry */ } finally {
    isMutationHandling = false;
  }
}

function attachCaptionObserver() {
  // Only observe the caption container specifically — NOT document.body
  // Observing body on YouTube = thousands of irrelevant mutations per second
  const captionContainer =
    document.querySelector(".ytp-caption-window-container") ||
    document.querySelector(".caption-window");

  if (!captionContainer) {
    // Container not in DOM yet (CC not enabled / video loading) — retry in 500ms
    captionContainerRetry = setTimeout(attachCaptionObserver, 500);
    return;
  }

  if (captionObserver) captionObserver.disconnect();

  captionObserver = new MutationObserver(() => {
    onCaptionChange();
  });

  captionObserver.observe(captionContainer, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  console.log("[LiveSub] MutationObserver attached to caption container");
}

function startCaptionObserver() {
  stopCaptionObserver();

  // Primary: MutationObserver on the specific caption container
  attachCaptionObserver();

  // Secondary: 100ms fallback poll — catches cases observer misses (seek, track switch, etc.)
  captionFallbackInterval = setInterval(onCaptionChange, 100);
}

function stopCaptionObserver() {
  if (captionContainerRetry) {
    clearTimeout(captionContainerRetry);
    captionContainerRetry = null;
  }
  if (captionObserver) {
    captionObserver.disconnect();
    captionObserver = null;
  }
  if (captionFallbackInterval) {
    clearInterval(captionFallbackInterval);
    captionFallbackInterval = null;
  }
  requestId = 0;
  lastTranslatedText = "";
  isMutationHandling = false;
}

// ----------------------------------------------------------------------------
// 4. Master Lifecycle
// ----------------------------------------------------------------------------
function startSubtitles() {
  initOverlay();
  bindVideo();

  if (state.subMode === "caption_translate") {
    stopCaptionObserver();
    startCaptionObserver();
  } else {
    // audio_stt mode — tell background to start offscreen audio capture
    stopCaptionObserver();
    chrome.runtime.sendMessage({ action: "START_AUDIO_SESSION", settings: state }).catch(() => {});
  }
}

function stopSubtitles() {
  stopCaptionObserver();
  chrome.runtime.sendMessage({ action: "STOP_AUDIO_SESSION" }).catch(() => {});
  hideSubtitle();
}

// ----------------------------------------------------------------------------
// 5. Settings, Export & Cue Listener
// ----------------------------------------------------------------------------
chrome.storage.local.get(
  { enabled: false, targetLang: "hi", langHint: "", subMode: "audio_stt", fontSize: "22px" },
  (saved) => {
    state = saved;
    initOverlay();
    bindVideo();
    if (state.enabled) {
      // Start on page load whether video is already playing or not
      startSubtitles();
    }
  }
);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. SRT/TXT export
  if (request.action === "EXPORT_SUBTITLES") {
    sendResponse({
      subtitles: subtitleHistory,
      title: document.title.replace(/\s*-\s*YouTube$/, "").trim() || "LiveSub subtitles",
    });
    return true;
  }

  // 2. Subtitle cue from offscreen.js (audio_stt mode)
  if (request.action === "SHOW_CUE" && request.cue) {
    const cue = request.cue;
    if (cue.translation && cue.translation.trim() && cue.translation !== "[stub transcript]") {
      showSubtitle(cue.translation, cue.text);
      recordSubtitle(cue.translation, cue.text, cue.start, cue.end);

      if (currentCueTimeout) clearTimeout(currentCueTimeout);
      // 2s display window — bridges consecutive 1.5s audio chunks smoothly
      currentCueTimeout = setTimeout(hideSubtitle, 2000);
    }
    sendResponse({ status: "ok" });
    return true;
  }

  // 3. Settings change from popup
  if (request.action === "SETTINGS_CHANGED") {
    const prevLang = state.targetLang;
    state = request.settings;
    if (captionBox) captionBox.style.fontSize = state.fontSize || "22px";

    // Clear cache only if target language changed (stale translations for new lang)
    if (prevLang !== state.targetLang) translationCache.clear();

    if (state.enabled) startSubtitles();
    else stopSubtitles();

    sendResponse({ status: "ok" });
    return true;
  }
});

// Re-attach on YouTube SPA navigation (video changes, not language)
window.addEventListener("yt-navigate-finish", () => {
  subtitleHistory = [];
  lastTranslatedText = "";
  // DO NOT clear translationCache — words reappear across videos
  initOverlay();
  bindVideo();
  if (state.enabled) startSubtitles();
});
