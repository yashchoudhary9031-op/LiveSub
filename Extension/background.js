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
