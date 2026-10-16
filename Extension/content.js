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

let audioCaptureStream = null;

async function getAudioStream() {
  if (!videoElement) return null;

  // 1. Try HTML5 video.captureStream()
  if (!audioCaptureStream || !audioCaptureStream.active) {
    try {
      const vStream = videoElement.captureStream ? videoElement.captureStream() : (videoElement.mozCaptureStream ? videoElement.mozCaptureStream() : null);
      if (vStream) {
        const audioTracks = vStream.getAudioTracks();
        if (audioTracks && audioTracks.length > 0) {
          audioCaptureStream = new MediaStream(audioTracks);
        }
      }
    } catch (e) {
      console.warn("[LiveSub] captureStream unavailable:", e);
    }
  }

  // 2. Fallback to tabCapture stream if available
  if (!audioCaptureStream || !audioCaptureStream.active) {
    try {
      const response = await chrome.runtime.sendMessage({ action: "GET_TAB_STREAM_ID" });
      if (response && response.streamId) {
        const tabStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: response.streamId,
            },
          },
          video: false,
        });
        if (tabStream && tabStream.getAudioTracks().length > 0) {
          // Keep audio playing through user speakers
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const source = audioCtx.createMediaStreamSource(tabStream);
          source.connect(audioCtx.destination);
          audioCaptureStream = tabStream;
        }
      }
    } catch (err) {
      console.warn("[LiveSub] tabCapture fallback:", err);
    }
  }

  return audioCaptureStream;
}

let isRecordingAudioSlice = false;

function startAudioStreaming() {
  connectWebSocket();

  if (chunkInterval) clearInterval(chunkInterval);

  async function recordAndSendSlice() {
    if (!state.enabled || !videoElement || videoElement.paused) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connectWebSocket();
    }
    if (isRecordingAudioSlice) return;

    const stream = await getAudioStream();
    if (!stream || !stream.active) return;

    const chunkStart = videoElement.currentTime;
    const playbackRate = videoElement.playbackRate || 1.0;

    const config = {
      chunk_start: chunkStart,
      rate: playbackRate,
      target_lang: state.targetLang,
      lang_hint: state.langHint || null,
    };

    if (typeof MediaRecorder === "undefined") return;

    let mimeType = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";

    try {
      isRecordingAudioSlice = true;
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const recordedChunks = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };

      recorder.onstop = async () => {
        isRecordingAudioSlice = false;
        if (recordedChunks.length === 0) return;

        const blob = new Blob(recordedChunks, { type: mimeType || "audio/webm" });
        if (blob.size < 800) return; // Skip silence / empty header

        const arrayBuffer = await blob.arrayBuffer();

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(config));
          ws.send(arrayBuffer);
        } else {
          // Fallback: POST /api/transcribe
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
              if (cue && cue.translation && cue.translation.trim()) {
                showSubtitle(cue.translation, cue.text);
                recordSubtitle(cue.translation, cue.text, cue.start, cue.end);
              }
            }
          } catch (err) {}
        }
      };

      recorder.start();
      // Record in 2.8 second slices for optimal speech detection
      setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, 2800);
    } catch (err) {
      isRecordingAudioSlice = false;
      console.warn("[LiveSub] MediaRecorder recording error:", err);
    }
  }

  recordAndSendSlice();
  chunkInterval = setInterval(recordAndSendSlice, 3000);
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
        const translation = translationCache.get(rawText);
        showSubtitle(translation, rawText);
        recordSubtitle(translation, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
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
        recordSubtitle(translation, rawText, videoElement?.currentTime, (videoElement?.currentTime || 0) + 2.5);
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
  if (request.action === "EXPORT_SUBTITLES") {
    sendResponse({
      subtitles: subtitleHistory,
      title: document.title.replace(/\s*-\s*YouTube$/, "").trim() || "LiveSub subtitles",
    });
    return;
  }

  if (request.action === "SHOW_CUE" && request.cue) {
    const cue = request.cue;
    if (cue.translation && cue.translation.trim() && cue.translation !== "[stub transcript]") {
      showSubtitle(cue.translation, cue.text);
      recordSubtitle(cue.translation, cue.text, cue.start, cue.end);

      if (currentCueTimeout) clearTimeout(currentCueTimeout);
      const durationSec = Math.max(2.0, (cue.end - cue.start) / (videoElement?.playbackRate || 1.0));
      currentCueTimeout = setTimeout(() => {
        hideSubtitle();
      }, durationSec * 1000);
    }
    sendResponse({ status: "ok" });
    return true;
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
