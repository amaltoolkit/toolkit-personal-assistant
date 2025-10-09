// Configuration
const APP_BASE = 'https://personalassistant-seven.vercel.app';
const LOCAL_BASE = 'http://localhost:3000';

// Use local backend if in development
const API_BASE = window.location.protocol === 'chrome-extension:' 
  ? APP_BASE 
  : LOCAL_BASE;

// Feature flag for V2 architecture
const USE_V2_ARCHITECTURE = true; // Set to true to use V2 coordinator architecture

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
  initInterruptWebSocket(); // Initialize WebSocket for interrupts
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
    resetBtn: document.getElementById('reset-btn'),
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
  
  // Reset conversation
  elements.resetBtn?.addEventListener('click', handleResetConversation);
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

        // Trigger user sync for the saved organization
        console.log('[INIT] Triggering user sync for saved org:', lastOrgId);
        try {
          const response = await fetch(`${API_BASE}/api/orgs/select`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              session_id: currentSessionId,
              org_id: lastOrgId
            })
          });

          if (response.ok) {
            const data = await response.json();
            console.log('[INIT] Initial org sync completed:', data);
          }
        } catch (error) {
          console.error('[INIT] Error syncing organization on load:', error);
        }
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
  elements.orgSelectionScreen.classList.add('hidden');  // Explicitly hide org selection
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

