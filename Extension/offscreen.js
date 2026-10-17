// offscreen.js - LiveSub Manifest V3 Tab Audio Capture & WebSocket Streamer

const BACKEND_WS = "ws://localhost:8000/ws";
const BACKEND_HTTP = "http://localhost:8000";
const CHUNK_DURATION_MS = 1000; // 1.0s slice for lightning fast Whisper STT (<1.1s total turnaround)

let mediaStream = null;
let audioContext = null;
let ws = null;
let isRecording = false;
let currentTabId = null;
let currentTargetLang = "hi";
let currentLangHint = "";
let chunkTimer = null;
let activeRecorder = null;
let wsPingInterval = null;

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
    if (message.targetTabId) currentTabId = message.targetTabId;
    console.log("[LiveSub Offscreen] Config updated:", { currentTargetLang, currentLangHint, currentTabId });
    sendResponse({ status: "updated" });
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
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ ping: true }));
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      try {
        const cue = JSON.parse(event.data);
        const validText = (cue?.translation && cue.translation !== "[stub transcript]") || (cue?.text && cue.text !== "[stub transcript]");
        if (cue && validText) {
          deliverCueToTabs(cue);
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
      if (wsPingInterval) clearInterval(wsPingInterval);
      if (isRecording) {
        setTimeout(initWebSocket, 500);
      }
    };
  } catch (err) {
    console.error("[LiveSub Offscreen] WebSocket init failed:", err);
  }
}

function deliverCueToTabs(cue) {
  // 1. Direct message to target tab
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { action: "SHOW_CUE", cue }).catch(() => {});
  }

  // 2. Fallback to active YouTube tabs in case targetTabId changed
  try {
    chrome.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
      if (tabs && tabs.length > 0) {
        tabs.forEach((t) => {
          if (t.id && t.id !== currentTabId) {
            chrome.tabs.sendMessage(t.id, { action: "SHOW_CUE", cue }).catch(() => {});
          }
        });
      }
    });
  } catch (e) {}
}

async function startCapture(config) {
  stopCapture();

  currentTabId = config.targetTabId;
  currentTargetLang = config.targetLang || "hi";
  currentLangHint = config.langHint || "";

  initWebSocket();

  try {
    // 1. Capture real audio stream from tab
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: config.streamId,
        },
      },
      video: false,
    });

    // Handle stream closure (e.g. user reloads tab)
    mediaStream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        console.log("[LiveSub Offscreen] Audio track ended");
        stopCapture();
      };
    });

    // 2. Play audio back through user speakers
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(audioContext.destination);

    // 3. Start gapless audio slicing
    isRecording = true;
    recordNextSlice();

    console.log("[LiveSub Offscreen] Tab audio capture active. Streaming 1.5s slices to backend.");
  } catch (err) {
    console.error("[LiveSub Offscreen] Failed to start tab audio capture:", err);
  }
}

function recordNextSlice() {
  if (!isRecording || !mediaStream || !mediaStream.active) return;

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

      // Skip empty or corrupted webm header (< 800 bytes)
      if (blob.size < 800) return;

      sendAudioSlice(blob);
    };

    recorder.start();

    // Gapless chaining: schedule next recorder start at CHUNK_DURATION_MS
    chunkTimer = setTimeout(() => {
      if (isRecording) {
        recordNextSlice(); // Seamlessly starts next chunk
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
      // Fallback: POST /api/transcribe HTTP
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
        const validText = (cue?.translation && cue.translation !== "[stub transcript]") || (cue?.text && cue.text !== "[stub transcript]");
        if (cue && validText) {
          deliverCueToTabs(cue);
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
  }

  if (ws) {
    try {
      ws.close();
    } catch (e) {}
    ws = null;
  }

  if (wsPingInterval) {
    clearInterval(wsPingInterval);
    wsPingInterval = null;
  }
}
