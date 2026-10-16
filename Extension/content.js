// content.js - Injected into YouTube tabs for real-time subtitle overlay

const BACKEND_HTTP = "http://localhost:8000";
const BACKEND_WS = "ws://localhost:8000/ws";

let state = {
  enabled: false,
  targetLang: "en",
  langHint: "",
  subMode: "audio_stt",
  fontSize: "22px",
};

let videoElement = null;
let overlayContainer = null;
let captionBox = null;
let ws = null;
let mediaRecorder = null;
let chunkInterval = null;
let currentCueTimeout = null;
let lastTranslatedText = "";

// ----------------------------------------------------------------------------
// 1. Initialize & Inject Overlay
// ----------------------------------------------------------------------------
function initOverlay() {
  if (document.getElementById("livesub-container")) return;

  const player = document.querySelector("#movie_player") || document.body;
  if (!player) return;

  overlayContainer = document.createElement("div");
  overlayContainer.id = "livesub-container";
  overlayContainer.className = "hidden";

  captionBox = document.createElement("div");
  captionBox.className = "livesub-caption-box";
  captionBox.style.fontSize = state.fontSize;

  overlayContainer.appendChild(captionBox);
  player.appendChild(overlayContainer);
}

function showSubtitle(translation, original = null) {
  if (!captionBox || !overlayContainer) return;

  let html = `<div class="livesub-translation">${escapeHtml(translation)}</div>`;
  if (original && original !== translation) {
    html += `<div class="livesub-original">${escapeHtml(original)}</div>`;
  }

  captionBox.innerHTML = html;
  captionBox.style.fontSize = state.fontSize;
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

// ----------------------------------------------------------------------------
// 2. Video Player Binding
// ----------------------------------------------------------------------------
function bindVideo() {
  videoElement = document.querySelector("video");
  if (!videoElement) return;

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
  stopSubtitles();
}

function onSeeking() {
  hideSubtitle();
}

// ----------------------------------------------------------------------------
// 3. Mode A: Live Audio Streaming via WebSocket
// ----------------------------------------------------------------------------
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(BACKEND_WS);

    ws.onopen = () => {
      console.log("[LiveSub] WebSocket connected to backend");
    };

    ws.onmessage = (event) => {
      try {
        const cue = JSON.parse(event.data);
        if (cue.error) {
          console.warn("[LiveSub] Server error:", cue.error);
          return;
        }

        // Display cue with synchronization
        if (cue.translation) {
          showSubtitle(cue.translation, cue.text);

          // Clear previous timeout and schedule hide after duration
          if (currentCueTimeout) clearTimeout(currentCueTimeout);
          const durationSec = Math.max(0.5, (cue.end - cue.start) / (videoElement?.playbackRate || 1.0));
          currentCueTimeout = setTimeout(() => {
            hideSubtitle();
          }, durationSec * 1000);
        }
      } catch (e) {
        console.error("[LiveSub] Failed to parse cue JSON:", e);
      }
    };

    ws.onclose = () => {
      console.log("[LiveSub] WebSocket disconnected");
      ws = null;
    };

    ws.onerror = (err) => {
      console.warn("[LiveSub] WebSocket error, will retry on next chunk:", err);
      ws = null;
    };
  } catch (err) {
    console.error("[LiveSub] Could not open WebSocket:", err);
  }
}

let audioCaptureStream = null;

function getAudioStream() {
  if (!videoElement) return null;
  if (!audioCaptureStream) {
    try {
      const stream = videoElement.captureStream ? videoElement.captureStream() : videoElement.mozCaptureStream();
      if (stream) {
        const audioTracks = stream.getAudioTracks();
        if (audioTracks && audioTracks.length > 0) {
          audioCaptureStream = new MediaStream(audioTracks);
        }
      }
    } catch (e) {
      console.warn("[LiveSub] captureStream unavailable:", e);
    }
  }
  return audioCaptureStream;
}

