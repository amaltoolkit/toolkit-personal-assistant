// Configuration
const APP_BASE = 'https://personalassistant-seven.vercel.app';
const LOCAL_BASE = 'http://localhost:3000';

// Use local backend if in development
const API_BASE = window.location.protocol === 'chrome-extension:' 
  ? APP_BASE 
  : LOCAL_BASE;

// Storage Keys
const SESSION_ID_KEY = 'bsa_session_id';
const LAST_ORG_ID_KEY = 'bsa_last_org_id';
const LAST_ORG_NAME_KEY = 'bsa_last_org_name';
const ONBOARDING_COMPLETED_KEY = 'bsa_onboarding_completed';

// State Management
let currentSessionId = null;
let currentOrgId = null;
let currentOrgName = null;
let organizations = [];
let chatMessages = [];
let isProcessing = false;

// DOM Elements - Cache references
let elements = {};

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  initializeApp();
});

// Cache DOM elements for performance
function cacheElements() {
  elements = {
    // Containers
    onboardingContainer: document.getElementById('onboarding-container'),
    chatContainer: document.getElementById('chat-container'),
    loadingOverlay: document.getElementById('loading-overlay'),
    
    // Onboarding screens
    welcomeScreen: document.getElementById('welcome-screen'),
    orgSelectionScreen: document.getElementById('org-selection-screen'),
    
    // Buttons
    getStartedBtn: document.getElementById('get-started-btn'),
    continueBtn: document.getElementById('continue-btn'),
    logoutBtn: document.getElementById('logout-btn'),
    sendBtn: document.getElementById('send-btn'),
    
    // Chat elements
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    
    // Organization elements
    orgList: document.getElementById('org-list'),
    orgDropdownBtn: document.getElementById('org-dropdown-btn'),
    orgDropdownMenu: document.getElementById('org-dropdown-menu'),
    orgDropdownList: document.getElementById('org-dropdown-list'),
    selectedOrgName: document.getElementById('selected-org-name'),
    
    // Loading and error elements
    orgLoading: document.getElementById('org-loading'),
    orgError: document.getElementById('org-error')
  };
  
  // Add event listeners
  setupEventListeners();
}

// Set up all event listeners
function setupEventListeners() {
  // Onboarding events
  elements.getStartedBtn?.addEventListener('click', handleGetStarted);
  elements.continueBtn?.addEventListener('click', handleContinue);
  
  // Chat events
  elements.sendBtn?.addEventListener('click', handleSendMessage);
  elements.chatInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  });
  
  // Organization dropdown
  elements.orgDropdownBtn?.addEventListener('click', toggleOrgDropdown);
  document.addEventListener('click', handleOutsideClick);
  
  // Logout
  elements.logoutBtn?.addEventListener('click', handleLogout);
}

// Initialize the application
async function initializeApp() {
  currentSessionId = getSessionId();
  const hasCompletedOnboarding = localStorage.getItem(ONBOARDING_COMPLETED_KEY) === 'true';
  
  // Check authentication status
  if (currentSessionId) {
    // First, do a quick check to see if re-auth is needed
    const statusResponse = await fetch(
      `${API_BASE}/auth/status?session_id=${encodeURIComponent(currentSessionId)}`
    );
    const statusData = await statusResponse.json();
    
    if (statusData.requiresReauth) {
      // Session expired, needs re-authentication
      console.log('[INIT] Session requires re-authentication');
      
      // Preserve organization selection
      const lastOrgId = localStorage.getItem(LAST_ORG_ID_KEY);
      const lastOrgName = localStorage.getItem(LAST_ORG_NAME_KEY);
      if (lastOrgId && lastOrgName) {
        currentOrgId = lastOrgId;
        currentOrgName = lastOrgName;
      }
      
      // Show appropriate screen and trigger re-auth
      if (hasCompletedOnboarding) {
        showChatInterface();
        await handleReauthentication();
      } else {
        handleGetStarted();
      }
    } else if (statusData.ok) {
      // User is authenticated
      const lastOrgId = localStorage.getItem(LAST_ORG_ID_KEY);
      const lastOrgName = localStorage.getItem(LAST_ORG_NAME_KEY);
      
      if (lastOrgId && lastOrgName) {
        // Has organization selected
        currentOrgId = lastOrgId;
        currentOrgName = lastOrgName;
        showChatInterface();
      } else {
        // Needs to select organization
        showOrgSelectionScreen();
        await loadOrganizations();
      }
    } else {
      // Not authenticated
      if (hasCompletedOnboarding) {
        // Show login directly for returning users
        handleGetStarted();
      } else {
        showWelcomeScreen();
      }
    }
  } else {
    // First time user
    showWelcomeScreen();
  }
}

