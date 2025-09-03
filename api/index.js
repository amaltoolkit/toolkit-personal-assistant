// Dependencies
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const http = require('http');
const https = require('https');

// Performance optimizations
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10
});
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10
});

// Module caching to prevent duplicate imports
const modulePromises = {};
const moduleCache = {};

// Axios config with keep-alive for connection reuse
const axiosConfig = {
  timeout: 10000,
  httpAgent: keepAliveAgent,
  httpsAgent: keepAliveHttpsAgent
};

// Cached LLM client getter
async function getLLMClient() {
  if (!moduleCache.llm) {
    if (!modulePromises.llm) {
      modulePromises.llm = import("@langchain/openai").then(({ ChatOpenAI }) => {
        moduleCache.llm = new ChatOpenAI({
          model: "gpt-4o-mini",
          temperature: 0
        });
        return moduleCache.llm;
      });
    }
    return modulePromises.llm;
  }
  return moduleCache.llm;
}

// Express app initialization
const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// Supabase database connection
// Service role key provides full database access - NEVER expose to frontend
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Environment variables
const BSA_BASE = process.env.BSA_BASE;
const BSA_CLIENT_ID = process.env.BSA_CLIENT_ID;
const BSA_CLIENT_SECRET = process.env.BSA_CLIENT_SECRET;
const BSA_REDIRECT_URI = process.env.BSA_REDIRECT_URI;


// OAuth endpoint: Start authentication flow
app.get("/auth/start", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    
    // Validate that session_id was provided
    // Without it, we can't track this OAuth flow
    if (!sessionId) {
      console.error("[AUTH START] Missing session_id");
      return res.status(400).json({ error: "missing session_id" });
    }

    // Generate CSRF protection token
    const state = crypto.randomBytes(16).toString("hex");
    
    // Store the session in database for later validation
    // We'll match this when BSA redirects back to our callback
    const { error } = await supabase
      .from("oauth_sessions")
      .insert({ 
        session_id: sessionId,  // Chrome extension's session identifier
        state                   // Random state for CSRF protection
      });
    
    // Check for database errors
    if (error) {
      console.error("[AUTH START] Database error:", error);
      return res.status(500).json({ error: "database error" });
    }
    
    // Construct the BSA OAuth authorization URL
    const authUrl = new URL(`${BSA_BASE}/oauth2/authorize`);
    
    // OAuth 2.0 standard parameters
    authUrl.searchParams.set("response_type", "code");        // We want an authorization code
    authUrl.searchParams.set("client_id", BSA_CLIENT_ID);      // Our app's client ID
    authUrl.searchParams.set("redirect_uri", BSA_REDIRECT_URI); // Where BSA should redirect after auth
    authUrl.searchParams.set("scope", "openid profile email");  // Permissions we're requesting
    authUrl.searchParams.set("state", state);                   // CSRF protection token
    
    // Redirect the user's browser to BSA's OAuth page
    // User will authenticate there and grant permissions
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error("[AUTH START] Error:", error);
    res.status(500).json({ error: "internal server error" });
  }
});

// OAuth endpoint: Handle callback from BSA
// Immediately redirects user while processing in background
app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    
    // Validate required parameters
    // Both code and state are required for secure OAuth flow
    if (!code || !state) {
      console.error("[AUTH CALLBACK] Missing code or state parameter");
      return res.status(400).send("Missing code or state parameter");
    }

    // Immediately redirect user to BSA main page
    // This provides better UX - user doesn't see a loading page
    // The OAuth processing happens asynchronously in the background
    res.redirect(`${BSA_BASE}`);

    // Process the OAuth callback asynchronously (non-blocking)
    // This performs the token exchange and stores the PassKey
    // Errors are caught and logged but don't affect the user redirect
    processOAuthCallback(code, state).catch(error => {
      console.error("[AUTH CALLBACK] Background OAuth processing error:", error);
    });

  } catch (error) {
    console.error("[AUTH CALLBACK] Error:", error);
    res.status(500).send("Internal server error");
  }
});

