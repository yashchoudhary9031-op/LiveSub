// content.js - LiveSub Zero-Delay Subtitle & Translation Engine for YouTube

const BACKEND_HTTP = "http://localhost:8000";
const BACKEND_WS = "ws://localhost:8000/ws";

let state = {
  enabled: false,
  targetLang: "hi",
  langHint: "",
  subMode: "caption_translate",
  fontSize: "22px",
};

let videoElement = null;
let overlayContainer = null;
let captionBox = null;
let captionPollInterval = null;
let captionMutationObserver = null;
let lastCapturedText = "";
const translationCache = new Map();
let currentRequestId = 0;

// ----------------------------------------------------------------------------
// 1. Overlay Injection & Management
// ----------------------------------------------------------------------------
function initOverlay() {
  if (document.getElementById("livesub-container")) {
    overlayContainer = document.getElementById("livesub-container");
    captionBox = overlayContainer.querySelector(".livesub-caption-box");
    return;
  }

  const player = document.querySelector("#movie_player") || document.body;
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
  initOverlay();
  if (!captionBox || !overlayContainer) return;

  let html = `<div class="livesub-translation">${escapeHtml(translation)}</div>`;
  if (original && original !== translation && original.trim() !== "") {
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
  if (!text) return "";
  const div = document.createElement("div");
  div.innerText = text;
  return div.innerHTML;
}

// ----------------------------------------------------------------------------
// 2. Auto-Hook YouTube Native Captions in Background
// ----------------------------------------------------------------------------
function autoEnableYouTubeCC() {
  const ccButton = document.querySelector(".ytp-subtitles-button");
  if (ccButton && ccButton.getAttribute("aria-pressed") === "false") {
    ccButton.click();
    console.log("[LiveSub] Auto-enabled YouTube captions in background");
  }
}

// ----------------------------------------------------------------------------
// 3. Fast In-Browser Google Translation Engine (Zero API Keys)
// ----------------------------------------------------------------------------
async function translateDirect(text, targetLang) {
  if (!text || !text.trim()) return "";
  const clean = text.trim();

  // Instant cache hit: 0ms delay!
  if (translationCache.has(clean)) {
    return translationCache.get(clean);
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(clean)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const parts = (data[0] || []).map((s) => (s && s[0]) || "").join("");
      if (parts) {
        if (translationCache.size > 500) {
          translationCache.delete(translationCache.keys().next().value);
        }
        translationCache.set(clean, parts);
        return parts;
      }
    }
  } catch (e) {
    // Direct browser fetch failed, fallback to backend
  }

  // Fallback to local FastAPI backend
  try {
    const res = await fetch(`${BACKEND_HTTP}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean, src: "auto", target: targetLang }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.translation) {
        translationCache.set(clean, data.translation);
        return data.translation;
      }
    }
  } catch (err) {}

  return clean;
}

// ----------------------------------------------------------------------------
// 4. Ultra-Fast Caption Tracker (0-Latency Observer + 100ms Poller)
// ----------------------------------------------------------------------------
async function processCaptionElement() {
  if (!state.enabled) return;

  const captionEl =
    document.querySelector(".ytp-caption-segment") ||
    document.querySelector(".ytp-caption-window-container .caption-visual-line") ||
    document.querySelector(".caption-window span");

  if (!captionEl) {
    // If no caption element found and CC button exists, ensure it's on
    autoEnableYouTubeCC();
    return;
  }

  const rawText = captionEl.innerText?.replace(/\s+/g, " ")?.trim();
  if (!rawText || rawText === lastCapturedText) return;

  lastCapturedText = rawText;
  const thisReqId = ++currentRequestId;

  // 1. Instant display: If already in cache, show Hindi translation in 0ms!
  if (translationCache.has(rawText)) {
    showSubtitle(translationCache.get(rawText), rawText);
    return;
  }

  // 2. If not yet in cache, show original line immediately so user has ZERO blank space
  showSubtitle(rawText, "");

  // 3. Fetch translation and swap in
  try {
    const translated = await translateDirect(rawText, state.targetLang || "hi");
    if (thisReqId === currentRequestId && translated) {
      showSubtitle(translated, rawText);
    }
  } catch (e) {}
}

function startCaptionTracking() {
  stopCaptionTracking();
  document.body.classList.add("livesub-active");

  initOverlay();
  autoEnableYouTubeCC();

  // 1. MutationObserver on player for instant DOM updates
  const player = document.querySelector("#movie_player") || document.body;
  if (player) {
    captionMutationObserver = new MutationObserver(() => {
      processCaptionElement();
    });
    captionMutationObserver.observe(player, { childList: true, subtree: true, characterData: true });
  }

  // 2. 100ms interval backup so not a single subtitle is missed
  captionPollInterval = setInterval(processCaptionElement, 100);
}

function stopCaptionTracking() {
  document.body.classList.remove("livesub-active");
  if (captionPollInterval) {
    clearInterval(captionPollInterval);
    captionPollInterval = null;
  }
  if (captionMutationObserver) {
    captionMutationObserver.disconnect();
    captionMutationObserver = null;
  }
  hideSubtitle();
}

// ----------------------------------------------------------------------------
// 5. Video Player Event Binding
// ----------------------------------------------------------------------------
function bindVideo() {
  videoElement = document.querySelector("video");
  if (!videoElement) return;

  videoElement.addEventListener("play", () => {
    if (state.enabled) startCaptionTracking();
  });
  videoElement.addEventListener("pause", () => {
    // Keep last subtitle on screen while paused
  });
  videoElement.addEventListener("seeking", () => {
    lastCapturedText = "";
    hideSubtitle();
  });
}

// ----------------------------------------------------------------------------
// 6. State Sync & Messaging
// ----------------------------------------------------------------------------
chrome.storage.local.get(
  {
    enabled: false,
    targetLang: "hi",
    langHint: "",
    subMode: "caption_translate",
    fontSize: "22px",
  },
  (saved) => {
    state = saved;
    initOverlay();
    bindVideo();
    if (state.enabled) {
      startCaptionTracking();
    }
  }
);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "SETTINGS_CHANGED") {
    state = request.settings;
    if (captionBox) {
      captionBox.style.fontSize = state.fontSize || "22px";
    }

    if (state.enabled) {
      startCaptionTracking();
    } else {
      stopCaptionTracking();
    }
    sendResponse({ status: "ok" });
  }
});

// Re-hook on YouTube SPA navigation
window.addEventListener("yt-navigate-finish", () => {
  initOverlay();
  bindVideo();
  lastCapturedText = "";
  if (state.enabled) {
    startCaptionTracking();
  }
});
