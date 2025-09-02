// Configuration
const APP_BASE = 'https://personalassistant-seven.vercel.app';
const LOCAL_BASE = 'http://localhost:3000';  // For local development
const SESSION_ID_KEY = 'bsa_session_id';
const LAST_ORG_ID_KEY = 'bsa_last_org_id';
const LAST_ORG_NAME_KEY = 'bsa_last_org_name';

// Use local backend if in development
const API_BASE = window.location.protocol === 'chrome-extension:' 
  ? APP_BASE 
  : LOCAL_BASE;

// DOM Elements
const loginSection = document.getElementById('login-section');
const authSection = document.getElementById('auth-section');
const orgSection = document.getElementById('org-section');
// Removed: contactsSection - deprecated with contacts feature
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
// Removed: backToOrgsBtn - deprecated with contacts feature
const statusIndicator = document.getElementById('connection-status');

// State
let currentSessionId = null;
let currentOrgId = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initializeApp();
});

// Event Listeners
loginBtn.addEventListener('click', handleLogin);
logoutBtn.addEventListener('click', handleLogout);
// Removed: backToOrgsBtn listener - deprecated with contacts feature

// Initialization
async function initializeApp() {
  currentSessionId = getSessionId();
  
  if (currentSessionId) {
    const isAuthenticated = await checkAuthStatus();
    if (isAuthenticated) {
      showAuthenticatedView();
      await loadOrganizations();
      
      // Restore last selected organization if available
      const lastOrgId = localStorage.getItem(LAST_ORG_ID_KEY);
      const lastOrgName = localStorage.getItem(LAST_ORG_NAME_KEY);
      if (lastOrgId && lastOrgName) {
        console.log('[SIDEPANEL] Restoring last selected org:', lastOrgId, lastOrgName);
        // Restore the organization selection for AI assistant
        currentOrgId = lastOrgId;
        
        // After organizations load, update UI for restored selection
        setTimeout(() => {
          const orgItems = document.querySelectorAll('.org-item');
          const selectedItem = Array.from(orgItems).find(item => 
            item.dataset.orgId === lastOrgId
          );
          if (selectedItem) {
            selectedItem.classList.add('selected');
          }
          const selectedIndicator = document.getElementById('selected-org-indicator');
          if (selectedIndicator) {
            selectedIndicator.textContent = `Selected: ${lastOrgName}`;
            selectedIndicator.classList.remove('hidden');
          }
        }, 100);
      }
    } else {
      showLoginView();
    }
  } else {
    showLoginView();
  }
}

// Session Management
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

function clearSession() {
  localStorage.removeItem(SESSION_ID_KEY);
  localStorage.removeItem(LAST_ORG_ID_KEY);
  localStorage.removeItem(LAST_ORG_NAME_KEY);
  currentSessionId = null;
  currentOrgId = null;
}

// Authentication
async function handleLogin() {
  try {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Connecting...';
    
    const sessionId = getSessionId();
    console.log('[SIDEPANEL] Starting login with session:', sessionId);
    
    const authUrl = `${API_BASE}/auth/start?session_id=${encodeURIComponent(sessionId)}`;
    console.log('[SIDEPANEL] Auth URL:', authUrl);
    
    // Open OAuth window
    const authWindow = window.open(
      authUrl,
      'BSA_Auth',
      'width=500,height=700,menubar=no,toolbar=no,location=no,status=no'
    );
    
    console.log('[SIDEPANEL] OAuth window opened, starting polling');
    
    // Poll for authentication completion
    const authenticated = await pollAuthStatus(sessionId, 120000);  // 2 minute timeout
    
    if (authenticated) {
      console.log('[SIDEPANEL] Authentication successful');
      currentSessionId = sessionId;  // Store the session ID globally
      localStorage.setItem(SESSION_ID_KEY, sessionId);     // Persist to localStorage
      console.log('[SIDEPANEL] Session ID stored:', sessionId);
      showAuthenticatedView();
      await loadOrganizations();
    } else {
      console.error('[SIDEPANEL] Authentication timeout or failed');
      showError('Authentication timeout. Please try again.');
    }
  } catch (error) {
    console.error('[SIDEPANEL] Login error:', error);
    showError('Failed to authenticate. Please try again.');
  } finally {
    loginBtn.disabled = false;
    loginBtn.innerHTML = '<span class="btn-icon">🔐</span>Login with BlueSquareApps';
  }
}

async function handleLogout() {
  clearSession();
  showLoginView();
}

async function checkAuthStatus() {
  try {
    const response = await fetch(
      `${API_BASE}/auth/status?session_id=${encodeURIComponent(currentSessionId)}`
    );
    const data = await response.json();
    return data.ok === true;
  } catch (error) {
    console.error('Auth check error:', error);
    return false;
  }
}