// Background OAuth processing
// Validates state, exchanges code->token->PassKey, stores in DB
async function processOAuthCallback(code, state) {
  try {
    // Validate state token for CSRF protection
    const { data: rows, error } = await supabase
      .from("oauth_sessions")
      .select("*")
      .eq("state", state)        // Match the state token
      .is("used_at", null)       // Ensure it hasn't been used before
      .limit(1);
    
    // Handle database errors
    if (error) {
      console.error("[PROCESS OAUTH] Database error:", error);
      return;
    }
    
    // Validate that we found a matching session
    // If not, this could be an attack or expired session
    const row = rows && rows[0];
    if (!row) {
      console.error("[PROCESS OAUTH] Invalid or expired state");
      return;
    }

    // Exchange authorization code for bearer token
    let tokenResp;
    try {
      const tokenUrl = `${BSA_BASE}/oauth2/token`;
      
      // Make POST request to exchange authorization code for bearer token
      // Note: BSA expects application/x-www-form-urlencoded format
      tokenResp = await axios.post(
        tokenUrl,
        {
          grant_type: "authorization_code",      // OAuth grant type
          client_id: BSA_CLIENT_ID,               // Our app's client ID
          client_secret: BSA_CLIENT_SECRET,       // Our app's client secret
          code,                                   // Authorization code from callback
          redirect_uri: BSA_REDIRECT_URI          // Must match original request
        },
        { 
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 10000  // 10 second timeout
        }
      );
    } catch (tokenError) {
      // Log detailed error information for debugging
      console.error("[PROCESS OAUTH] Token exchange error:", tokenError.response?.data || tokenError.message);
      console.error("[PROCESS OAUTH] Token error status:", tokenError.response?.status);
      return;
    }

    const bearerToken = tokenResp.data.access_token;
    
    // Validate bearer token was received
    if (!bearerToken) {
      console.error("[PROCESS OAUTH] No bearer token in response:", tokenResp.data);
      return;
    }

    // Exchange bearer token for PassKey (BSA-specific)
    let passKeyResp;
    try {
      const passKeyUrl = `${BSA_BASE}/oauth2/passkey`;
      
      // Exchange bearer token for PassKey
      // Note: Empty body, authorization via Bearer token header
      passKeyResp = await axios.post(
        passKeyUrl,
        {},  // Empty request body
        {
          headers: {
            "Authorization": `Bearer ${bearerToken}`,  // Use bearer token for auth
            "Content-Type": "application/json"
          },
          timeout: 10000  // 10 second timeout
        }
      );
    } catch (passKeyError) {
      // Log detailed error information for debugging
      console.error("[PROCESS OAUTH] PassKey exchange error:", passKeyError.response?.data || passKeyError.message);
      console.error("[PROCESS OAUTH] PassKey error status:", passKeyError.response?.status);
      return;
    }

    // Extract PassKey from response
    // BSA may return PassKey in different formats:
    // - Array format: [{ PassKey: "...", Valid: true, ... }]
    // - Direct object with lowercase: { passkey: "...", user_id: "...", expires_in: 3600 }
    const responseData = Array.isArray(passKeyResp.data) ? passKeyResp.data[0] : passKeyResp.data;
    const passKey = responseData?.PassKey || responseData?.passkey;
    
    // Validate PassKey was received
    if (!passKey) {
      console.error("[PROCESS OAUTH] No PassKey in response:", passKeyResp.data);
      return;
    }

    // Store PassKey in database
    
    // Calculate expiry time (1 hour from now)
    // BSA PassKeys have a fixed 1-hour lifetime
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    // Upsert the PassKey into bsa_tokens table
    // Using upsert to handle case where session already has a token
    const { error: tokenError } = await supabase
      .from("bsa_tokens")
      .upsert({
        session_id: row.session_id,      // Link to Chrome extension session
        passkey: passKey,                 // The actual PassKey (stored in plain text)
        refresh_token: null,              // No traditional refresh token - use PassKey to refresh
        expires_at: expiresAt,            // When this PassKey expires
        updated_at: new Date().toISOString()  // Track last update time
      }, { 
        onConflict: "session_id"         // Update if session_id already exists
      });
    
    // Check for storage errors
    if (tokenError) {
      console.error("[PROCESS OAUTH] Failed to store PassKey:", tokenError);
      console.error("[PROCESS OAUTH] Storage error details:", JSON.stringify(tokenError));
      return;
    }

    // Mark OAuth session as used to prevent replay attacks
    // Update the OAuth session to prevent reuse
    // This prevents replay attacks using the same state token
    await supabase
      .from("oauth_sessions")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id);
  } catch (error) {
    // Catch any unexpected errors in the entire flow
    console.error("[PROCESS OAUTH] Unexpected error:", error);
  }
}