// ============================================
// SCREEN NAVIGATION
// ============================================

function showWelcomeScreen() {
  hideAllScreens();
  elements.onboardingContainer.classList.remove('hidden');
  elements.welcomeScreen.classList.remove('hidden');
}

function showOrgSelectionScreen() {
  hideAllScreens();
  elements.onboardingContainer.classList.remove('hidden');
  elements.welcomeScreen.classList.add('hidden');
  elements.orgSelectionScreen.classList.remove('hidden');
}

function showChatInterface() {
  hideAllScreens();
  elements.chatContainer.classList.remove('hidden');
  updateOrgDisplay();
  
  // Focus on input
  setTimeout(() => {
    elements.chatInput?.focus();
  }, 100);
}

function hideAllScreens() {
  elements.onboardingContainer?.classList.add('hidden');
  elements.chatContainer?.classList.add('hidden');
}

// ============================================
// ONBOARDING FLOW
// ============================================

async function handleGetStarted() {
  try {
    showLoading(true);
    
    const sessionId = getSessionId();
    console.log('[ONBOARDING] Starting OAuth with session:', sessionId);
    
    const authUrl = `${API_BASE}/auth/start?session_id=${encodeURIComponent(sessionId)}`;
    
    // Open OAuth window
    const authWindow = window.open(
      authUrl,
      'BSA_Auth',
      'width=500,height=700,menubar=no,toolbar=no,location=no,status=no'
    );
    
    // Poll for authentication
    const authenticated = await pollAuthStatus(sessionId, 120000);
    
    if (authenticated) {
      console.log('[ONBOARDING] Authentication successful');
      currentSessionId = sessionId;
      localStorage.setItem(SESSION_ID_KEY, sessionId);
      localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
      
      // Move to organization selection
      showOrgSelectionScreen();
      await loadOrganizations();
    } else {
      showError('Authentication failed. Please try again.');
    }
  } catch (error) {
    console.error('[ONBOARDING] Error:', error);
    showError('Failed to authenticate. Please try again.');
  } finally {
    showLoading(false);
  }
}

async function handleContinue() {
  if (!currentOrgId || !currentOrgName) {
    showError('Please select an organization');
    return;
  }
  
  // Save organization selection
  localStorage.setItem(LAST_ORG_ID_KEY, currentOrgId);
  localStorage.setItem(LAST_ORG_NAME_KEY, currentOrgName);
  
  // Show chat interface
  showChatInterface();
}

// ============================================
// ORGANIZATION MANAGEMENT
// ============================================

async function loadOrganizations() {
  try {
    showLoading(true, 'org-loading');
    hideError('org-error');
    
    const response = await fetch(
      `${API_BASE}/api/orgs?session_id=${encodeURIComponent(currentSessionId)}`
    );
    
    if (!response.ok) {
      if (response.status === 401) {
        // Check if re-authentication is required
        const errorData = await response.json();
        if (errorData.requiresReauth) {
          showLoading(false, 'org-loading');
          
          // Trigger re-authentication
          const reAuthSuccess = await handleReauthentication();
          if (reAuthSuccess) {
            // Re-authentication successful, reload organizations
            await loadOrganizations();
          }
          return; // Exit early
        }
      }
      throw new Error('Failed to load organizations');
    }
    
    const data = await response.json();
    organizations = data.Organizations || data.organizations || data || [];
    
    displayOrganizations();
    populateOrgDropdown();
  } catch (error) {
    console.error('[ORGS] Error loading organizations:', error);
    showError('Failed to load organizations', 'org-error');
  } finally {
    showLoading(false, 'org-loading');
  }
}