async function pollAuthStatus(sessionId, timeoutMs = 60000) {
  const startTime = Date.now();
  let pollCount = 0;
  
  console.log('[SIDEPANEL] Starting auth status polling');
  
  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    try {
      const statusUrl = `${API_BASE}/auth/status?session_id=${encodeURIComponent(sessionId)}`;
      console.log(`[SIDEPANEL] Poll #${pollCount} - checking:`, statusUrl);
      
      const response = await fetch(statusUrl);
      const data = await response.json();
      
      console.log(`[SIDEPANEL] Poll #${pollCount} response:`, data);
      
      if (data.ok === true) {
        console.log('[SIDEPANEL] Authentication confirmed!');
        return true;
      }
      
      if (data.expired) {
        console.error('[SIDEPANEL] Session expired');
        showError('Your session has expired. Please login again.');
        return false;
      }
    } catch (error) {
      console.error(`[SIDEPANEL] Poll #${pollCount} error:`, error);
    }
    
    // Wait 1 second before next poll
    await sleep(1000);
  }
  
  console.error('[SIDEPANEL] Polling timeout reached');
  return false;
}

// Data Loading
async function loadOrganizations() {
  try {
    console.log('[SIDEPANEL] Loading organizations for session:', currentSessionId);
    showLoading('org-loading', true);
    hideError('org-error');
    
    const url = `${API_BASE}/api/orgs?session_id=${encodeURIComponent(currentSessionId)}`;
    console.log('[SIDEPANEL] Fetching organizations from:', url);
    
    const response = await fetch(url);
    
    console.log('[SIDEPANEL] Organizations response status:', response.status);
    console.log('[SIDEPANEL] Organizations response headers:', response.headers);
    
    if (!response.ok) {
      // Try to get error details from response
      let errorDetails = '';
      try {
        const errorData = await response.json();
        errorDetails = JSON.stringify(errorData);
        console.error('[SIDEPANEL] Organizations error response:', errorData);
      } catch (e) {
        // If not JSON, try text
        try {
          errorDetails = await response.text();
          console.error('[SIDEPANEL] Organizations error text:', errorDetails);
        } catch (e2) {
          console.error('[SIDEPANEL] Could not parse error response');
        }
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorDetails}`);
    }
    
    const orgs = await response.json();
    console.log('[SIDEPANEL] Organizations received:', orgs);
    console.log('[SIDEPANEL] Organizations type:', typeof orgs);
    console.log('[SIDEPANEL] Response keys:', orgs ? Object.keys(orgs) : 'null');
    
    // Check if response is valid
    if (orgs && orgs.Valid === false) {
      console.error('[SIDEPANEL] BSA API returned Valid=false:', orgs.ResponseMessage);
      throw new Error(orgs.ResponseMessage || 'Invalid response from server');
    }
    
    // Extract the Organizations array from the response object
    const orgArray = orgs.Organizations || orgs.organizations || orgs;
    console.log('[SIDEPANEL] Extracted organizations array:', orgArray);
    console.log('[SIDEPANEL] Is array?', Array.isArray(orgArray));
    
    if (!Array.isArray(orgArray)) {
      console.error('[SIDEPANEL] Expected array, got:', typeof orgArray);
      console.error('[SIDEPANEL] Full response:', orgs);
      throw new Error('Invalid organizations data format');
    }
    
    console.log('[SIDEPANEL] Organizations count:', orgArray.length);
    if (orgArray.length > 0) {
      console.log('[SIDEPANEL] First org structure:', orgArray[0]);
    }
    
    displayOrganizations(orgArray);
  } catch (error) {
    console.error('[SIDEPANEL] Load orgs error:', error);
    console.error('[SIDEPANEL] Error stack:', error.stack);
    showError('Failed to load organizations. Please try again.', 'org-error');
  } finally {
    showLoading('org-loading', false);
  }
}

// Function to select an organization for AI assistant
function selectOrganization(orgId, orgName) {
  currentOrgId = orgId;
  
  // Persist organization selection to localStorage
  localStorage.setItem(LAST_ORG_ID_KEY, orgId);
  localStorage.setItem(LAST_ORG_NAME_KEY, orgName);
  console.log('[SIDEPANEL] Selected organization:', orgId, orgName);
  
  // Update UI to show selected org
  const orgItems = document.querySelectorAll('.org-item');
  orgItems.forEach(item => item.classList.remove('selected'));
  
  // Find and highlight the selected item
  const selectedItem = Array.from(orgItems).find(item => 
    item.dataset.orgId === orgId
  );
  if (selectedItem) {
    selectedItem.classList.add('selected');
  }
  
  // Show selection feedback
  const selectedIndicator = document.getElementById('selected-org-indicator');
  if (selectedIndicator) {
    selectedIndicator.textContent = `Selected: ${orgName}`;
    selectedIndicator.classList.remove('hidden');
  }
}

// Display Functions
function displayOrganizations(orgs) {
  const orgList = document.getElementById('org-list');
  orgList.innerHTML = '';
  
  if (!orgs || orgs.length === 0) {
    orgList.innerHTML = '<p class="error-message">No organizations found.</p>';
    return;
  }
  
  orgs.forEach(org => {
    const orgId = org.Id || org.id || org.ID;
    const orgName = org.Name || org.name || org.title || 'Unnamed Organization';
    
    const orgItem = document.createElement('div');
    orgItem.className = 'org-item';
    orgItem.innerHTML = `
      <div class="org-name">${escapeHtml(orgName)}</div>
      <div class="org-id">ID: ${escapeHtml(orgId)}</div>
    `;
    orgItem.dataset.orgId = orgId; // Store orgId for selection
    orgItem.addEventListener('click', () => selectOrganization(orgId, orgName));
    
    orgList.appendChild(orgItem);
  });
}

// [REMOVED: displayContacts function - deprecated with contacts feature]
// Users can now query contacts through the AI assistant chat interface

// View Management
function showLoginView() {
  loginSection.classList.remove('hidden');
  authSection.classList.add('hidden');
  statusIndicator.classList.add('offline');
}

function showAuthenticatedView() {
  loginSection.classList.add('hidden');
  authSection.classList.remove('hidden');
  statusIndicator.classList.remove('offline');
  showOrganizations();
}

function showOrganizations() {
  orgSection.classList.remove('hidden');
  // Keep currentOrgId if already selected
}

// [REMOVED: showContactsView function - deprecated with contacts feature]

// UI Helpers
function showLoading(elementId, show) {
  const element = document.getElementById(elementId);
  if (element) {
    if (show) {
      element.classList.remove('hidden');
    } else {
      element.classList.add('hidden');
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
    alert(message);
  }
}

function hideError(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    element.classList.add('hidden');
  }
}

// Utility Functions
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

// ============================================
// AI ASSISTANT FUNCTIONALITY
// ============================================
function initAssistant() {
  const queryInput = document.getElementById('query-input');
  const querySubmit = document.getElementById('query-submit');
  const responseContainer = document.getElementById('response-container');
  const responseContent = document.getElementById('response-content');
  const responseLoading = document.getElementById('response-loading');
  
  if (!queryInput || !querySubmit) {
    console.log('[ASSISTANT] Elements not found, skipping initialization');
    return;
  }
  
  querySubmit.addEventListener('click', handleAssistantQuery);
  queryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleAssistantQuery();
    }
  });
  
  async function handleAssistantQuery() {
    const query = queryInput.value.trim();
    if (!query) return;
    
    const sessionId = getSessionId();
    const orgId = currentOrgId;
    
    if (!sessionId) {
      showError('Please login first');
      return;
    }
    
    // Check if organization is selected
    if (!orgId) {
      showError('Please select an organization first', 'response-content');
      responseContainer.classList.remove('hidden');
      // Optionally show the org selection UI
      if (orgSection) {
        orgSection.classList.remove('hidden');
      }
      return;
    }
    
    responseContainer.classList.remove('hidden');
    showLoading('response-loading', true);
    responseContent.innerHTML = '';
    
    try {
      console.log('[ASSISTANT] Sending query:', query);
      const response = await fetch(`${API_BASE}/api/assistant/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          session_id: sessionId,
          org_id: orgId
        })
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          showError('Session expired. Please login again.', 'response-content');
          return;
        }
        if (response.status === 400) {
          const errorData = await response.json();
          if (errorData.error === 'Please select an organization first') {
            showError('Please select an organization first', 'response-content');
            if (orgSection) {
              orgSection.classList.remove('hidden');
            }
            return;
          }
          showError(errorData.error || 'Invalid request', 'response-content');
          return;
        }
        if (response.status === 429) {
          showError('Rate limit exceeded. Please wait a minute and try again.', 'response-content');
          return;
        }
        throw new Error('Request failed');
      }
      
      const data = await response.json();
      console.log('[ASSISTANT] Response received:', data);
      
      responseContent.innerHTML = `
        <div class="assistant-response">
          ${formatAssistantResult(data)}
        </div>
      `;
      
    } catch (error) {
      console.error('[ASSISTANT] Error:', error);
      showError('Failed to process request. Please try again.', 'response-content');
    } finally {
      showLoading('response-loading', false);
      queryInput.value = '';
    }
  }
  
  function formatAssistantResult(data) {
    if (data.error) {
      return `<span class="error">${escapeHtml(data.error)}</span>`;
    }
    if (data.response) {
      // Agent response is already formatted
      return escapeHtml(data.response);
    }
    // Fallback for raw data
    return `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }
}

// Initialize assistant on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAssistant);
} else {
  initAssistant();
}