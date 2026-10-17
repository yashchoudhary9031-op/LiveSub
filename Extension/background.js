// background.js - LiveSub Service Worker (Manifest V3)

let isCapturing = false;
let capturedTabId = null;

chrome.runtime.onInstalled.addListener(() => {
  console.log("[LiveSub] Extension installed successfully.");
  chrome.storage.local.set({
    enabled: false,
    targetLang: "hi",
    langHint: "",
    subMode: "audio_stt",
    fontSize: "22px",
  });
});

// Ensure the offscreen document is created
async function setupOffscreenDocument() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Real-time tab audio capture for live speech-to-text",
      });
      console.log("[LiveSub] Offscreen document created");
    }
  }
}

// Start tab audio capture session
async function startSession(settings, preferredTab = null) {
  try {
    let activeTab = preferredTab;
    if (!activeTab || !activeTab.id) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs.length > 0) {
        activeTab = tabs[0];
      }
    }

    if (!activeTab || !activeTab.id) return;

    // Ensure tab is a YouTube tab or valid URL
    if (activeTab.url && !activeTab.url.includes("youtube.com")) return;

    if (isCapturing && capturedTabId === activeTab.id) {
      // If already capturing for this tab, seamlessly update target language / hint
      chrome.runtime.sendMessage({
        action: "UPDATE_CONFIG",
        targetLang: settings.targetLang || "hi",
        langHint: settings.langHint || "",
        targetTabId: activeTab.id,
      }).catch(() => {});
      return;
    }

    // If capturing on a different tab, stop old session first
    if (isCapturing) {
      stopSession();
      await new Promise((r) => setTimeout(r, 200));
    }

    await setupOffscreenDocument();
    await new Promise((r) => setTimeout(r, 100));

    // Get real tab audio stream ID
    const streamId = await new Promise((resolve) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (id) => {
        resolve(id);
      });
    });

    if (!streamId) {
      console.warn("[LiveSub] Could not acquire tab audio streamId for tab", activeTab.id);
      return;
    }

    // Send streamId to offscreen document to start streaming
    chrome.runtime.sendMessage({
      action: "START_TAB_CAPTURE",
      streamId: streamId,
      targetTabId: activeTab.id,
      targetLang: settings.targetLang || "hi",
      langHint: settings.langHint || "",
    });

    isCapturing = true;
    capturedTabId = activeTab.id;
    console.log("[LiveSub] Session started for tab", activeTab.id);
  } catch (err) {
    console.error("[LiveSub] startSession failed:", err);
  }
}

// Stop audio capture session
function stopSession() {
  chrome.runtime.sendMessage({ action: "STOP_TAB_CAPTURE" }).catch(() => {});
  isCapturing = false;
  capturedTabId = null;
  console.log("[LiveSub] Session stopped");
}

// Clean up when tab navigates or closes
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && isCapturing && capturedTabId === tabId) {
    stopSession();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (isCapturing && capturedTabId === tabId) {
    stopSession();
  }
});

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "START_AUDIO_SESSION") {
    const tab = sender.tab || null;
    startSession(request.settings, tab);
    sendResponse({ status: "ok" });
  } else if (request.action === "STOP_AUDIO_SESSION") {
    stopSession();
    sendResponse({ status: "ok" });
  } else if (request.action === "GET_TAB_STREAM_ID" && sender.tab) {
    chrome.tabCapture.getMediaStreamId({ targetTabId: sender.tab.id }, (streamId) => {
      sendResponse({ streamId: streamId });
    });
    return true;
  }
});
