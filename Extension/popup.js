// popup.js - LiveSub extension control panel logic

const BACKEND_URL = "http://localhost:8000";

const elements = {
  backendStatus: document.getElementById("backendStatus"),
  enabledToggle: document.getElementById("enabledToggle"),
  targetLang: document.getElementById("targetLang"),
  langHint: document.getElementById("langHint"),
  subMode: document.getElementById("subMode"),
  fontSize: document.getElementById("fontSize"),
  footerStatus: document.getElementById("footerStatus"),
};

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
      targetLang: "en",
      langHint: "",
      subMode: "audio_stt",
      fontSize: "22px",
    },
    (settings) => {
      elements.enabledToggle.checked = settings.enabled;
      elements.targetLang.value = settings.targetLang;
      elements.langHint.value = settings.langHint;
      elements.subMode.value = settings.subMode;
      elements.fontSize.value = settings.fontSize;
    }
  );
}

// 3. Save settings & notify active tab
function saveSettings() {
  const settings = {
    enabled: elements.enabledToggle.checked,
    targetLang: elements.targetLang.value,
    langHint: elements.langHint.value,
    subMode: elements.subMode.value,
    fontSize: elements.fontSize.value,
  };

  chrome.storage.local.set(settings, () => {
    // Notify active YouTube tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: "SETTINGS_CHANGED",
          settings: settings,
        }).catch(() => {
          // Tab may not be YouTube or content script not yet injected
        });
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

// Initial execution
document.addEventListener("DOMContentLoaded", () => {
  checkBackendHealth();
  loadSettings();
});