async function selectOrganization(orgId, orgName, element) {
  console.log('[SELECT_ORG] Selecting organization:', orgId, orgName);

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

  // Call backend to sync users for this organization
  try {
    console.log('[SELECT_ORG] Calling backend /api/orgs/select endpoint...');
    const response = await fetch(`${API_BASE}/api/orgs/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session_id: currentSessionId,
        org_id: orgId
      })
    });

    if (!response.ok) {
      console.error('[SELECT_ORG] Failed to sync organization users:', response.status);
    } else {
      const data = await response.json();
      console.log('[SELECT_ORG] Organization sync response:', data);

      if (data.currentUser) {
        console.log('[SELECT_ORG] Current user identified:', data.currentUser.name);
      }
    }
  } catch (error) {
    console.error('[SELECT_ORG] Error syncing organization:', error);
    // Don't block the UI if sync fails
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
    
    // Choose endpoint based on feature flag
    const endpoint = USE_V2_ARCHITECTURE
      ? `${API_BASE}/api/agent/execute`
      : `${API_BASE}/api/orchestrator/query`;
    
    console.log(`[CHAT] Using endpoint: ${endpoint}`);
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: message,
        session_id: currentSessionId,
        org_id: currentOrgId,
        thread_id: currentThreadId, // Include thread_id if available for conversation continuity
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
    
    // Handle V2 architecture response format
    if (USE_V2_ARCHITECTURE) {
      if (data.status === 'PENDING_APPROVAL' ||
          data.status === 'PENDING_INTERRUPT' ||
          data.status === 'PENDING_CLARIFICATION') {
        // Handle approval/interrupt/clarification request
        console.log('[CHAT] Interrupt required:', data);
        
        // Show message if provided
        if (data.message) {
          addMessageToChat(data.message, false);
        }
        
        // Start polling for interrupts in production, or wait for WebSocket in dev
        if (window.location.protocol === 'chrome-extension:') {
          // Production - only poll if we don't already have previews
          // This avoids duplicate approval UI when formatResponse provides immediate previews
          if (!data.previews) {
            pollForInterrupts(data.thread_id);
          }
        } else {
          // Development - WebSocket will handle it
          currentThreadId = data.thread_id;
        }

        // If previews are immediately available, show them
        if (data.previews) {
          showApprovalUI(data.previews, data.thread_id);
        } else if (data.clarification) {
          handleInterruptReceived(data.clarification);
        } else if (data.interrupt) {
          handleInterruptReceived(data.interrupt);
        }
      } else if (data.status === 'COMPLETED') {
        // Add assistant response
        const responseText = data.response || 'Task completed.';
        addMessageToChat(responseText, false);
        
        // Show follow-up questions if provided
        if (data.followups && data.followups.length > 0) {
          showFollowUpQuestions(data.followups);
        }
      } else {
        // Handle error or unknown status
        const responseText = data.error || 'I couldn\'t process that request.';
        addMessageToChat(responseText, false);
      }
    } else {
      // Legacy format handling
      const responseText = data.response || data.error || 'I couldn\'t process that request.';
      addMessageToChat(responseText, false);
    }
    
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
// APPROVAL UI FUNCTIONS (NEW ARCHITECTURE)
// ============================================

let currentThreadId = null; // Store thread ID for approval
let currentInterrupt = null; // Store current interrupt data
let approvalPollingInterval = null; // Store polling interval

// WebSocket connection for real-time interrupts (development only)
let interruptWebSocket = null;

// Initialize WebSocket for interrupts (if in development)
function initInterruptWebSocket() {
  if (window.location.protocol !== 'chrome-extension:') {
    // Development mode - use WebSocket
    const wsUrl = 'ws://localhost:3000/ws/interrupts';
    console.log('[WEBSOCKET] Connecting to:', wsUrl);
    
    interruptWebSocket = new WebSocket(wsUrl);
    
    interruptWebSocket.onopen = () => {
      console.log('[WEBSOCKET] Connected for interrupts');
      // Send session info
      if (currentSessionId) {
        interruptWebSocket.send(JSON.stringify({
          type: 'auth',
          sessionId: currentSessionId,
          orgId: currentOrgId
        }));
      }
    };
    
    interruptWebSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('[WEBSOCKET] Interrupt received:', data);
        handleInterruptReceived(data);
      } catch (error) {
        console.error('[WEBSOCKET] Failed to parse message:', error);
      }
    };
    
    interruptWebSocket.onerror = (error) => {
      console.error('[WEBSOCKET] Error:', error);
    };
    
    interruptWebSocket.onclose = () => {
      console.log('[WEBSOCKET] Connection closed');
      // Attempt reconnect after 5 seconds
      setTimeout(() => {
        if (!interruptWebSocket || interruptWebSocket.readyState === WebSocket.CLOSED) {
          initInterruptWebSocket();
        }
      }, 5000);
    };
  }
}

// Handle interrupt received from WebSocket or polling
function handleInterruptReceived(interrupt) {
  console.log('[INTERRUPT] Received:', interrupt);
  
  currentInterrupt = interrupt;
  
  // Check interrupt type - handle both direct type and nested value.type
  const interruptType = interrupt.type || (interrupt.value && interrupt.value.type);
  
  if (interruptType === 'approval' || interruptType === 'batch_approval' || interruptType === 'approval_required') {
    // Show approval UI
    const previews = interrupt.previews || (interrupt.value && interrupt.value.previews) || interrupt.approvalPayload?.previews;
    const threadId = interrupt.threadId || interrupt.thread_id;
    if (previews) {
      showApprovalUI(previews, threadId);
    }
  } else if (interruptType === 'contact_disambiguation') {
    // Show contact disambiguation UI
    // Handle different data structures
    const contacts = interrupt.contacts || 
                     (interrupt.value && interrupt.value.candidates) ||
                     (interrupt.candidates);
    const threadId = interrupt.threadId || interrupt.thread_id;
    
    if (contacts) {
      console.log('[INTERRUPT] Showing contact disambiguation with', contacts.length, 'candidates');
      showContactDisambiguationUI(contacts, threadId);
    } else {
      console.error('[INTERRUPT] No contacts found in interrupt data');
    }
  } else if (interruptType === 'workflow_guidance') {
    // Show workflow guidance UI
    const options = interrupt.options || (interrupt.value && interrupt.value.options);
    const threadId = interrupt.threadId || interrupt.thread_id;
    if (options) {
      showWorkflowGuidanceUI(options, threadId);
    }
  } else {
    console.warn('[INTERRUPT] Unknown interrupt type:', interruptType);
  }
}

// Poll for interrupts (production mode)
async function pollForInterrupts(threadId) {
  if (approvalPollingInterval) {
    clearInterval(approvalPollingInterval);
  }
  
  console.log('[POLLING] Starting interrupt polling for thread:', threadId);
  
  approvalPollingInterval = setInterval(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/agent/interrupt-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          thread_id: threadId
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.hasInterrupt) {
          console.log('[POLLING] Interrupt detected');
          handleInterruptReceived(data.interrupt);
          // Stop polling once interrupt is received
          clearInterval(approvalPollingInterval);
          approvalPollingInterval = null;
        }
      }
    } catch (error) {
      console.error('[POLLING] Error checking for interrupts:', error);
    }
  }, 2000); // Poll every 2 seconds
  
  // Stop polling after 60 seconds
  setTimeout(() => {
    if (approvalPollingInterval) {
      clearInterval(approvalPollingInterval);
      approvalPollingInterval = null;
      console.log('[POLLING] Stopped polling after timeout');
    }
  }, 60000);
}

function showApprovalUI(previews, threadId) {
  if (!previews || previews.length === 0) {
    console.error('[APPROVAL] No previews to show');
    return;
  }
  
  currentThreadId = threadId;
  console.log('[APPROVAL] Showing approval UI for thread:', threadId);
  
  // Create approval container
  const approvalDiv = document.createElement('div');
  approvalDiv.className = 'approval-container';
  approvalDiv.id = `approval-${Date.now()}`;
  
  // Add title (minimal)
  const titleDiv = document.createElement('div');
  titleDiv.className = 'approval-title';
  titleDiv.textContent = 'Review:';
  approvalDiv.appendChild(titleDiv);
  
  // Single-card layout
  const approvals = {};
  const card = document.createElement('div');
  card.className = 'approval-card';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'approval-content';

  previews.forEach((preview, index) => {
    const item = preview && preview.preview ? preview.preview : preview;
    const key = preview?.actionId || `action-${index}`;
    approvals[key] = true;

    let structured = item && (item.spec || item.details);
    let derivedPreview = null;
    if (!structured) {
      const dataObj = preview?.data || item?.data;
      const details = [];
      const isAppointment = (item?.type || '').toLowerCase() === 'appointment';
      if (isAppointment && dataObj) {
        if (dataObj.startTime || dataObj.endTime) {
          try {
            const start = dataObj.startTime ? new Date(dataObj.startTime) : null;
            const end = dataObj.endTime ? new Date(dataObj.endTime) : null;
            const dateOpts = { year: 'numeric', month: 'short', day: 'numeric' };
            const timeOpts = { hour: 'numeric', minute: '2-digit' };
            const dateStr = start ? start.toLocaleDateString(undefined, dateOpts) : null;
            const timeStr = start && end
              ? `${start.toLocaleTimeString(undefined, timeOpts)} – ${end.toLocaleTimeString(undefined, timeOpts)}`
              : start
                ? start.toLocaleTimeString(undefined, timeOpts)
                : '';
            if (dateStr) details.push({ label: 'Date', value: dateStr });
            if (timeStr) details.push({ label: 'Time', value: timeStr });
          } catch (_) {}
        }
        if (dataObj.location) details.push({ label: 'Location', value: dataObj.location });
        if (Array.isArray(dataObj.attendees) && dataObj.attendees.length > 0) {
          details.push({ label: 'Attendees', value: dataObj.attendees.join(', ') });
        }
        if (details.length > 0) {
          derivedPreview = {
            type: item?.type || 'appointment',
            title: item?.title || dataObj.subject || 'Appointment',
            details
          };
          structured = true;
        }
      }
    }

    const displayPreview = structured ? (derivedPreview || item) : null;
    const wrapper = document.createElement('div');
    wrapper.className = 'spec-details';
    if (displayPreview) {
      wrapper.innerHTML = formatPreviewSpec(displayPreview.spec, displayPreview);
    } else {
      const title = item?.title || item?.name || item?.subject || 'Action';
      wrapper.innerHTML = `
        <div class="preview-title"><strong>${escapeHtml(title)}</strong></div>
        <div class="preview-detail">No additional details available.</div>
      `;
    }
    contentDiv.appendChild(wrapper);
  });

  card.appendChild(contentDiv);

  // Global buttons that apply to all items
  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = 'approval-buttons';
  const approveBtn = document.createElement('button');
  approveBtn.className = 'approve-btn selected';
  approveBtn.textContent = '✓ Approve';
  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'reject-btn';
  rejectBtn.textContent = '✗ Reject';
  approveBtn.onclick = () => { Object.keys(approvals).forEach(k => approvals[k] = true); approveBtn.classList.add('selected'); rejectBtn.classList.remove('selected'); };
  rejectBtn.onclick = () => { Object.keys(approvals).forEach(k => approvals[k] = false); rejectBtn.classList.add('selected'); approveBtn.classList.remove('selected'); };
  buttonsDiv.appendChild(approveBtn);
  buttonsDiv.appendChild(rejectBtn);
  card.appendChild(buttonsDiv);

  approvalDiv.appendChild(card);
  
  // Submit button
  const submitDiv = document.createElement('div');
  submitDiv.className = 'approval-submit';
  
  const submitBtn = document.createElement('button');
  submitBtn.className = 'submit-approval-btn';
  submitBtn.textContent = 'Confirm';
  submitBtn.onclick = () => handleApprovalSubmit(approvals, approvalDiv.id);
  
  submitDiv.appendChild(submitBtn);
  approvalDiv.appendChild(submitDiv);
  
  // Add to chat
  elements.chatMessages?.appendChild(approvalDiv);
  approvalDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function formatPreviewSpec(spec, preview) {
  // Handle appointment previews with details array
  if (preview?.type === 'appointment' && preview?.details) {
    let html = '<div class="spec-details">';

    // Add title if present
    if (preview.title) {
      html += `<div class="preview-title"><strong>${preview.title}</strong></div>`;
    }

    // Add each detail
    preview.details.forEach(detail => {
      html += `<div class="preview-detail"><strong>${detail.label}:</strong> ${detail.value}</div>`;
    });

    // Add warnings (conflicts)
    if (preview.warnings && preview.warnings.length > 0) {
      html += '<div class="preview-warnings">';
      html += '<div class="warning-header">⚠️ <strong>Conflicts Detected:</strong></div>';
      preview.warnings.forEach(warning => {
        html += `<div class="warning-item">${warning}</div>`;
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  // Handle task previews
  if (preview?.type === 'task' && preview?.details) {
    let html = '<div class="spec-details">';

    if (preview.title) {
      html += `<div class="preview-title"><strong>${preview.title}</strong></div>`;
    }

    preview.details.forEach(detail => {
      html += `<div class="preview-detail"><strong>${detail.label}:</strong> ${detail.value}</div>`;
    });

    html += '</div>';
    return html;
  }

  // Handle workflow previews
  if (preview?.type === 'workflow' && preview?.details) {
    let html = '<div class="spec-details">';

    // Add title
    if (preview.title) {
      html += `<div class="preview-title"><strong>${preview.title}</strong></div>`;
    }

    // Add main details (description, step count, etc.)
    if (preview.details.description) {
      html += `<div class="preview-detail"><strong>Description:</strong> ${preview.details.description}</div>`;
    }
    if (preview.details.stepCount) {
      html += `<div class="preview-detail"><strong>Total Steps:</strong> ${preview.details.stepCount}</div>`;
    }
    if (preview.details.totalDuration) {
      html += `<div class="preview-detail"><strong>Estimated Duration:</strong> ${preview.details.totalDuration}</div>`;
    }
    if (preview.details.guidanceMode) {
      html += `<div class="preview-detail"><strong>Mode:</strong> ${preview.details.guidanceMode}</div>`;
    }

    // Add workflow steps if available
    if (preview.details.steps && preview.details.steps.length > 0) {
      html += '<div class="workflow-steps-section">';
      html += '<div class="steps-header"><strong>Workflow Steps:</strong></div>';
      html += '<ol class="workflow-steps-list">';

      preview.details.steps.forEach(step => {
        html += '<li class="workflow-step-item">';
        html += `<span class="step-name"><strong>${escapeHtml(step.name)}</strong></span>`;
        if (step.type) {
          html += ` <span class="step-type">[${step.type}]</span>`;
        }
        if (step.duration) {
          html += ` <span class="step-duration">(${step.duration})</span>`;
        }
        if (step.assignee) {
          html += `<br><span class="step-assignee">Assigned to: ${escapeHtml(step.assignee)}</span>`;
        }
        if (step.source) {
          html += ` <span class="step-source">(${step.source})</span>`;
        }
        html += '</li>';
      });

      html += '</ol>';
      html += '</div>';
    }

    // Add enhancements if any (for hybrid mode)
    if (preview.details.enhancements && preview.details.enhancements.length > 0) {
      html += '<div class="workflow-enhancements">';
      html += '<div class="enhancements-header"><strong>Enhancements Applied:</strong></div>';
      html += '<ul>';
      preview.details.enhancements.forEach(enhancement => {
        html += `<li>${escapeHtml(enhancement)}</li>`;
      });
      html += '</ul>';
      html += '</div>';
    }

    // Add validation errors/warnings
    if (preview.warnings && preview.warnings.length > 0) {
      html += '<div class="preview-warnings">';
      html += '<div class="warning-header">⚠️ <strong>Warnings:</strong></div>';
      preview.warnings.forEach(warning => {
        html += `<div class="warning-item">${escapeHtml(warning)}</div>`;
      });
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  // Original workflow handling (fallback for spec-based previews)
  if (!spec) return '';

  let html = '<div class="spec-details">';

  // Format based on type
  if (spec.name) {
    html += `<div><strong>Name:</strong> ${spec.name}</div>`;
  }
  if (spec.description) {
    html += `<div><strong>Description:</strong> ${spec.description}</div>`;
  }
  if (spec.steps && Array.isArray(spec.steps)) {
    html += '<div><strong>Steps:</strong></div>';
    html += '<ol class="spec-steps">';
    spec.steps.forEach(step => {
      html += `<li>${step.subject || step.name || step}</li>`;
    });
    html += '</ol>';
  }
  if (spec.dueDate) {
    html += `<div><strong>Due Date:</strong> ${new Date(spec.dueDate).toLocaleDateString()}</div>`;
  }
  if (spec.priority) {
    html += `<div><strong>Priority:</strong> ${spec.priority}</div>`;
  }

  html += '</div>';
  return html;
}

async function handleApprovalSubmit(approvals, containerId) {
  console.log('[APPROVAL] Submitting approvals:', approvals);
  
  if (!currentThreadId) {
    console.error('[APPROVAL] No thread ID available');
    addMessageToChat('Error: Missing thread ID for approval', false);
    return;
  }
  
  // Disable submit button
  const container = document.getElementById(containerId);
  const submitBtn = container?.querySelector('.submit-approval-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';
  }
  
  try {
    // For V2 architecture: if there's only one approval, send as decision
    const approvalKeys = Object.keys(approvals);
    let requestBody = {
      session_id: currentSessionId,
      org_id: currentOrgId,
      thread_id: currentThreadId,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    if (approvalKeys.length === 1) {
      // V2 format: send decision field
      const approved = approvals[approvalKeys[0]];
      requestBody.decision = approved ? 'approve' : 'reject';
      console.log('[APPROVAL] Sending V2 format with decision:', requestBody.decision);
    } else {
      // V1 format: send approvals object for multiple items
      requestBody.approvals = approvals;
      console.log('[APPROVAL] Sending V1 format with approvals:', approvals);
    }

    const response = await fetch(`${API_BASE}/api/agent/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorData = await response.json();

      // Check for session state recovery errors
      if (errorData.requiresRestart) {
        // Clear current thread and inform user
        currentThreadId = null;
        showError(errorData.message || 'Session state lost. Please start a new conversation.');

        // Hide approval UI
        if (container) {
          container.remove();
        }
        return;
      }

      throw new Error(errorData.error || 'Failed to submit approvals');
    }

    const data = await response.json();
    
    // Remove approval UI
    if (container) {
      container.remove();
    }
    
    // Handle response
    if (data.status === 'PENDING_APPROVAL') {
      // Another approval required
      if (data.message) {
        addMessageToChat(data.message, false);
      }
      showApprovalUI(data.previews, data.thread_id || currentThreadId);
    } else if (data.status === 'COMPLETED') {
      // Show completion message
      const responseText = data.response || 'Actions executed successfully.';
      addMessageToChat(responseText, false);
      
      // Show follow-ups if available
      if (data.followups && data.followups.length > 0) {
        showFollowUpQuestions(data.followups);
      }
    }
    
  } catch (error) {
    console.error('[APPROVAL] Error submitting approvals:', error);
    addMessageToChat('Failed to submit approvals. Please try again.', false);
    
    // Re-enable submit button
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Decisions';
    }
  }
}

