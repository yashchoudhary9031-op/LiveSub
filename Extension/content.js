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
let captionPollInterval = null;
const translationCache = new Map();
let requestId = 0;

// ----------------------------------------------------------------------------
// 1. Initialize & Inject Overlay
// ----------------------------------------------------------------------------
function initOverlay() {
  if (document.getElementById("livesub-container")) {
    overlayContainer = document.getElementById("livesub-container");
    captionBox = overlayContainer.querySelector(".livesub-caption-box");
    return;
  }

  const player = document.querySelector("#movie_player") || document.querySelector(".html5-video-player") || document.body;
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

function recordSubtitle(translation, original, start, end) {
  if (!translation) return;

  const cueStart = Number.isFinite(Number(start)) ? Number(start) : (videoElement?.currentTime || 0);
  const cueEnd = Number.isFinite(Number(end)) && Number(end) > cueStart
    ? Number(end)
    : cueStart + 2.5;
  const cue = {
    start: cueStart,
    end: cueEnd,
    original: original || "",
    translation,
  };
  const previous = subtitleHistory[subtitleHistory.length - 1];

  if (previous && previous.start === cue.start && previous.translation === cue.translation) return;
  subtitleHistory.push(cue);
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
  chrome.runtime.sendMessage({ action: "VIDEO_STATUS", paused: false }).catch(() => {});
  if (state.enabled) {
    startSubtitles();
  }
}

function onPause() {
  chrome.runtime.sendMessage({ action: "VIDEO_STATUS", paused: true }).catch(() => {});
  if (state.subMode === "caption_translate") {
    // Keep last caption during brief pause
  }
}

function onSeeking() {
  hideSubtitle();
}

// ----------------------------------------------------------------------------
// 3. Mode B: Translate Existing YouTube Captions (0 Delay)
// ----------------------------------------------------------------------------
async function translateDirect(text, targetLang) {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  const data = await res.json();
  const parts = (data[0] || []).map((s) => (s && s[0]) || "").join("");

  if (parts) {
    if (translationCache.size > 500) {
      translationCache.delete(translationCache.keys().next().value);
    }
    translationCache.set(cacheKey, parts);
    return parts;
  }
  return text;
}

function preCacheVisibleCaptions(targetLang) {
  const allSegments = document.querySelectorAll(".ytp-caption-segment");
  allSegments.forEach((el) => {
    const t = el.innerText?.trim();
    const cacheKey = `${targetLang}:${t}`;
    if (t && !translationCache.has(cacheKey)) {
      translateDirect(t, targetLang).catch(() => {});
    }
  });
}

function startCaptionObserver() {
  stopCaptionObserver();

  captionPollInterval = setInterval(async () => {
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

    preCacheVisibleCaptions(state.targetLang);

    const cacheKey = `${state.targetLang}:${rawText}`;
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
  }, 150);
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
  {
    enabled: false,
    targetLang: "hi",
    langHint: "",
    subMode: "audio_stt",
    fontSize: "22px",
  },
  (saved) => {
    state = saved;
    initOverlay();
    bindVideo();
    if (state.enabled && videoElement && !videoElement.paused) {
      startSubtitles();
    }
  }
);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. Export Subtitles history requested by popup
  if (request.action === "EXPORT_SUBTITLES") {
    sendResponse({
      subtitles: subtitleHistory,
      title: document.title.replace(/\s*-\s*YouTube$/, "").trim() || "LiveSub subtitles",
    });
    return true;
  }

  // 2. Subtitle Cue received from offscreen.js (Live Audio STT)
  if (request.action === "SHOW_CUE" && request.cue) {
    const cue = request.cue;
    if (cue.translation && cue.translation.trim() && cue.translation !== "[stub transcript]") {
      showSubtitle(cue.translation, cue.text);
      recordSubtitle(cue.translation, cue.text, cue.start, cue.end);

      if (currentCueTimeout) clearTimeout(currentCueTimeout);
      // Keep visible for 2.2 seconds so consecutive 1.5s chunks transition seamlessly
      currentCueTimeout = setTimeout(() => {
        hideSubtitle();
      }, 2200);
    }
    sendResponse({ status: "ok" });
    return true;
  }

  // 3. Settings changed from popup
  if (request.action === "SETTINGS_CHANGED") {
    state = request.settings;
    if (captionBox) {
      captionBox.style.fontSize = state.fontSize || "22px";
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

// Re-hook on YouTube SPA navigation
window.addEventListener("yt-navigate-finish", () => {
  subtitleHistory = [];
  lastTranslatedText = "";
  initOverlay();
  bindVideo();
  if (state.enabled && videoElement && !videoElement.paused) {
    startSubtitles();
  }
});