// PassKey refresh helper
// Refreshes expired/expiring PassKeys using BSA's refresh endpoint
async function refreshPassKey(sessionId) {
  try {
    // Get existing PassKey from database
    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", sessionId)
      .limit(1);
    
    // Handle database errors or missing token
    if (error || !rows || !rows[0]) {
      console.error("[REFRESH_PASSKEY] Failed to get current PassKey:", error);
      return null;
    }
    
    const currentPassKey = rows[0].passkey;
    
    // Validate PassKey exists
    if (!currentPassKey) {
      console.error("[REFRESH_PASSKEY] No existing PassKey to refresh");
      return null;
    }
    
    // Call BSA refresh endpoint
    const refreshUrl = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/login.json`;
    
    try {
      // Make refresh request using current PassKey
      const refreshResp = await axios.post(
        refreshUrl,
        { PassKey: currentPassKey },  // Authenticate with current PassKey
        {
          headers: { "Content-Type": "application/json" },
          timeout: 10000  // 10 second timeout
        }
      );
      
      // Extract new PassKey from response
      // BSA may return PassKey in different formats:
      // - Array format: [{ PassKey: "...", Valid: true, ... }]
      // - Direct object with lowercase: { passkey: "...", user_id: "...", expires_in: 3600 }
      const responseData = Array.isArray(refreshResp.data) ? refreshResp.data[0] : refreshResp.data;
      // Check both PascalCase 'PassKey' and lowercase 'passkey' field names
      const newPassKey = responseData?.PassKey || responseData?.passkey;
      if (!newPassKey) {
        console.error("[REFRESH_PASSKEY] No new PassKey in refresh response:", refreshResp.data);
        return null;
      }
      
      // Store the new PassKey with fresh 1-hour expiry
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      
      const { error: updateError } = await supabase
        .from("bsa_tokens")
        .update({
          passkey: newPassKey,                        // New PassKey
          expires_at: expiresAt,                      // Fresh 1-hour expiry
          updated_at: new Date().toISOString()        // Track update time
        })
        .eq("session_id", sessionId);
      
      // Check for update errors
      if (updateError) {
        console.error("[REFRESH_PASSKEY] Failed to update PassKey in database:", updateError);
        return null;
      }
      
      return newPassKey;  // Return new PassKey for immediate use
      
    } catch (refreshError) {
      // Log detailed error information for debugging
      console.error("[REFRESH_PASSKEY] API error - Status:", refreshError.response?.status);
      console.error("[REFRESH_PASSKEY] API error - Data:", refreshError.response?.data);
      console.error("[REFRESH_PASSKEY] API error - Message:", refreshError.message);
      return null;
    }
  } catch (error) {
    // Catch any unexpected errors
    console.error("[REFRESH_PASSKEY] Unexpected error:", error);
    return null;
  }
}

// Get valid PassKey helper
// Retrieves PassKey and auto-refreshes if <5 minutes remaining
async function getValidPassKey(sessionId) {
  
  const { data: rows, error } = await supabase
    .from("bsa_tokens")
    .select("*")
    .eq("session_id", sessionId)
    .limit(1);
  
  // Handle database errors
  if (error) {
    console.error("[GET_PASSKEY] Database error:", error);
    return null;
  }
  
  // Check if token exists for this session
  if (!rows || !rows[0]) {
    console.error("[GET_PASSKEY] No token found for session:", sessionId);
    console.log("[GET_PASSKEY] Query returned rows:", rows);
    return null;
  }
  
  const token = rows[0];
  
  const passKey = token.passkey;
  if (!passKey) {
    console.error("[GET_PASSKEY] Token exists but passkey field is empty");
    return null;
  }
  
  // Check expiration and refresh if needed
  if (token.expires_at) {
    const expiry = new Date(token.expires_at);
    const now = new Date();
    const timeLeft = expiry - now;  // Time remaining in milliseconds
    const minutesLeft = Math.floor(timeLeft / 60000);  // Convert to minutes
    
    // Refresh if less than 5 minutes remaining
    // This prevents API calls from failing due to expired tokens
    if (timeLeft < 5 * 60 * 1000) { // 5 minutes in milliseconds
      
      // Attempt to refresh the PassKey
      const newPassKey = await refreshPassKey(sessionId);
      
      if (newPassKey) {
        return newPassKey;
      } else {
        // Refresh failed - return existing PassKey (might still work)
        console.error("[GET_PASSKEY] Failed to refresh PassKey, using existing");
        return passKey;
      }
    }
  }
  
  // PassKey is still valid - return it
  return passKey;
}

// Auth status endpoint - polled by Chrome extension
app.get("/auth/status", async (req, res) => {
  try {
    // Extract session ID from query parameters
    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.json({ ok: false, error: "missing session_id" });
    }
    
    // Check if token exists
    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("session_id, expires_at")  // Only select needed fields
      .eq("session_id", sessionId)
      .limit(1);
    
    // Handle database errors
    if (error) {
      console.error("Database error:", error);
      return res.json({ ok: false, error: "database error" });
    }
    
    // Check if token exists
    const token = rows && rows[0];
    if (!token) {
      // No token yet - OAuth flow might still be in progress
      return res.json({ ok: false });
    }
    
    // Check token expiration
    if (token.expires_at) {
      const expiry = new Date(token.expires_at);
      const now = new Date();
      
      if (expiry < now) {
        // Token has expired - attempt refresh
        const newPassKey = await refreshPassKey(sessionId);
        
        if (newPassKey) {
          // Refresh successful
          return res.json({ ok: true, refreshed: true });
        }
        
        // Refresh failed - authentication expired
        return res.json({ ok: false, expired: true });
      }
    }
    
    // Token exists and is valid
    res.json({ ok: true });
  } catch (error) {
    console.error("Error in /auth/status:", error);
    res.json({ ok: false, error: "internal error" });
  }
});

// BSA response normalization helper
// Unwraps array format: [{ Results/Organizations/etc: [...], Valid: true, ... }]
function normalizeBSAResponse(response) {
  try {
    // Handle null/undefined responses
    if (!response) {
      return { data: null, valid: false, error: 'No response data' };
    }
    
    // BSA returns responses in array format - unwrap the first element
    const responseData = Array.isArray(response) ? response[0] : response;
    
    // Check if response indicates an error
    if (responseData?.Valid === false) {
      return {
        data: responseData,
        valid: false,
        error: responseData.ResponseMessage || responseData.StackMessage || 'BSA API error'
      };
    }
    
    // Return normalized response
    return {
      data: responseData,
      valid: true,
      error: null
    };
  } catch (error) {
    console.error('[NORMALIZE_BSA] Error normalizing response:', error);
    return {
      data: response,
      valid: false,
      error: 'Failed to normalize BSA response'
    };
  }
}

// Fetch organizations helper
async function fetchOrganizations(passKey) {
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json`;
  
  try {
    // Make API call to BSA
    const resp = await axios.post(
      url, 
      { PassKey: passKey },  // Authenticate with PassKey
      { 
        headers: { "Content-Type": "application/json" },
        timeout: 10000  // 10 second timeout
      }
    );
    
    // Extract organizations from response
    const normalized = normalizeBSAResponse(resp.data);
    
    // Check if response is valid
    if (!normalized.valid) {
      console.error("[FETCH_ORGS] BSA returned invalid response:", normalized.error);
      throw new Error(normalized.error || 'Invalid response from BSA');
    }
    
    // Extract Organizations array from normalized response
    const orgsArray = normalized.data?.Organizations || [];
    
    // Validate organizations array
    if (Array.isArray(orgsArray)) {
      return orgsArray;
    } else {
      console.warn("[FETCH_ORGS] Organizations field is not an array:", typeof orgsArray);
      return [];
    }
  } catch (error) {
    // Log error and re-throw for caller to handle
    console.error("[FETCH_ORGS] BSA API error:", error.response?.status, error.message);
    throw error;
  }
}

// API endpoint: List organizations
app.get("/api/orgs", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    
    // Validate session ID is provided
    if (!sessionId) {
      console.error("[API/ORGS] Missing session_id parameter");
      return res.status(400).json({ error: "missing session_id" });
    }

    // Get valid PassKey (auto-refreshes if needed)
    const passKey = await getValidPassKey(sessionId);
    
    // Check if user is authenticated
    if (!passKey) {
      console.error("[API/ORGS] No PassKey found for session:", sessionId);
      return res.status(401).json({ error: "not authenticated" });
    }
    
    try {
      const orgs = await fetchOrganizations(passKey);
      
      // Return in the format expected by the frontend
      // Wrap in Organizations object for consistency
      res.json({ Organizations: orgs });
      
    } catch (apiError) {
      console.error("[API/ORGS] Error fetching organizations:", apiError.message);
      
      // Handle 401 - retry with refreshed PassKey
      if (apiError.response?.status === 401) {
        
        // Attempt to refresh the PassKey
        const newPassKey = await refreshPassKey(sessionId);
        
        if (newPassKey) {
          // Refresh successful - retry the API call
          try {
            const orgs = await fetchOrganizations(newPassKey);
            return res.json({ Organizations: orgs });
          } catch (retryError) {
            // Retry also failed - authentication truly expired
            console.error("[API/ORGS] Retry failed:", retryError.message);
          }
        }
        
        // PassKey refresh failed or retry failed
        return res.status(401).json({ error: "authentication expired" });
      }
      
      // Other API errors (not authentication related)
      res.status(500).json({ error: "failed to fetch organizations", details: apiError.message });
    }
  } catch (error) {
    // Unexpected errors (not from BSA API)
    console.error("[API/ORGS] Unexpected error:", error);
    console.error("[API/ORGS] Error stack:", error.stack);
    res.status(500).json({ error: "internal server error" });
  }
});

