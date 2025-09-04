// Service Worker for Chrome Extension
// Minimal background script - side panel is configured via manifest

console.log('Toolkit Co-pilot service worker started');

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed/updated:', details.reason);
  
  // Only try to set panel behavior if the API exists and supports it
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .then(() => console.log('Side panel behavior configured'))
      .catch((error) => console.log('Side panel behavior not supported:', error.message));
  }
});

// Handle runtime messages from the side panel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Message received:', request);
  
  if (request.action === 'checkAuth') {
    sendResponse({ status: 'ok' });
  }
  
  // Return true to indicate async response if needed
  return false;
});