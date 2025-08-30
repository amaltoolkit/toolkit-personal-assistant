// Configuration
const APP_BASE = 'https://personalassistant-seven.vercel.app';
const LOCAL_BASE = 'http://localhost:3000';  // For local development
const SESSION_ID_KEY = 'bsa_session_id';

// Use local backend if in development
const API_BASE = window.location.protocol === 'chrome-extension:' 
  ? APP_BASE 
  : LOCAL_BASE;

// DOM Elements
const loginSection = document.getElementById('login-section');
const authSection = document.getElementById('auth-section');
const orgSection = document.getElementById('org-section');
const contactsSection = document.getElementById('contacts-section');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const backToOrgsBtn = document.getElementById('back-to-orgs');
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
backToOrgsBtn.addEventListener('click', showOrganizations);

// Initialization
async function initializeApp() {
  currentSessionId = getSessionId();
  
  if (currentSessionId) {
    const isAuthenticated = await checkAuthStatus();
    if (isAuthenticated) {
      showAuthenticatedView();
      await loadOrganizations();
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
      storeSessionId(sessionId);     // Persist to localStorage
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

async function loadContacts(orgId, orgName) {
  try {
    currentOrgId = orgId;
    showContactsView(orgName);
    showLoading('contacts-loading', true);
    hideError('contacts-error');
    
    const response = await fetch(
      `${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/contacts?session_id=${encodeURIComponent(currentSessionId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log('[SIDEPANEL] Contacts data received:', data);
    console.log('[SIDEPANEL] Contacts data keys:', data ? Object.keys(data) : 'null');
    displayContacts(data);
  } catch (error) {
    console.error('Load contacts error:', error);
    showError('Failed to load contacts. Please try again.', 'contacts-error');
  } finally {
    showLoading('contacts-loading', false);
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
    orgItem.addEventListener('click', () => loadContacts(orgId, orgName));
    
    orgList.appendChild(orgItem);
  });
}

function displayContacts(data) {
  const contactsList = document.getElementById('contacts-list');
  contactsList.innerHTML = '';
  
  // Handle different response formats - check PascalCase first (BSA API convention)
  const contacts = data.Items || data.Contacts || data.Results || 
                   data.items || data.results || data.contacts || data;
  
  console.log('[SIDEPANEL] Extracted contacts:', contacts);
  console.log('[SIDEPANEL] Is contacts array?', Array.isArray(contacts));
  
  if (!Array.isArray(contacts)) {
    console.error('[SIDEPANEL] Expected contacts array, got:', typeof contacts);
    console.error('[SIDEPANEL] Full contacts response:', data);
    contactsList.innerHTML = '<p class="error-message">Invalid contacts data format.</p>';
    return;
  }
  
  if (contacts.length === 0) {
    contactsList.innerHTML = '<p class="error-message">No contacts found for this organization.</p>';
    return;
  }
  
  console.log('[SIDEPANEL] Displaying', contacts.length, 'contacts');
  
  contacts.forEach(contact => {
    const contactItem = document.createElement('div');
    contactItem.className = 'contact-item';
    
    // Extract contact details with multiple fallbacks
    const name = contact.Name || contact.name || 
                 `${contact.FirstName || contact.firstName || ''} ${contact.LastName || contact.lastName || ''}`.trim() ||
                 'Unnamed Contact';
    const email = contact.Email || contact.email || contact.EmailAddress || '';
    const phone = contact.Phone || contact.phone || contact.PhoneNumber || '';
    const company = contact.Company || contact.company || contact.Organization || '';
    
    let detailsHtml = '';
    if (email) detailsHtml += `<span class="contact-email">📧 ${escapeHtml(email)}</span>`;
    if (phone) detailsHtml += `<span class="contact-phone">📱 ${escapeHtml(phone)}</span>`;
    if (company) detailsHtml += `<span class="contact-company">🏢 ${escapeHtml(company)}</span>`;
    
    contactItem.innerHTML = `
      <div class="contact-name">${escapeHtml(name)}</div>
      ${detailsHtml ? `<div class="contact-details">${detailsHtml}</div>` : ''}
    `;
    
    contactsList.appendChild(contactItem);
  });
}

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
  contactsSection.classList.add('hidden');
  currentOrgId = null;
}

function showContactsView(orgName) {
  orgSection.classList.add('hidden');
  contactsSection.classList.remove('hidden');
  
  const selectedOrg = document.getElementById('selected-org');
  selectedOrg.innerHTML = `<strong>Organization:</strong> ${escapeHtml(orgName)}`;
}

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