function showFollowUpQuestions(followups) {
  if (!followups || followups.length === 0) return;
  
  const followupDiv = document.createElement('div');
  followupDiv.className = 'followup-container';
  
  const titleDiv = document.createElement('div');
  titleDiv.className = 'followup-title';
  titleDiv.innerHTML = '<strong>Suggested follow-up questions:</strong>';
  followupDiv.appendChild(titleDiv);
  
  followups.forEach((question, index) => {
    const questionBtn = document.createElement('button');
    questionBtn.className = 'followup-question';
    questionBtn.textContent = `${index + 1}. ${question}`;
    questionBtn.onclick = () => {
      // Set the question in the input and send
      if (elements.chatInput) {
        elements.chatInput.value = question;
        handleSendMessage();
      }
    };
    followupDiv.appendChild(questionBtn);
  });
  
  elements.chatMessages?.appendChild(followupDiv);
  followupDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ============================================
// CONTACT DISAMBIGUATION UI
// ============================================

function showContactDisambiguationUI(contacts, threadId) {
  if (!contacts || contacts.length === 0) {
    console.error('[DISAMBIGUATION] No contacts to show');
    return;
  }
  
  currentThreadId = threadId;
  console.log('[DISAMBIGUATION] Showing contact selection for thread:', threadId);
  
  // Create disambiguation container
  const disambigDiv = document.createElement('div');
  disambigDiv.className = 'disambiguation-container contact-disambiguation';
  disambigDiv.id = `disambig-${Date.now()}`;
  
  // Add title
  const titleDiv = document.createElement('div');
  titleDiv.className = 'disambiguation-title';
  titleDiv.innerHTML = '<strong>🤔 Which contact did you mean?</strong>';
  disambigDiv.appendChild(titleDiv);
  
  // Add explanation
  const explainDiv = document.createElement('div');
  explainDiv.className = 'disambiguation-explain';
  explainDiv.textContent = 'Multiple contacts match your search. Please select the correct one:';
  disambigDiv.appendChild(explainDiv);
  
  // Cards wrapper for responsive layout
  const cardsWrapper = document.createElement('div');
  cardsWrapper.className = 'contact-list';

  // Create contact cards (immediate confirm on click)
  let selectedContactId = null;

  contacts.forEach((contact) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'contact-card contact-card--modern';
    // Handle both old and new field names
    card.dataset.contactId = contact.Id || contact.id;
    // Store full contact object for submission
    card.dataset.contactData = JSON.stringify(contact);
    card.setAttribute('aria-label', 'Use contact');

    // Contact info
    const infoDiv = document.createElement('div');
    infoDiv.className = 'contact-info';

    // Name - handle various field formats
    const nameDiv = document.createElement('div');
    nameDiv.className = 'contact-name';
    const fullName = contact.name || contact.Name || contact.FullName ||
                    (contact.FirstName && contact.LastName ?
                     `${contact.FirstName} ${contact.LastName}` : 'Unknown');
    nameDiv.textContent = fullName;
    infoDiv.appendChild(nameDiv);

    // Role/Title + Company (single meta line)
    const jobTitle = contact.title || contact.Title || contact.role ||
                    contact.JobTitle || contact.Role;
    const companyName = contact.company || contact.Company || contact.CompanyName;
    if (jobTitle || companyName) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'contact-meta';
      const parts = [];
      if (jobTitle) parts.push(jobTitle);
      if (companyName) parts.push(companyName);
      metaDiv.textContent = parts.join(' • ');
      infoDiv.appendChild(metaDiv);
    }
    
    // Email - handle BSA field names
    const email = contact.email || contact.Email || contact.EMailAddress1;
    if (email) {
      const emailDiv = document.createElement('div');
      emailDiv.className = 'contact-email';
      emailDiv.textContent = email;
      infoDiv.appendChild(emailDiv);
    }

    // Simplified card: omit phone, score, interaction
    
    card.appendChild(infoDiv);
    
    // Immediate confirm on click or Enter/Space
    const submitSelection = () => handleContactSelection(card.dataset.contactId, disambigDiv.id);
    card.onclick = submitSelection;
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        submitSelection();
      }
    };

    cardsWrapper.appendChild(card);
  });
  disambigDiv.appendChild(cardsWrapper);
  
  // No submit button; selection happens on card click
  
  // Add to chat
  elements.chatMessages?.appendChild(disambigDiv);
  disambigDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function handleContactSelection(contactId, containerId) {
  console.log('[DISAMBIGUATION] Selected contact:', contactId);

  if (!currentThreadId || !contactId) {
    console.error('[DISAMBIGUATION] Missing thread ID or contact ID');
    addMessageToChat('Error: Missing required information', false);
    return;
  }

  // Get the full contact object from the card
  const container = document.getElementById(containerId);
  const selectedCard = container?.querySelector(`[data-contact-id="${contactId}"]`);
  const contactData = selectedCard?.dataset?.contactData;
  let selectedContact = null;

  if (contactData) {
    try {
      selectedContact = JSON.parse(contactData);
      console.log('[DISAMBIGUATION] Retrieved full contact object:', selectedContact);
    } catch (error) {
      console.error('[DISAMBIGUATION] Failed to parse contact data:', error);
    }
  }

  // Disable submit button
  const submitBtn = container?.querySelector('.submit-disambiguation-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';
  }

  try {
    // Use approve endpoint for V2 architecture with contact resolution
    const endpoint = USE_V2_ARCHITECTURE
      ? `${API_BASE}/api/agent/approve`
      : `${API_BASE}/api/agent/resolve-contact`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        org_id: currentOrgId,
        thread_id: currentThreadId,
        contact_id: contactId,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // Additional fields for V2 architecture
        decision: 'continue',
        interrupt_response: {
          type: 'contact_selected',
          selected_contact_id: contactId,
          selected_contact: selectedContact // Send full contact object
        }
      })
    });
    
    if (!response.ok) {
      throw new Error('Failed to submit contact selection');
    }
    
    const data = await response.json();
    
    // Remove disambiguation UI
    if (container) {
      container.remove();
    }
    
    // Handle response
    if (data.status === 'PENDING_APPROVAL' || data.status === 'PENDING_INTERRUPT') {
      // Another interrupt required
      if (data.message) {
        addMessageToChat(data.message, false);
      }
      if (data.interrupt) {
        handleInterruptReceived(data.interrupt);
      }
    } else if (data.status === 'COMPLETED') {
      // Show completion message
      const responseText = data.response || 'Contact selected successfully.';
      addMessageToChat(responseText, false);
      
      // Show follow-ups if available
      if (data.followups && data.followups.length > 0) {
        showFollowUpQuestions(data.followups);
      }
    }
    
  } catch (error) {
    console.error('[DISAMBIGUATION] Error submitting selection:', error);
    addMessageToChat('Failed to submit contact selection. Please try again.', false);
    
    // Re-enable submit button
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Use Selected Contact';
    }
  }
}

