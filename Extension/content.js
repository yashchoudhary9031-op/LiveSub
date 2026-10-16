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
let subtitleHistory = [];

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

  let html = "";
  if (original && original !== translation) {
    html += `<div class="livesub-original">${escapeHtml(original)}</div>`;
  }
  html += `<div class="livesub-translation">${escapeHtml(translation)}</div>`;

  captionBox.innerHTML = html;
  captionBox.style.fontSize = state.fontSize;
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
    const socket = new WebSocket(BACKEND_WS);
    ws = socket;

    socket.onopen = () => {
      console.log("[LiveSub] WebSocket connected to backend");
    };

    socket.onmessage = (event) => {
      try {
        const cue = JSON.parse(event.data);
        if (cue.error) {
          console.warn("[LiveSub] Server error:", cue.error);
          return;
        }

        // Display cue with synchronization
        if (cue.translation) {
          showSubtitle(cue.translation, cue.text);
          recordSubtitle(cue.translation, cue.text, cue.start, cue.end);

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

    socket.onclose = (event) => {
      console.log(`[LiveSub] WebSocket disconnected (code ${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      if (ws === socket) ws = null;
    };

    socket.onerror = () => {
      console.warn(`[LiveSub] WebSocket connection failed at ${BACKEND_WS}; will retry on next chunk`);
      if (ws === socket) ws = null;
    };
  } catch (err) {
    console.error("[LiveSub] Could not open WebSocket:", err);
  }
}

function startAudioStreaming() {
  connectWebSocket();

  if (chunkInterval) clearInterval(chunkInterval);

  // Periodically send chunk configuration and trigger transcription
  chunkInterval = setInterval(async () => {
    if (!state.enabled || !videoElement || videoElement.paused) return;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }

    const chunkStart = videoElement.currentTime;
    const playbackRate = videoElement.playbackRate || 1.0;

    const config = {
      chunk_start: chunkStart,
      rate: playbackRate,
      target_lang: state.targetLang,
      lang_hint: state.langHint || null,
    };

    // If WebSocket is open, stream through WS
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send text configuration frame
      ws.send(JSON.stringify(config));
      // Send binary audio frame (using dummy/simulated slice in stub mode)
      const dummyAudio = new Uint8Array([0, 1, 2, 3]);
      ws.send(dummyAudio.buffer);
    } else {
      // Fallback: POST /api/transcribe
      try {
        const formData = new FormData();
        const blob = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/webm" });
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
          showSubtitle(cue.translation, cue.text);
          recordSubtitle(cue.translation, cue.text, cue.start, cue.end);
        }
      } catch (err) {
        // Backend not reached
      }
    }
  }, 2000); // 2-second chunks
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
// ----------------------------------------------------------------------------
let captionObserver = null;

function startCaptionObserver() {
  stopCaptionObserver();

  captionObserver = new MutationObserver(async () => {
    if (!state.enabled || state.subMode !== "caption_translate") return;

    // Look for YouTube caption elements
    const captionEl = document.querySelector(".ytp-caption-segment") ||
                      document.querySelector(".caption-window");

    if (captionEl && captionEl.innerText.trim()) {
      const rawText = captionEl.innerText.trim();
      if (rawText !== lastTranslatedText) {
        lastTranslatedText = rawText;
        try {
          const res = await fetch(`${BACKEND_HTTP}/api/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: rawText,
              src: state.langHint || "auto",
              target: state.targetLang,
            }),
          });

          if (res.ok) {
            const data = await res.json();
            showSubtitle(data.translation, rawText);
            recordSubtitle(data.translation, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
          }
        } catch (e) {
          console.warn("[LiveSub] Translation error:", e);
        }
      }
    }
  });

  const player = document.querySelector("#movie_player") || document.body;
  if (player) {
    captionObserver.observe(player, { childList: true, subtree: true, characterData: true });
  }
}

function stopCaptionObserver() {
  if (captionObserver) {
    captionObserver.disconnect();
    captionObserver = null;
  }
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
  if (request.action === "EXPORT_SUBTITLES") {
    sendResponse({
      subtitles: subtitleHistory,
      title: document.title.replace(/\s*-\s*YouTube$/, "").trim() || "LiveSub subtitles",
    });
    return;
  }

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
  subtitleHistory = [];
  lastTranslatedText = "";
  initOverlay();
  bindVideo();
  if (state.enabled && videoElement && !videoElement.paused) {
    startSubtitles();
  }
});