// LangChain Calendar Agent implementation

// Fetch calendar activities (appointments) using recommended calendar endpoint
async function getCalendarActivities(passKey, orgId, options = {}) {
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivities.json`;

  // Helper: ensure YYYY-MM-DD format
  const toDateString = (d) => {
    if (!d) return undefined;
    const date = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(date.getTime())) return undefined;
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
      .toISOString()
      .slice(0, 10);
  };

  // Defaults: current month window
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  const payload = {
    IncludeAppointments: true,
    IncludeExtendedProperties: !!options.includeExtendedProperties,
    IncludeTasks: false,
    From: toDateString(options.from) || toDateString(defaultFrom),
    To: toDateString(options.to) || toDateString(defaultTo),
    IncludeAttendees: options.includeAttendees !== false,
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "appointment"
  };

  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);

  if (!normalized.valid) {
    throw new Error(normalized.error || 'Invalid BSA response');
  }

  const activities = Array.isArray(normalized.data?.Activities) ? normalized.data.Activities : [];
  return {
    activities,
    valid: true,
    from: payload.From,
    to: payload.To,
    count: Array.isArray(activities) ? activities.length : 0
  };
}


// Batch fetch contacts by IDs using getMultiple.json
async function getContactsByIds(passKey, orgId, contactIds = [], includeExtendedProperties = false) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) return [];

  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/getMultiple.json`;
  const payload = {
    IncludeExtendedProperties: !!includeExtendedProperties,
    References: contactIds.map((id) => ({
      Fields: [],
      Id: id,
      OrganizationId: orgId,
      PassKey: passKey,
      ObjectName: "contact"
    })),
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "contact"
  };

  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Invalid BSA response');
  }

  return normalized.data?.Results || [];
}