function displayOrganizations() {
  const orgList = elements.orgList;
  if (!orgList) return;
  
  orgList.innerHTML = '';
  
  if (organizations.length === 0) {
    orgList.innerHTML = '<p class="error-message">No organizations found.</p>';
    return;
  }
  
  organizations.forEach(org => {
    const orgId = org.OrganizationId || org.Id || org.id;
    const orgName = org.Name || org.name || 'Unnamed Organization';
    
    const orgItem = document.createElement('div');
    orgItem.className = 'org-item-onboarding';
    orgItem.innerHTML = `
      <span class="org-name">${escapeHtml(orgName)}</span>
      <span class="org-id">ID: ${escapeHtml(orgId)}</span>
    `;
    
    orgItem.addEventListener('click', () => selectOrganization(orgId, orgName, orgItem));
    orgList.appendChild(orgItem);
  });
}

function selectOrganization(orgId, orgName, element) {
  // Update selection state
  currentOrgId = orgId;
  currentOrgName = orgName;
  
  // Update UI
  document.querySelectorAll('.org-item-onboarding').forEach(item => {
    item.classList.remove('selected');
  });
  
  if (element) {
    element.classList.add('selected');
  }
  
  // Enable continue button
  if (elements.continueBtn) {
    elements.continueBtn.classList.remove('hidden');
    elements.continueBtn.disabled = false;
  }
  
  // Update dropdown if in chat interface
  updateOrgDisplay();
}

function populateOrgDropdown() {
  const dropdownList = elements.orgDropdownList;
  if (!dropdownList) return;
  
  dropdownList.innerHTML = '';
  
  organizations.forEach(org => {
    const orgId = org.OrganizationId || org.Id || org.id;
    const orgName = org.Name || org.name || 'Unnamed Organization';
    
    const item = document.createElement('div');
    item.className = 'org-dropdown-item';
    if (orgId === currentOrgId) {
      item.classList.add('selected');
    }
    
    item.innerHTML = `
      <span class="org-dropdown-item-name">${escapeHtml(orgName)}</span>
      <span class="org-dropdown-item-id">ID: ${escapeHtml(orgId)}</span>
    `;
    
    item.addEventListener('click', () => {
      selectOrganization(orgId, orgName);
      toggleOrgDropdown();
      localStorage.setItem(LAST_ORG_ID_KEY, orgId);
      localStorage.setItem(LAST_ORG_NAME_KEY, orgName);
    });
    
    dropdownList.appendChild(item);
  });
}

function updateOrgDisplay() {
  if (elements.selectedOrgName && currentOrgName) {
    elements.selectedOrgName.textContent = currentOrgName;
  }
}

function toggleOrgDropdown() {
  const menu = elements.orgDropdownMenu;
  const btn = elements.orgDropdownBtn;
  
  if (menu.classList.contains('hidden')) {
    menu.classList.remove('hidden');
    btn.classList.add('active');
    
    // Load organizations if needed
    if (organizations.length === 0) {
      loadOrganizations();
    }
  } else {
    menu.classList.add('hidden');
    btn.classList.remove('active');
  }
}

function handleOutsideClick(event) {
  const container = elements.orgDropdownBtn?.parentElement;
  if (container && !container.contains(event.target)) {
    elements.orgDropdownMenu?.classList.add('hidden');
    elements.orgDropdownBtn?.classList.remove('active');
  }
}

// ============================================
// CHAT FUNCTIONALITY
// ============================================

