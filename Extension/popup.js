// popup.js - LiveSub extension control panel logic

const BACKEND_URL = "http://localhost:8000";

const elements = {
  backendStatus: document.getElementById("backendStatus"),
  enabledToggle: document.getElementById("enabledToggle"),
  targetLang: document.getElementById("targetLang"),
  langHint: document.getElementById("langHint"),
  subMode: document.getElementById("subMode"),
  fontSize: document.getElementById("fontSize"),
  exportFormat: document.getElementById("exportFormat"),
  exportButton: document.getElementById("exportButton"),
  exportStatus: document.getElementById("exportStatus"),
  footerStatus: document.getElementById("footerStatus"),
};

function formatSrtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const remainingSeconds = Math.floor((milliseconds % 60000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

function createSubtitleFile(subtitles, format) {
  if (format === "txt") {
    return subtitles.map((cue) => cue.translation).join("\r\n");
  }

  return subtitles.map((cue, index) =>
    `${index + 1}\r\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\r\n${cue.translation}`
  ).join("\r\n\r\n");
}

function sanitizeFilename(title) {
  return title.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "LiveSub subtitles";
}

async function exportSubtitles() {
  elements.exportStatus.textContent = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Open a YouTube video first.");

    const result = await chrome.tabs.sendMessage(tab.id, { action: "EXPORT_SUBTITLES" });
    if (!result?.subtitles?.length) {
      elements.exportStatus.textContent = "No subtitles captured yet.";
      return;
    }

    const format = elements.exportFormat.value;
    const content = createSubtitleFile(result.subtitles, format);
    const blob = new Blob([content], { type: format === "srt" ? "application/x-subrip;charset=utf-8" : "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sanitizeFilename(result.title)}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
    elements.exportStatus.textContent = `Exported ${result.subtitles.length} subtitle cues.`;
  } catch (error) {
    elements.exportStatus.textContent = error.message || "Could not export subtitles.";
  }
}

// 1. Check backend health on open
async function checkBackendHealth() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`);
    if (res.ok) {
      const data = await res.json();
      elements.backendStatus.textContent = "Online";
      elements.backendStatus.className = "status-badge online";
      elements.footerStatus.textContent = `Backend: ${data.stt_provider} / ${data.translate_provider}`;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    elements.backendStatus.textContent = "Offline";
    elements.backendStatus.className = "status-badge offline";
    elements.footerStatus.textContent = "Run: python -m uvicorn main:app on 8000";
  }
}

// 2. Load stored settings
function loadSettings() {
  chrome.storage.local.get(
    {
      enabled: false,
      targetLang: "hi",
      langHint: "",
      subMode: "auto",
      fontSize: "22px",
    },
    (settings) => {
      elements.enabledToggle.checked = settings.enabled;
      elements.targetLang.value = settings.targetLang;
      elements.langHint.value = settings.langHint;
      elements.subMode.value = settings.subMode || "auto";
      elements.fontSize.value = settings.fontSize;
    }
  );
}

// 3. Save settings & notify background + active tab
function saveSettings() {
  const settings = {
    enabled: elements.enabledToggle.checked,
    targetLang: elements.targetLang.value,
    langHint: elements.langHint.value,
    subMode: elements.subMode.value,
    fontSize: elements.fontSize.value,
  };

  chrome.storage.local.set(settings, () => {
    // Notify background audio session
    if (settings.enabled && (settings.subMode === "audio_stt" || settings.subMode === "auto")) {
      chrome.runtime.sendMessage({ action: "START_AUDIO_SESSION", settings: settings }).catch(() => {});
    } else {
      chrome.runtime.sendMessage({ action: "STOP_AUDIO_SESSION" }).catch(() => {});
    }

    // Notify active YouTube tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: "SETTINGS_CHANGED",
          settings: settings,
        }).catch(() => {});
      }
    });
  });
}

// Attach event listeners
elements.enabledToggle.addEventListener("change", saveSettings);
elements.targetLang.addEventListener("change", saveSettings);
elements.langHint.addEventListener("change", saveSettings);
elements.subMode.addEventListener("change", saveSettings);
elements.fontSize.addEventListener("change", saveSettings);
elements.exportButton.addEventListener("click", exportSubtitles);

// Initial execution
document.addEventListener("DOMContentLoaded", () => {
  checkBackendHealth();
  loadSettings();
});