// ============================================
// WORKFLOW GUIDANCE UI
// ============================================

function showWorkflowGuidanceUI(options, threadId) {
  if (!options) {
    console.error('[WORKFLOW] No options to show');
    return;
  }
  
  currentThreadId = threadId;
  console.log('[WORKFLOW] Showing workflow guidance for thread:', threadId);
  
  // Create workflow container
  const workflowDiv = document.createElement('div');
  workflowDiv.className = 'workflow-guidance-container';
  workflowDiv.id = `workflow-${Date.now()}`;
  
  // Add title
  const titleDiv = document.createElement('div');
  titleDiv.className = 'workflow-title';
  titleDiv.innerHTML = '<strong>🔄 How would you like to proceed?</strong>';
  workflowDiv.appendChild(titleDiv);
  
  // Add explanation based on guidance mode
  const explainDiv = document.createElement('div');
  explainDiv.className = 'workflow-explain';
  
  if (options.mode === 'agent-led') {
    explainDiv.textContent = 'I can suggest best practice steps for this workflow:';
  } else if (options.mode === 'user-specified') {
    explainDiv.textContent = 'Please specify the steps you want for this workflow:';
  } else {
    explainDiv.textContent = 'Would you like me to enhance your workflow with additional steps?';
  }
  workflowDiv.appendChild(explainDiv);
  
  // Show suggested steps if available
  if (options.suggestedSteps && options.suggestedSteps.length > 0) {
    const stepsDiv = document.createElement('div');
    stepsDiv.className = 'workflow-steps-preview';
    
    const stepsTitle = document.createElement('div');
    stepsTitle.className = 'steps-title';
    stepsTitle.textContent = 'Suggested workflow steps:';
    stepsDiv.appendChild(stepsTitle);
    
    const stepsList = document.createElement('ol');
    stepsList.className = 'suggested-steps';
    
    options.suggestedSteps.forEach(step => {
      const stepItem = document.createElement('li');
      stepItem.className = 'step-item';
      stepItem.innerHTML = `
        <span class="step-name">${escapeHtml(step.name || step.subject || step)}</span>
        ${step.description ? `<span class="step-desc">${escapeHtml(step.description)}</span>` : ''}
      `;
      stepsList.appendChild(stepItem);
    });
    
    stepsDiv.appendChild(stepsList);
    workflowDiv.appendChild(stepsDiv);
  }
  
  // Action buttons
  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = 'workflow-buttons';
  
  if (options.mode === 'agent-led' || options.mode === 'hybrid') {
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'workflow-accept-btn';
    acceptBtn.textContent = '✓ Use Suggested Steps';
    acceptBtn.onclick = () => handleWorkflowDecision('accept', workflowDiv.id);
    buttonsDiv.appendChild(acceptBtn);
    
    const modifyBtn = document.createElement('button');
    modifyBtn.className = 'workflow-modify-btn';
    modifyBtn.textContent = '✏️ Modify Steps';
    modifyBtn.onclick = () => handleWorkflowDecision('modify', workflowDiv.id);
    buttonsDiv.appendChild(modifyBtn);
  }
  
  if (options.mode === 'user-specified' || options.allowCustom) {
    const customBtn = document.createElement('button');
    customBtn.className = 'workflow-custom-btn';
    customBtn.textContent = '📝 Specify Custom Steps';
    customBtn.onclick = () => showWorkflowCustomInput(workflowDiv.id);
    buttonsDiv.appendChild(customBtn);
  }
  
  workflowDiv.appendChild(buttonsDiv);
  
  // Add to chat
  elements.chatMessages?.appendChild(workflowDiv);
  workflowDiv.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function handleWorkflowDecision(decision, containerId) {
  console.log('[WORKFLOW] Decision:', decision);
  
  if (!currentThreadId) {
    console.error('[WORKFLOW] Missing thread ID');
    addMessageToChat('Error: Missing thread information', false);
    return;
  }
  
  const container = document.getElementById(containerId);
  
  try {
    const response = await fetch(`${API_BASE}/api/agent/workflow-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        org_id: currentOrgId,
        thread_id: currentThreadId,
        decision: decision,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    });
    
    if (!response.ok) {
      throw new Error('Failed to submit workflow decision');
    }
    
    const data = await response.json();
    
    // Remove workflow UI
    if (container) {
      container.remove();
    }
    
    // Handle response
    if (data.status === 'PENDING_APPROVAL' || data.status === 'PENDING_INTERRUPT') {
      if (data.message) {
        addMessageToChat(data.message, false);
      }
      if (data.interrupt) {
        handleInterruptReceived(data.interrupt);
      }
    } else if (data.status === 'COMPLETED') {
      const responseText = data.response || 'Workflow created successfully.';
      addMessageToChat(responseText, false);
      
      if (data.followups && data.followups.length > 0) {
        showFollowUpQuestions(data.followups);
      }
    }
    
  } catch (error) {
    console.error('[WORKFLOW] Error submitting decision:', error);
    addMessageToChat('Failed to process workflow decision. Please try again.', false);
  }
}

function showWorkflowCustomInput(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  // Hide buttons
  const buttonsDiv = container.querySelector('.workflow-buttons');
  if (buttonsDiv) {
    buttonsDiv.style.display = 'none';
  }
  
  // Add custom input area
  const inputDiv = document.createElement('div');
  inputDiv.className = 'workflow-custom-input';
  
  const inputLabel = document.createElement('div');
  inputLabel.className = 'input-label';
  inputLabel.textContent = 'Enter your workflow steps (one per line):';
  inputDiv.appendChild(inputLabel);
  
  const textarea = document.createElement('textarea');
  textarea.className = 'workflow-steps-input';
  textarea.placeholder = 'Step 1: Initial research\nStep 2: Draft proposal\nStep 3: Review and approve\nStep 4: Implementation';
  textarea.rows = 6;
  inputDiv.appendChild(textarea);
  
  const submitBtn = document.createElement('button');
  submitBtn.className = 'submit-custom-workflow-btn';
  submitBtn.textContent = 'Create Workflow';
  submitBtn.onclick = async () => {
    const steps = textarea.value.trim().split('\n').filter(s => s.trim());
    if (steps.length === 0) {
      alert('Please enter at least one step');
      return;
    }
    
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';
    
    try {
      const response = await fetch(`${API_BASE}/api/agent/workflow-custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          org_id: currentOrgId,
          thread_id: currentThreadId,
          steps: steps,
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      });
      
      if (!response.ok) {
        throw new Error('Failed to submit custom workflow');
      }
      
      const data = await response.json();
      
      // Remove workflow UI
      container.remove();
      
      // Handle response
      if (data.status === 'COMPLETED') {
        const responseText = data.response || 'Custom workflow created successfully.';
        addMessageToChat(responseText, false);
      }
      
    } catch (error) {
      console.error('[WORKFLOW] Error submitting custom steps:', error);
      addMessageToChat('Failed to create custom workflow. Please try again.', false);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Workflow';
    }
  };
  
  inputDiv.appendChild(submitBtn);
  container.appendChild(inputDiv);
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
  // Don't clear ONBOARDING_COMPLETED_KEY so returning users skip welcome
  
  currentSessionId = null;
  currentOrgId = null;
  currentOrgName = null;
  organizations = [];
  chatMessages = [];
  
  // Reset UI - show welcome screen with clean state
  showWelcomeScreen();
}