function startAudioStreaming() {
  connectWebSocket();

  if (chunkInterval) clearInterval(chunkInterval);

  async function recordAndSendSlice() {
    if (!state.enabled || !videoElement || videoElement.paused) return;

    const stream = getAudioStream();
    const chunkStart = videoElement.currentTime;
    const playbackRate = videoElement.playbackRate || 1.0;

    const config = {
      chunk_start: chunkStart,
      rate: playbackRate,
      target_lang: state.targetLang,
      lang_hint: state.langHint || null,
    };

    if (stream && typeof MediaRecorder !== "undefined") {
      let mimeType = "audio/webm";
      if (!MediaRecorder.isTypeSupported("audio/webm")) {
        mimeType = "";
      }

      try {
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        const recordedChunks = [];

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            recordedChunks.push(e.data);
          }
        };

        recorder.onstop = async () => {
          if (recordedChunks.length === 0) return;
          const blob = new Blob(recordedChunks, { type: "audio/webm" });
          const arrayBuffer = await blob.arrayBuffer();

          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(config));
            ws.send(arrayBuffer);
          } else {
            // Fallback HTTP
            try {
              const formData = new FormData();
              formData.append("audio", blob, "chunk.webm");
              formData.append("chunk_start", chunkStart);
              formData.append("rate", playbackRate);
              formData.append("target_lang", state.targetLang);
              if (state.langHint) formData.append("lang_hint", state.langHint);

              const res = await fetch(`${BACKEND_HTTP}/api/transcribe`, {
                method: "POST",
                body: formData,
              });
              if (res.ok) {
                const cue = await res.json();
                if (cue.translation) {
                  showSubtitle(cue.translation, cue.text);
                }
              }
            } catch (err) {}
          }
        };

        recorder.start();
        setTimeout(() => {
          if (recorder.state === "recording") {
            recorder.stop();
          }
        }, 2200);
      } catch (err) {
        console.warn("[LiveSub] MediaRecorder recording error:", err);
      }
    }
  }

  recordAndSendSlice();
  chunkInterval = setInterval(recordAndSendSlice, 2500);
}

function stopAudioStreaming() {
  if (chunkInterval) {
    clearInterval(chunkInterval);
    chunkInterval = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }
}

// ----------------------------------------------------------------------------
// 4. Mode B: Translate Existing YouTube Captions
// Non-blocking: every poll runs freely. requestId ensures only the
// latest translation shows. Background pre-caches all visible segments.
// ----------------------------------------------------------------------------
let captionObserver = null;
let captionPollInterval = null;
const translationCache = new Map();
let requestId = 0;

async function translateDirect(text, targetLang) {
  if (translationCache.has(text)) return translationCache.get(text);

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  const data = await res.json();
  const parts = (data[0] || []).map((s) => (s && s[0]) || "").join("");

  if (parts) {
    if (translationCache.size > 500) {
      translationCache.delete(translationCache.keys().next().value);
    }
    translationCache.set(text, parts);
    return parts;
  }
  return text;
}

// Pre-translate all visible caption segments in background (cache warming)
function preCacheVisibleCaptions(targetLang) {
  const allSegments = document.querySelectorAll(".ytp-caption-segment");
  allSegments.forEach((el) => {
    const t = el.innerText?.trim();
    if (t && !translationCache.has(t)) {
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

    // Pre-cache other visible segments in background
    preCacheVisibleCaptions(state.targetLang);

    // INSTANT: cache hit
    if (translationCache.has(rawText)) {
      if (myRequestId === requestId) {
        showSubtitle(translationCache.get(rawText), rawText);
      }
      return;
    }

    // Show original text while Hindi/other translation loads
    showSubtitle(rawText, "");

    try {
      const translation = await translateDirect(rawText, state.targetLang);
      // Only display if still the latest request (not stale)
      if (myRequestId === requestId) {
        showSubtitle(translation, rawText);
      }
    } catch (e) {
      // Silently ignore — next poll will retry
    }
  }, 200);
}

function stopCaptionObserver() {
  if (captionPollInterval) {
    clearInterval(captionPollInterval);
    captionPollInterval = null;
  }
  if (captionObserver) {
    captionObserver.disconnect();
    captionObserver = null;
  }
  requestId = 0;
}

// ----------------------------------------------------------------------------
// 5. Master Lifecycle (Start / Stop)
// ----------------------------------------------------------------------------
function startSubtitles() {
  initOverlay();
  bindVideo();

  if (state.subMode === "audio_stt") {
    stopCaptionObserver();
    startAudioStreaming();
  } else {
    stopAudioStreaming();
    startCaptionObserver();
  }
}

function stopSubtitles() {
  stopAudioStreaming();
  stopCaptionObserver();
  hideSubtitle();
}

// ----------------------------------------------------------------------------
// 6. Settings Listener
// ----------------------------------------------------------------------------
chrome.storage.local.get(
  {
    enabled: false,
    targetLang: "en",
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
  if (request.action === "SETTINGS_CHANGED") {
    state = request.settings;
    if (captionBox) {
      captionBox.style.fontSize = state.fontSize;
    }

    if (state.enabled) {
      startSubtitles();
    } else {
      stopSubtitles();
    }
    sendResponse({ status: "ok" });
  }
});

// Re-hook on YouTube SPA navigation
window.addEventListener("yt-navigate-finish", () => {
  initOverlay();
  bindVideo();
  if (state.enabled && videoElement && !videoElement.paused) {
    startSubtitles();
  }
});