// Define Calendar Agent Tools using tool function with Zod
function createCalendarTools(tool, z, passKey, orgId) {
  return [
    // Tool 1: Get calendar activities with optional date filtering
    tool(
      async ({ startDate, endDate, includeAttendees }) => {
        try {
          const data = await getCalendarActivities(passKey, orgId, {
            from: startDate,
            to: endDate,
            includeAttendees: includeAttendees !== false
          });
          
          return JSON.stringify({
            activities: data.activities,
            dateRange: { from: data.from, to: data.to },
            count: data.count
          });
        } catch (error) {
          console.error("[Calendar Tool] Error fetching activities:", error);
          return JSON.stringify({ 
            error: `Failed to fetch calendar activities: ${error.message}` 
          });
        }
      },
      {
        name: "get_calendar_activities",
        description: "Fetch calendar activities (appointments, meetings, events) with optional date range filtering. Returns activities in native BSA format with Type, Activity, and Attendees objects.",
        schema: z.object({
          startDate: z.string().optional().describe("Start date in YYYY-MM-DD format (defaults to current month)"),
          endDate: z.string().optional().describe("End date in YYYY-MM-DD format (defaults to current month)"),
          includeAttendees: z.boolean().optional().describe("Whether to include attendees in response (default true)")
        })
      }
    ),
    
    // Tool 2: Get contact details by IDs
    tool(
      async ({ contactIds, includeExtendedProperties }) => {
        try {
          if (!contactIds || contactIds.length === 0) {
            return JSON.stringify({ 
              error: "No contact IDs provided",
              contacts: [],
              count: 0
            });
          }
          
          const contacts = await getContactsByIds(
            passKey, 
            orgId, 
            contactIds, 
            includeExtendedProperties || false
          );
          
          return JSON.stringify({
            contacts,
            count: contacts.length
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to fetch contacts: ${error.message}`,
            contacts: [],
            count: 0
          });
        }
      },
      {
        name: "get_contact_details",
        description: "Fetch contact details for one or more contact IDs using the getMultiple endpoint. Works with a single ID or array of IDs. Use this after getting ContactIds from appointments.",
        schema: z.object({
          contactIds: z.array(z.string()).describe("Array of contact IDs to fetch (can be a single ID in an array, e.g., ['single-id'])"),
          includeExtendedProperties: z.boolean().optional().describe("Include custom properties (default false)")
        })
      }
    )
  ];
}

// Create Calendar Agent
async function createCalendarAgent(passKey, orgId) {
  // Dynamic imports for LangChain and Zod
  const { z } = await import("zod");
  const { tool } = await import("@langchain/core/tools");
  const { AgentExecutor, createToolCallingAgent } = await import("langchain/agents");
  const { ChatPromptTemplate } = await import("@langchain/core/prompts");
  
  // Use cached LLM client for better performance
  const llm = await getLLMClient();
  
  const tools = createCalendarTools(tool, z, passKey, orgId);
  
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `You are a helpful calendar assistant. Use the available tools to answer questions about calendar activities, appointments, meetings, and schedules.

When working with calendar data:
- Activities are returned in an array with each item containing:
  - Type: Usually "Appointment" for calendar events
  - Activity: Object with Id, Subject, StartTime, EndTime, Location, Description, and other metadata
  - Attendees: Object with ContactIds (array), UserIds (array), and CompanyIds (array)

IMPORTANT - Be proactive with contact information:
- When you retrieve appointments that have Attendees with ContactIds, ALWAYS immediately fetch their contact details
- Use get_contact_details to fetch contact information for all ContactIds found in appointments
- Present appointment information WITH attendee contact details together in your response
- Don't wait for the user to ask about attendees - provide this information proactively

Example workflow:
1. User asks about appointments → Use get_calendar_activities
2. See ContactIds in Attendees → Immediately use get_contact_details with those IDs
3. Response includes both appointment details AND attendee names, emails, phone numbers

Available tools (2 total):
- get_calendar_activities: Fetch activities for a date range or search for specific appointments
- get_contact_details: Fetch contact information for one or more contact IDs (works with single ID too)

Examples for get_contact_details:
- Single contact: contactIds: ["40071328-2515-47da-8f17-c13d0c9b3162"]
- Multiple contacts: contactIds: ["id1", "id2", "id3"]

Be concise and informative in your responses.`],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"]
  ]);
  
  const agent = createToolCallingAgent({
    llm,
    tools,
    prompt
  });
  
  return new AgentExecutor({
    agent,
    tools,
    verbose: false
  });
}

// Rate limiting (in-memory)
const rateLimitWindows = new Map();

function checkRateLimit(sessionId) {
  const now = Date.now();
  const limit = 10; // 10 requests
  const window = 60000; // per minute
  
  // Periodic cleanup to prevent memory leaks (1% chance)
  if (Math.random() < 0.01) {
    for (const [key, timestamps] of rateLimitWindows.entries()) {
      const valid = timestamps.filter(t => now - t < window);
      if (valid.length === 0) {
        rateLimitWindows.delete(key);
      } else {
        rateLimitWindows.set(key, valid);
      }
    }
  }
  
  const timestamps = rateLimitWindows.get(sessionId) || [];
  const recentRequests = timestamps.filter(t => now - t < window);
  
  if (recentRequests.length >= limit) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimitWindows.set(sessionId, recentRequests);
  return true;
}

// Assistant API endpoint
app.post("/api/assistant/query", async (req, res) => {
  try {
    const { query, session_id, org_id } = req.body;
    
    // Input validation
    if (!query || query.length > 500) {
      return res.status(400).json({ 
        error: "Query must be between 1 and 500 characters" 
      });
    }
    
    // Rate limiting
    if (!checkRateLimit(session_id)) {
      return res.status(429).json({ 
        error: "Rate limit exceeded",
        retryAfter: 60 
      });
    }
    
    // Validate session
    const passKey = await getValidPassKey(session_id);
    if (!passKey) {
      return res.status(401).json({ error: "not authenticated" });
    }
    
    if (!org_id) {
      return res.status(400).json({ 
        error: "Please select an organization first" 
      });
    }
    
    // Create and execute Calendar Agent
    const agent = await createCalendarAgent(passKey, org_id);
    const result = await agent.invoke({ input: query });
    
    res.json({ 
      query,
      response: result.output,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[ASSISTANT] Error:', error);
    res.status(500).json({ 
      error: "Failed to process query",
      details: error.message 
    });
  }
});

// Health check endpoint
app.get("/health", (_, res) => {
  res.json({ 
    status: "healthy",                        // Server status
    timestamp: new Date().toISOString()        // Current server time
  });
});

// Global error handling middleware
app.use((err, _, res, __) => {
  // Log the full error for debugging
  console.error("Unhandled error:", err);
  
  // Send generic error response to client
  // Don't expose internal error details for security
  res.status(500).json({ error: "internal server error" });
});

// Module exports for Vercel
module.exports = app;

// Local development server
if (require.main === module) {
  // Use PORT from environment or default to 3000
  const PORT = process.env.PORT || 3000;
  
  // Start the Express server
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`OAuth start: http://localhost:${PORT}/auth/start?session_id=test`);
  });
}