// Handle reset conversation
async function handleResetConversation() {
  if (!currentSessionId) {
    console.log('[RESET] No session ID available');
    return;
  }

  // Validate organization is selected
  if (!currentOrgId) {
    showError('Please select an organization before resetting the conversation');
    return;
  }

  // Confirm with user
  if (!confirm('Start a new conversation? This will clear the current conversation history but keep your login and memories.')) {
    return;
  }
  
  try {
    showLoading(true);

    const response = await fetch(`${API_BASE}/api/reset-conversation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session_id: currentSessionId,
        org_id: currentOrgId  // Include org_id for correct thread_id construction
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to reset conversation');
    }
    
    const result = await response.json();
    console.log('[RESET] Conversation reset successful:', result);

    // Clear chat messages in UI
    chatMessages = [];
    elements.chatMessages.innerHTML = '';

    // Clear thread ID to start fresh conversation
    currentThreadId = null;
    
    // Add welcome message
    const welcomeMessage = `
      <div class="message assistant-message">
        <div class="message-bubble">
          <p>Conversation reset! How can I help you today?</p>
          <p>I can help you with:</p>
          <ul>
            <li>📅 Your upcoming appointments &amp; tasks</li>
            <li>⚙️ Building smart processes or reviewing them</li>
          </ul>
        </div>
      </div>
    `;
    elements.chatMessages.innerHTML = welcomeMessage;
    
    // Focus on input
    elements.chatInput?.focus();
    
  } catch (error) {
    console.error('[RESET] Failed to reset conversation:', error);
    showError(`Failed to reset conversation: ${error.message}`);
  } finally {
    showLoading(false);
  }
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