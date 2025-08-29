// Service Worker for Chrome Extension
// Handles background tasks and side panel management

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Set up side panel behavior
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Listen for extension installation or update
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('BlueSquare Assistant extension installed');
    // Optionally open onboarding page
    chrome.tabs.create({
      url: chrome.runtime.getURL('sidepanel.html')
    });
  } else if (details.reason === 'update') {
    console.log('BlueSquare Assistant extension updated to version', chrome.runtime.getManifest().version);
  }
});

// Handle any runtime messages if needed
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkAuth') {
    // Could implement additional auth checks here
    sendResponse({ status: 'ok' });
  } else if (request.action === 'openSidePanel') {
    chrome.sidePanel.open({ windowId: sender.tab.windowId });
    sendResponse({ status: 'opened' });
  }
  return true;  // Will respond asynchronously
});

// Keep service worker alive if needed
const keepAlive = () => setInterval(chrome.runtime.getPlatformInfo, 20e3);
chrome.runtime.onStartup.addListener(keepAlive);
keepAlive();