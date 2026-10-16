// background.js - LiveSub Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(() => {
  console.log("[LiveSub] Extension installed successfully.");
  // Initialize default configuration
  chrome.storage.local.set({
    enabled: false,
    targetLang: "en",
    langHint: "",
    subMode: "audio_stt",
    fontSize: "22px",
  });
});

// Handle tab audio capture requests from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GET_TAB_STREAM_ID") {
    if (chrome.tabCapture && chrome.tabCapture.getMediaStreamId && sender.tab) {
      chrome.tabCapture.getMediaStreamId({ targetTabId: sender.tab.id }, (streamId) => {
        sendResponse({ streamId: streamId });
      });
      return true; // Keep message port open for async response
    } else {
      sendResponse({ streamId: null });
    }
  }
});
