// offscreen.js - LiveSub Manifest V3 Tab Audio Capture & WebSocket Streamer

const BACKEND_WS = "ws://localhost:8000/ws";
const BACKEND_HTTP = "http://localhost:8000";
const CHUNK_DURATION_MS = 1500; // 1.5s slice: optimal for Whisper large-v3-turbo low latency

let mediaStream = null;
let audioContext = null;
let analyser = null;
let audioDataArray = null;
let ws = null;
let isRecording = false;
let isPaused = false;
let currentTabId = null;
let currentTargetLang = "hi";
let currentLangHint = "";
let chunkTimer = null;
let activeRecorder = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "START_TAB_CAPTURE") {
    startCapture(message);
    sendResponse({ status: "started" });
  } else if (message.action === "STOP_TAB_CAPTURE") {
    stopCapture();
    sendResponse({ status: "stopped" });
  } else if (message.action === "UPDATE_CONFIG") {
    if (message.targetLang) currentTargetLang = message.targetLang;
    if (message.langHint !== undefined) currentLangHint = message.langHint;
    console.log("[LiveSub Offscreen] Config updated:", { currentTargetLang, currentLangHint });
    sendResponse({ status: "updated" });
  } else if (message.action === "VIDEO_STATUS") {
    isPaused = !!message.paused;
    console.log("[LiveSub Offscreen] Video playback status:", isPaused ? "PAUSED" : "PLAYING");
    sendResponse({ status: "ok" });
  }
});

function initWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(BACKEND_WS);

    ws.onopen = () => {
      console.log("[LiveSub Offscreen] WebSocket connected to backend");
    };

    ws.onmessage = (event) => {
      try {
        const cue = JSON.parse(event.data);
        if (cue && cue.translation && cue.translation.trim() && cue.translation !== "[stub transcript]" && currentTabId) {
          // Forward subtitle cue to the active YouTube tab
          chrome.tabs.sendMessage(currentTabId, {
            action: "SHOW_CUE",
            cue: cue,
          }).catch(() => {});
        }
      } catch (e) {
        console.warn("[LiveSub Offscreen] Error parsing cue:", e);
      }
    };

    ws.onerror = (err) => {
      console.warn("[LiveSub Offscreen] WebSocket error:", err);
      ws = null;
    };

    ws.onclose = () => {
      ws = null;
      // Auto-reconnect if recording is still active
      if (isRecording) {
        setTimeout(initWebSocket, 2000);
      }
    };
  } catch (err) {
    console.error("[LiveSub Offscreen] WebSocket init failed:", err);
  }
}

async function startCapture(config) {
  stopCapture();

  currentTabId = config.targetTabId;
  currentTargetLang = config.targetLang || "hi";
  currentLangHint = config.langHint || "";
  isPaused = false;

  initWebSocket();

  try {
    // 1. Capture real audio stream from the tab
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: config.streamId,
        },
      },
      video: false,
    });

    // 2. Keep audio playing through user's speakers/headphones
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(audioContext.destination);

    // 3. Attach real-time audio volume analyser (Voice Activity Check)
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioDataArray = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    // 4. Start gapless continuous audio slicing
    isRecording = true;
    recordNextSlice();

    console.log("[LiveSub Offscreen] Tab audio capture successfully active with 1.5s gapless slices");
  } catch (err) {
    console.error("[LiveSub Offscreen] Failed to start tab audio capture:", err);
  }
}

function getAudioRms() {
  if (!analyser || !audioDataArray) return 1.0;
  analyser.getByteTimeDomainData(audioDataArray);
  let sum = 0;
  for (let i = 0; i < audioDataArray.length; i++) {
    const val = (audioDataArray[i] - 128) / 128.0;
    sum += val * val;
  }
  return Math.sqrt(sum / audioDataArray.length);
}

function recordNextSlice() {
  if (!isRecording || !mediaStream || !mediaStream.active) return;

  if (isPaused) {
    // If user paused YouTube video, check again in 300ms without wasting CPU
    chunkTimer = setTimeout(recordNextSlice, 300);
    return;
  }

  let mimeType = "audio/webm;codecs=opus";
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  }

  try {
    const recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    activeRecorder = recorder;
    const recordedChunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    recorder.onstop = async () => {
      if (recordedChunks.length === 0) return;
      const blob = new Blob(recordedChunks, { type: mimeType || "audio/webm" });

      // If audio chunk is too small or silence, skip sending to avoid Whisper hallucinations
      if (blob.size < 800) return;

      const rms = getAudioRms();
      if (rms < 0.003) {
        // Pure silence (e.g. video quiet pause)
        return;
      }

      sendAudioSlice(blob);
    };

    recorder.start();

    // Gapless chaining: schedule next slice at exactly CHUNK_DURATION_MS
    chunkTimer = setTimeout(() => {
      if (isRecording) {
        // Start next recorder immediately on the active stream (zero dead zone!)
        recordNextSlice();
      }
      if (recorder.state === "recording") {
        recorder.stop();
      }
    }, CHUNK_DURATION_MS);

  } catch (err) {
    console.warn("[LiveSub Offscreen] Slice recording error:", err);
    chunkTimer = setTimeout(recordNextSlice, CHUNK_DURATION_MS);
  }
}

async function sendAudioSlice(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();

    const configPayload = {
      chunk_start: Date.now() / 1000.0,
      rate: 1.0,
      target_lang: currentTargetLang,
      lang_hint: currentLangHint || null,
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(configPayload));
      ws.send(arrayBuffer);
    } else {
      // Fallback: POST /api/transcribe
      const formData = new FormData();
      formData.append("audio", blob, "chunk.webm");
      formData.append("chunk_start", 0.0);
      formData.append("rate", 1.0);
      formData.append("target_lang", currentTargetLang);
      if (currentLangHint) formData.append("lang_hint", currentLangHint);

      const res = await fetch(`${BACKEND_HTTP}/api/transcribe`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const cue = await res.json();
        if (cue && cue.translation && cue.translation.trim() && cue.translation !== "[stub transcript]" && currentTabId) {
          chrome.tabs.sendMessage(currentTabId, {
            action: "SHOW_CUE",
            cue: cue,
          }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.warn("[LiveSub Offscreen] Error sending audio slice:", e);
  }
}

function stopCapture() {
  isRecording = false;

  if (chunkTimer) {
    clearTimeout(chunkTimer);
    chunkTimer = null;
  }

  if (activeRecorder && activeRecorder.state === "recording") {
    try {
      activeRecorder.stop();
    } catch (e) {}
    activeRecorder = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    try {
      audioContext.close();
    } catch (e) {}
    audioContext = null;
    analyser = null;
    audioDataArray = null;
  }

  if (ws) {
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }
}