async function handleSendMessage() {
  const message = elements.chatInput?.value.trim();
  if (!message || isProcessing) return;
  
  // Check prerequisites
  if (!currentSessionId) {
    showError('Please login first');
    return;
  }
  
  if (!currentOrgId) {
    addMessageToChat('Please select an organization first to continue.', false);
    return;
  }
  
  // Add user message to chat
  addMessageToChat(message, true);
  
  // Clear input
  elements.chatInput.value = '';
  
  // Show typing indicator
  const typingId = showTypingIndicator();
  
  try {
    isProcessing = true;
    elements.sendBtn.disabled = true;
    
    const response = await fetch(`${API_BASE}/api/orchestrator/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: message,
        session_id: currentSessionId,
        org_id: currentOrgId,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        // Check if re-authentication is required
        const errorData = await response.json();
        if (errorData.requiresReauth) {
          // Remove typing indicator before re-auth
          removeTypingIndicator(typingId);
          
          // Trigger re-authentication
          const reAuthSuccess = await handleReauthentication();
          if (reAuthSuccess) {
            // Re-authentication successful, prompt user to resend their message
            addMessageToChat('Please resend your message.', false);
          }
          return; // Exit early, don't process further
        }
        throw new Error('Session expired. Please login again.');
      }
      if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please wait a moment.');
      }
      throw new Error('Failed to process request');
    }
    
    const data = await response.json();
    
    // Remove typing indicator
    removeTypingIndicator(typingId);
    
    // Add assistant response
    const responseText = data.response || data.error || 'I couldn\'t process that request.';
    addMessageToChat(responseText, false);
    
  } catch (error) {
    console.error('[CHAT] Error:', error);
    removeTypingIndicator(typingId);
    addMessageToChat(error.message || 'Failed to process request. Please try again.', false);
  } finally {
    isProcessing = false;
    elements.sendBtn.disabled = false;
    elements.chatInput?.focus();
  }
}

function renderMarkdown(text) {
  try {
    // Configure marked options for better formatting
    marked.setOptions({
      breaks: true, // Convert line breaks to <br>
      gfm: true, // GitHub Flavored Markdown
      headerIds: false, // Don't add IDs to headers
      mangle: false, // Don't mangle email addresses
    });
    
    // Parse markdown to HTML
    const rawHtml = marked.parse(text);
    
    // Sanitize HTML to prevent XSS
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'strong', 'em', 
                     'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'hr'],
      ALLOWED_ATTR: ['href', 'target', 'rel'],
      FORCE_BODY: true,
      ADD_ATTR: ['target'], // Allow target attribute for links
    });
    
    return cleanHtml;
  } catch (error) {
    console.error('[MARKDOWN] Parsing error:', error);
    // Fallback to escaped text if parsing fails
    return escapeHtml(text);
  }
}

function addMessageToChat(text, isUser = false) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;
  
  const bubbleDiv = document.createElement('div');
  bubbleDiv.className = 'message-bubble';
  
  // Process text for display
  if (!isUser) {
    // Render markdown for assistant messages
    bubbleDiv.innerHTML = renderMarkdown(text);
  } else {
    // User messages remain as plain text
    bubbleDiv.textContent = text;
  }
  
  messageDiv.appendChild(bubbleDiv);
  elements.chatMessages?.appendChild(messageDiv);
  
  // Store in memory
  chatMessages.push({ text, isUser, timestamp: new Date() });
  
  // Scroll to bottom
  scrollToBottom();
}

function showTypingIndicator() {
  const id = 'typing-' + Date.now();
  const typingDiv = document.createElement('div');
  typingDiv.id = id;
  typingDiv.className = 'message assistant-message';
  typingDiv.innerHTML = `
    <div class="typing-indicator">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>
  `;
  
  elements.chatMessages?.appendChild(typingDiv);
  scrollToBottom();
  
  return id;
}

function removeTypingIndicator(id) {
  const element = document.getElementById(id);
  element?.remove();
}

function scrollToBottom() {
  if (elements.chatMessages) {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }
}

// ============================================
// AUTHENTICATION HELPERS
// ============================================

function getSessionId() {
  let sessionId = localStorage.getItem(SESSION_ID_KEY);
  if (!sessionId) {
    sessionId = generateSessionId();
    localStorage.setItem(SESSION_ID_KEY, sessionId);
  }
  return sessionId;
}

function generateSessionId() {
  return 'sid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

async function checkAuthStatus() {
  try {
    const response = await fetch(
      `${API_BASE}/auth/status?session_id=${encodeURIComponent(currentSessionId)}`
    );
    const data = await response.json();
    
    // Check if re-authentication is required
    if (data.requiresReauth) {
      console.log('[AUTH] Re-authentication required');
      return false;
    }
    
    return data.ok === true;
  } catch (error) {
    console.error('[AUTH] Check failed:', error);
    return false;
  }
}

// Handle re-authentication when session expires
async function handleReauthentication() {
  console.log('[REAUTH] Starting re-authentication process');
  
  // Show re-authentication message
  const reAuthMessage = 'Your session has expired. Re-authenticating...';
  if (!elements.chatContainer?.classList.contains('hidden')) {
    addMessageToChat(reAuthMessage, false);
  } else {
    showError(reAuthMessage);
  }
  
  try {
    showLoading(true);
    
    const sessionId = currentSessionId || getSessionId();
    console.log('[REAUTH] Using session:', sessionId);
    
    const authUrl = `${API_BASE}/auth/start?session_id=${encodeURIComponent(sessionId)}`;
    
    // Open OAuth window for re-authentication
    const authWindow = window.open(
      authUrl,
      'BSA_ReAuth',
      'width=500,height=700,menubar=no,toolbar=no,location=no,status=no'
    );
    
    // Poll for authentication with longer timeout for re-auth
    const authenticated = await pollAuthStatus(sessionId, 180000); // 3 minutes
    
    if (authenticated) {
      console.log('[REAUTH] Re-authentication successful');
      
      // Update session ID if needed
      currentSessionId = sessionId;
      localStorage.setItem(SESSION_ID_KEY, sessionId);
      
      // Restore previous state
      if (currentOrgId && currentOrgName) {
        // User was in chat, show success message
        addMessageToChat('✓ Re-authenticated successfully. You can continue your conversation.', false);
        
        // Re-enable chat input
        if (elements.sendBtn) {
          elements.sendBtn.disabled = false;
        }
        if (elements.chatInput) {
          elements.chatInput.disabled = false;
          elements.chatInput.focus();
        }
      } else {
        // User needs to select organization again
        showOrgSelectionScreen();
        await loadOrganizations();
      }
      
      return true;
    } else {
      showError('Re-authentication failed. Please refresh the page and try again.');
      return false;
    }
  } catch (error) {
    console.error('[REAUTH] Error:', error);
    showError('Failed to re-authenticate. Please refresh the page and try again.');
    return false;
  } finally {
    showLoading(false);
  }
}

async function pollAuthStatus(sessionId, timeoutMs = 60000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(
        `${API_BASE}/auth/status?session_id=${encodeURIComponent(sessionId)}`
      );
      const data = await response.json();
      
      if (data.ok === true) {
        return true;
      }
      
      if (data.expired) {
        return false;
      }
    } catch (error) {
      console.error('[AUTH] Poll error:', error);
    }
    
    await sleep(1000);
  }
  
  return false;
}

async function handleLogout() {
  // Clear all data
  localStorage.removeItem(SESSION_ID_KEY);
  localStorage.removeItem(LAST_ORG_ID_KEY);
  localStorage.removeItem(LAST_ORG_NAME_KEY);
  
  currentSessionId = null;
  currentOrgId = null;
  currentOrgName = null;
  organizations = [];
  chatMessages = [];
  
  // Reset UI
  showWelcomeScreen();
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function showLoading(show, elementId = null) {
  if (elementId) {
    const element = document.getElementById(elementId);
    if (element) {
      if (show) {
        element.classList.remove('hidden');
      } else {
        element.classList.add('hidden');
      }
    }
  } else {
    // Use overlay
    if (show) {
      elements.loadingOverlay?.classList.remove('hidden');
    } else {
      elements.loadingOverlay?.classList.add('hidden');
    }
  }
}

function showError(message, elementId = null) {
  if (elementId) {
    const element = document.getElementById(elementId);
    if (element) {
      element.textContent = message;
      element.classList.remove('hidden');
    }
  } else {
    // Add to chat if in chat interface
    if (!elements.chatContainer?.classList.contains('hidden')) {
      addMessageToChat(`Error: ${message}`, false);
    } else {
      alert(message);
    }
  }
}

function hideError(elementId) {
  const element = document.getElementById(elementId);
  element?.classList.add('hidden');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}