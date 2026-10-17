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
let captionObserver = null;      // MutationObserver — fires <1ms on DOM change
let captionFallbackInterval = null; // Fallback poll in case observer misses
const translationCache = new Map();
let requestId = 0;
let pendingTranslation = false;

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
// 3. Caption Translate Mode — MutationObserver (ZERO polling delay)
// ----------------------------------------------------------------------------

// Direct Google Translate call — no backend, pure frontend, ~100ms cold / 0ms cached
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
  } catch (e) {
    // Silently swallow — return original
  }
  return text;
}

// Pre-warm translation cache for ALL visible caption segments ahead of time
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

// Called whenever YouTube caption DOM changes — fires in <1ms
async function onCaptionMutation() {
  if (!state.enabled || state.subMode !== "caption_translate") return;

  // Grab the text from any of YouTube's possible caption selectors
  const captionEl =
    document.querySelector(".ytp-caption-segment") ||
    document.querySelector(".ytp-caption-window-container .caption-visual-line") ||
    document.querySelector(".caption-window span");

  if (!captionEl) return;

  const rawText = captionEl.innerText?.trim();
  if (!rawText || rawText === lastTranslatedText) return;

  lastTranslatedText = rawText;
  const myRequestId = ++requestId;

  // Pre-warm other visible captions in parallel (no await — background fire-and-forget)
  preCacheAllVisibleCaptions();

  const cacheKey = `${state.targetLang}:${rawText}`;

  // INSTANT CACHE HIT — show translation with zero delay
  if (translationCache.has(cacheKey)) {
    if (myRequestId !== requestId) return;
    const cached = translationCache.get(cacheKey);
    showSubtitle(cached, rawText);
    recordSubtitle(cached, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
    return;
  }

  // Cache MISS: show original text immediately while translation loads
  showSubtitle(rawText, "");

  try {
    const translation = await translateDirect(rawText, state.targetLang);
    if (myRequestId !== requestId) return; // stale — a newer caption arrived
    showSubtitle(translation, rawText);
    recordSubtitle(translation, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
  } catch (e) { /* next caption will retry */ }
}

function startCaptionObserver() {
  stopCaptionObserver();

  // ─── MutationObserver: fires the INSTANT YouTube updates caption text ───
  // This is MUCH faster than setInterval — no polling lag at all.
  const captionContainer =
    document.querySelector(".ytp-caption-window-container") ||
    document.querySelector(".caption-window") ||
    document.body;

  captionObserver = new MutationObserver(() => {
    onCaptionMutation();
  });

  captionObserver.observe(captionContainer, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // ─── Lightweight fallback interval (50ms) in case observer misses changes ───
  // e.g. when switching caption tracks or after seeking
  captionFallbackInterval = setInterval(onCaptionMutation, 50);

  console.log("[LiveSub] Caption observer active (MutationObserver + 50ms fallback)");
}

function stopCaptionObserver() {
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
}

// ----------------------------------------------------------------------------
// 4. Master Lifecycle
// ----------------------------------------------------------------------------
function startSubtitles() {
  initOverlay();
  bindVideo();

  if (state.subMode === "caption_translate") {
    startCaptionObserver();
  } else {
    stopCaptionObserver();
  }
}

function stopSubtitles() {
  stopCaptionObserver();
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
    if (state.enabled && videoElement && !videoElement.paused) startSubtitles();
  }
);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "EXPORT_SUBTITLES") {
    sendResponse({
      subtitles: subtitleHistory,
      title: document.title.replace(/\s*-\s*YouTube$/, "").trim() || "LiveSub subtitles",
    });
    return true;
  }

  if (request.action === "SHOW_CUE" && request.cue) {
    const cue = request.cue;
    if (cue.translation && cue.translation.trim() && cue.translation !== "[stub transcript]") {
      showSubtitle(cue.translation, cue.text);
      recordSubtitle(cue.translation, cue.text, cue.start, cue.end);

      if (currentCueTimeout) clearTimeout(currentCueTimeout);
      // Keep subtitle visible for 2s — overlaps the next 1.5s chunk seamlessly
      currentCueTimeout = setTimeout(hideSubtitle, 2000);
    }
    sendResponse({ status: "ok" });
    return true;
  }

  if (request.action === "SETTINGS_CHANGED") {
    const prevLang = state.targetLang;
    state = request.settings;
    if (captionBox) captionBox.style.fontSize = state.fontSize || "22px";

    // If language changed, clear cache so stale translations don't show
    if (prevLang !== state.targetLang) translationCache.clear();

    if (state.enabled) startSubtitles();
    else stopSubtitles();

    sendResponse({ status: "ok" });
    return true;
  }
});

// Re-attach on YouTube SPA navigation
window.addEventListener("yt-navigate-finish", () => {
  subtitleHistory = [];
  lastTranslatedText = "";
  translationCache.clear(); // New video = new content = fresh cache
  initOverlay();
  bindVideo();
  if (state.enabled && videoElement && !videoElement.paused) startSubtitles();
});
