// offscreen.js - LiveSub Manifest V3 Tab Audio Capture & WebSocket Streamer

const BACKEND_WS = "ws://localhost:8000/ws";
const BACKEND_HTTP = "http://localhost:8000";

let mediaStream = null;
let audioContext = null;
let mediaRecorder = null;
let ws = null;
let isRecording = false;
let currentTabId = null;
let currentTargetLang = "hi";
let currentLangHint = "";
let recordingInterval = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "START_TAB_CAPTURE") {
    startCapture(message);
    sendResponse({ status: "started" });
  } else if (message.action === "STOP_TAB_CAPTURE") {
    stopCapture();
    sendResponse({ status: "stopped" });
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
        if (cue && cue.translation && currentTabId) {
          // Forward subtitle cue to the YouTube content script
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

    // 2. Keep audio playing through the user's speakers/headphones
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(audioContext.destination);

    // 3. Start slicing audio and streaming to Groq Whisper
    isRecording = true;
    startAudioSlices();

    console.log("[LiveSub Offscreen] Tab audio capture successfully active");
  } catch (err) {
    console.error("[LiveSub Offscreen] Failed to start tab audio capture:", err);
  }
}

function startAudioSlices() {
  if (recordingInterval) clearInterval(recordingInterval);

  async function sliceAndSend() {
    if (!isRecording || !mediaStream || !mediaStream.active) return;

    let mimeType = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    }

    try {
      const recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
      const recordedChunks = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };

      recorder.onstop = async () => {
        if (recordedChunks.length === 0) return;
        const blob = new Blob(recordedChunks, { type: mimeType || "audio/webm" });

        // Skip silence or empty headers
        if (blob.size < 1200) return;

        const arrayBuffer = await blob.arrayBuffer();

        const configPayload = {
          chunk_start: Date.now() / 1000.0,
          rate: 1.0,
          target_lang: currentTargetLang,
          lang_hint: currentLangHint || null,
        };

        if (ws && ws.readyState === WebSocket.OPEN) {
          // Send metadata JSON, then binary audio slice
          ws.send(JSON.stringify(configPayload));
          ws.send(arrayBuffer);
        } else {
          // HTTP Fallback to POST /api/transcribe
          try {
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
              if (cue && cue.translation && currentTabId) {
                chrome.tabs.sendMessage(currentTabId, {
                  action: "SHOW_CUE",
                  cue: cue,
                }).catch(() => {});
              }
            }
          } catch (e) {}
        }
      };

      // Record in 2.6-second slices for near-zero delay transcription
      recorder.start();
      setTimeout(() => {
        if (recorder && recorder.state === "recording") {
          recorder.stop();
        }
      }, 2600);
    } catch (e) {
      console.warn("[LiveSub Offscreen] Slice recording error:", e);
    }
  }

  sliceAndSend();
  recordingInterval = setInterval(sliceAndSend, 2800);
}

function stopCapture() {
  isRecording = false;

  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
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
}
