// Load environment variables in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Ensure LangSmith callbacks complete in serverless environment
// This MUST be set before any LangChain imports for proper tracing
if (!process.env.LANGCHAIN_CALLBACKS_BACKGROUND) {
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";
}

// Dependencies
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const http = require('http');
const https = require('https');

// Import BSA configuration
const bsaConfig = require('./config/bsa');

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

// Specialized GPT-5 client for workflow agent (enhanced intelligence)
async function getWorkflowLLMClient() {
  if (!moduleCache.workflowLLM) {
    if (!modulePromises.workflowLLM) {
      modulePromises.workflowLLM = import("@langchain/openai").then(({ ChatOpenAI }) => {
        moduleCache.workflowLLM = new ChatOpenAI({
          model: "gpt-5"  // Using GPT-5 for superior workflow understanding
          // Note: If GPT-5 doesn't support custom temperature, remove the line above
        });
        console.log("[Workflow LLM] Initialized with GPT-5 model");
        return moduleCache.workflowLLM;
      });
    }
    return modulePromises.workflowLLM;
  }
  return moduleCache.workflowLLM;
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

// PostgreSQL connection pool for direct database operations
// Lazy initialized on first use to avoid issues if POSTGRES_CONNECTION_STRING is not set
let pgPool = null;
function getPgPool() {
  if (!pgPool && process.env.POSTGRES_CONNECTION_STRING) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.POSTGRES_CONNECTION_STRING,
      ssl: { rejectUnauthorized: false },
      max: 10, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 2000, // Timeout for new connections
    });
    
    pgPool.on('error', (err) => {
      console.error('[PG_POOL] Unexpected error on idle client', err);
    });
    
    console.log('[PG_POOL] PostgreSQL connection pool initialized');
  }
  return pgPool;
}

// Environment variables
const BSA_CLIENT_ID = process.env.BSA_CLIENT_ID;
const BSA_CLIENT_SECRET = process.env.BSA_CLIENT_SECRET;
const BSA_REDIRECT_URI = process.env.BSA_REDIRECT_URI;

// BSA_BASE is now managed by the config module
// Use bsaConfig.getBaseUrl() or bsaConfig.buildEndpoint() methods directly

// LangSmith Configuration (for observability)
// These environment variables enable comprehensive tracing when set in Vercel:
// LANGCHAIN_TRACING_V2=true
// LANGCHAIN_API_KEY=your-api-key
// LANGCHAIN_PROJECT=your-project-name
// LANGCHAIN_ENDPOINT=https://api.smith.langchain.com (optional)
if (process.env.LANGCHAIN_TRACING_V2 === 'true' && process.env.LANGCHAIN_API_KEY) {
  console.log('[LangSmith] Tracing enabled for project:', process.env.LANGCHAIN_PROJECT || 'default');
  console.log('[LangSmith] Traces will be visible at: https://smith.langchain.com');
}


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
    const authUrl = new URL(bsaConfig.buildOAuthUrl('authorize'));
    
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
    res.redirect(bsaConfig.getBaseUrl());

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
      const tokenUrl = bsaConfig.buildOAuthUrl('token');
      
      // Create properly encoded form data for OAuth token exchange
      // Using URLSearchParams ensures RFC-compliant encoding
      const form = new URLSearchParams({
        grant_type: "authorization_code",      // OAuth grant type
        client_id: BSA_CLIENT_ID,               // Our app's client ID
        client_secret: BSA_CLIENT_SECRET,       // Our app's client secret
        code,                                   // Authorization code from callback
        redirect_uri: BSA_REDIRECT_URI          // Must match original request
      });
      
      // Make POST request to exchange authorization code for bearer token
      // Note: BSA expects application/x-www-form-urlencoded format
      tokenResp = await axios.post(
        tokenUrl,
        form.toString(),  // Convert URLSearchParams to string
        { 
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          ...axiosConfig  // Apply keep-alive agents for connection reuse
        }
      );
    } catch (tokenError) {
      // Log detailed error information for debugging
      console.error("[PROCESS OAUTH] Token exchange error:", tokenError.response?.data || tokenError.message);
      console.error("[PROCESS OAUTH] Token error status:", tokenError.response?.status);
      return;
    }

    // Log the FULL token response to see all fields
    console.log("[PROCESS OAUTH] Token endpoint full response:", JSON.stringify(tokenResp.data, null, 2));
    console.log("[PROCESS OAUTH] Token response keys:", Object.keys(tokenResp.data));
    
    // Extract all possible fields
    const bearerToken = tokenResp.data.access_token;
    const userIdFromToken = tokenResp.data.user_id || tokenResp.data.UserId || tokenResp.data.UserID || tokenResp.data.userId;
    const refreshToken = tokenResp.data.refresh_token;
    const expiresIn = tokenResp.data.expires_in;
    
    console.log("[PROCESS OAUTH] Token endpoint extracted values:", {
      hasAccessToken: !!bearerToken,
      hasUserId: !!userIdFromToken,
      userId: userIdFromToken || "not in token response",
      hasRefreshToken: !!refreshToken,
      expiresIn
    });
    
    // Validate bearer token was received
    if (!bearerToken) {
      console.error("[PROCESS OAUTH] No bearer token in response:", tokenResp.data);
      return;
    }

    // Exchange bearer token for PassKey (BSA-specific)
    let passKeyResp;
    try {
      const passKeyUrl = bsaConfig.buildOAuthUrl('passkey');
      
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
          ...axiosConfig  // Apply keep-alive agents for connection reuse
        }
      );
    } catch (passKeyError) {
      // Log detailed error information for debugging
      console.error("[PROCESS OAUTH] PassKey exchange error:", passKeyError.response?.data || passKeyError.message);
      console.error("[PROCESS OAUTH] PassKey error status:", passKeyError.response?.status);
      return;
    }

    // Log the FULL passkey response to see all fields
    console.log("[PROCESS OAUTH] PassKey endpoint full response:", JSON.stringify(passKeyResp.data, null, 2));
    console.log("[PROCESS OAUTH] PassKey response keys:", Object.keys(passKeyResp.data));
    
    // Extract PassKey from response
    // BSA may return PassKey in different formats:
    // - Array format: [{ PassKey: "...", Valid: true, ... }]
    // - Direct object with lowercase: { passkey: "...", user_id: "...", expires_in: 3600 }
    const responseData = Array.isArray(passKeyResp.data) ? passKeyResp.data[0] : passKeyResp.data;
    const passKey = responseData?.PassKey || responseData?.passkey;
    const userIdFromPassKey = responseData?.user_id || responseData?.UserId || responseData?.UserID || responseData?.userId;
    
    console.log("[PROCESS OAUTH] PassKey endpoint extracted values:", {
      hasPassKey: !!passKey,
      hasUserId: !!userIdFromPassKey,
      userId: userIdFromPassKey || "not in passkey response",
      responseStructure: Array.isArray(passKeyResp.data) ? "array" : "object",
      responseDataKeys: responseData ? Object.keys(responseData) : []
    });
    
    // Determine where userId came from
    const userId = userIdFromToken || userIdFromPassKey || null;
    
    console.log("[PROCESS OAUTH] Final userId determination:", {
      fromToken: userIdFromToken || "none",
      fromPassKey: userIdFromPassKey || "none",
      final: userId || "not found",
      source: userIdFromToken ? "token" : (userIdFromPassKey ? "passkey" : "none")
    });
    
    // Validate PassKey was received
    if (!passKey) {
      console.error("[PROCESS OAUTH] No PassKey in response:", passKeyResp.data);
      return;
    }

    // Store PassKey in database
    
    // Calculate expiry time (1 hour from now)
    // BSA PassKeys have a fixed 1-hour lifetime
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    
    console.log("[PROCESS OAUTH] About to store in database:", {
      session_id: row.session_id,
      hasPassKey: !!passKey,
      hasUserId: !!userId,
      userId: userId || "null",
      expires_at: expiresAt
    });

    // Upsert the PassKey into bsa_tokens table
    // Using upsert to handle case where session already has a token
    const { error: tokenError } = await supabase
      .from("bsa_tokens")
      .upsert({
        session_id: row.session_id,      // Link to Chrome extension session
        passkey: passKey,                 // The actual PassKey (stored in plain text)
        refresh_token: null,              // No traditional refresh token - use PassKey to refresh
        expires_at: expiresAt,            // When this PassKey expires
        user_id: userId || null,          // Store user ID from BSA response
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
    const refreshUrl = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.data.VCDataEndpoint/login.json');
    
    try {
      // Make refresh request using current PassKey
      const refreshResp = await axios.post(
        refreshUrl,
        { PassKey: currentPassKey },  // Authenticate with current PassKey
        {
          headers: { "Content-Type": "application/json" },
          ...axiosConfig  // Apply keep-alive agents for connection reuse
        }
      );
      
      // Extract new PassKey from response
      // BSA may return PassKey in different formats:
      // - Array format: [{ PassKey: "...", Valid: true, ... }]
      // - Direct object with lowercase: { passkey: "...", user_id: "...", expires_in: 3600 }
      const responseData = Array.isArray(refreshResp.data) ? refreshResp.data[0] : refreshResp.data;
      // Check both PascalCase 'PassKey' and lowercase 'passkey' field names
      const newPassKey = responseData?.PassKey || responseData?.passkey;
      const userId = responseData?.user_id || responseData?.UserId || responseData?.UserID;
      
      // Log the response structure for debugging
      console.log("[REFRESH_PASSKEY] Refresh response structure:", {
        hasPassKey: !!newPassKey,
        hasUserId: !!userId,
        userId: userId || "not found",
        responseKeys: Object.keys(responseData || {})
      });
      
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
          user_id: userId || null,                    // Update user ID if provided
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
      .select("session_id, expires_at, passkey")  // Include passkey to check if it exists
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
    
    // Check if passkey exists
    if (!token.passkey) {
      // Token record exists but no passkey - requires re-authentication
      return res.json({ ok: false, requiresReauth: true });
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
        
        // Refresh failed - authentication expired, requires full re-authentication
        return res.json({ ok: false, expired: true, requiresReauth: true });
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
  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json');
  
  try {
    // Make API call to BSA
    const resp = await axios.post(
      url, 
      { PassKey: passKey },  // Authenticate with PassKey
      { 
        headers: { "Content-Type": "application/json" },
        ...axiosConfig  // Apply keep-alive agents for connection reuse
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
      return res.status(401).json({ error: "not authenticated", requiresReauth: true });
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
        return res.status(401).json({ error: "authentication expired", requiresReauth: true });
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

// Import date parser for natural language date queries
const { parseDateQuery, extractDateFromQuery } = require('./lib/dateParser');

// Import Activities Agent module (unified calendar + tasks)
const { createActivitiesAgent } = require('./lib/agents/activitiesAgent');
// Import Workflow Builder Agent module
const { createWorkflowBuilderAgent } = require('./lib/agents/workflowBuilderAgent');
// Import Supervisor Orchestrator module (LangGraph multi-agent coordination)
const { createSupervisorOrchestrator } = require('./lib/agents/supervisorOrchestrator');

// LangChain Calendar Agent implementation



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
    const { query, session_id, org_id, time_zone } = req.body;
    
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
      return res.status(401).json({ error: "not authenticated", requiresReauth: true });
    }
    
    if (!org_id) {
      return res.status(400).json({ 
        error: "Please select an organization first" 
      });
    }
    
    // Create and execute Activities Agent with dependencies
    const dependencies = {
      axios,
      axiosConfig,
      BSA_BASE: bsaConfig.getBaseUrl(),
      normalizeBSAResponse,
      parseDateQuery,
      getLLMClient
    };
    
    const agent = await createActivitiesAgent(passKey, org_id, time_zone || "UTC", dependencies);
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

// Workflow Builder API endpoint
app.post("/api/workflow/query", async (req, res) => {
  try {
    const { query, session_id, org_id } = req.body;
    
    // Input validation
    if (!query || query.length > 2000) {
      return res.status(400).json({ 
        error: "Query must be between 1 and 2000 characters" 
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
    const { data: sessionData, error: sessionError } = await supabase
      .from('bsa_tokens')
      .select('passkey, expires_at')
      .eq('session_id', session_id)
      .single();
    
    if (sessionError || !sessionData) {
      return res.status(401).json({ error: "Invalid session", requiresReauth: true });
    }
    
    // Get PassKey and check if needs refresh
    let passKey = sessionData.passkey;
    const expiresAt = new Date(sessionData.expires_at);
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    
    if (expiresAt < fiveMinutesFromNow) {
      console.log('[WORKFLOW] PassKey expiring soon, refreshing...');
      const newPassKey = await refreshPassKey(session_id);
      if (!newPassKey) {
        return res.status(500).json({ error: "Failed to refresh authentication" });
      }
      passKey = newPassKey;
    }
    
    // Create workflow agent with dependencies (using GPT-5 for enhanced intelligence)
    const dependencies = {
      axios,
      axiosConfig,
      BSA_BASE: bsaConfig.getBaseUrl(),
      normalizeBSAResponse,
      getLLMClient: getWorkflowLLMClient,  // Use GPT-5 for workflow agent
      parseDateQuery,
      extractDateFromQuery
    };
    
    const agent = await createWorkflowBuilderAgent(passKey, org_id, dependencies);
    const result = await agent.invoke({ input: query });
    
    res.json({ 
      query,
      response: result.output,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[WORKFLOW] Error:', error);
    res.status(500).json({ error: "Failed to process workflow request" });
  }
});

// Multi-Agent Routes (V2 Architecture)
// Only mount if feature flag is enabled
if (process.env.USE_V2_ARCHITECTURE === 'true') {
  console.log('[SERVER] V2 architecture enabled - mounting agent routes');
  const agentRoutes = require('./routes/agent');
  app.use('/api/agent', agentRoutes);
} else {
  console.log('[SERVER] V2 architecture disabled - using legacy endpoints');
}

// Monitoring Routes (Always available)
try {
  const monitoringRoutes = require('./routes/monitoring');
  app.use('/api', monitoringRoutes);
  console.log('[SERVER] Monitoring routes loaded');
} catch (error) {
  console.error('[SERVER] Error loading monitoring routes:', error.message);
}

// Orchestrator API endpoint - Unified multi-agent interface
app.post("/api/orchestrator/query", async (req, res) => {
  try {
    const { query, session_id, org_id, time_zone } = req.body;
    
    // Input validation
    if (!query || query.length > 2000) {
      return res.status(400).json({ 
        error: "Query must be between 1 and 2000 characters" 
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
    const { data: sessionData, error: sessionError } = await supabase
      .from('bsa_tokens')
      .select('passkey, expires_at')
      .eq('session_id', session_id)
      .single();
    
    if (sessionError || !sessionData) {
      return res.status(401).json({ error: "Invalid session", requiresReauth: true });
    }
    
    // Get PassKey and check if needs refresh
    let passKey = sessionData.passkey;
    const expiresAt = new Date(sessionData.expires_at);
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    
    if (expiresAt < fiveMinutesFromNow) {
      console.log('[ORCHESTRATOR] PassKey expiring soon, refreshing...');
      const newPassKey = await refreshPassKey(session_id);
      if (!newPassKey) {
        return res.status(500).json({ error: "Failed to refresh authentication" });
      }
      passKey = newPassKey;
    }
    
    // Create orchestrator with dependencies
    const dependencies = {
      axios,
      axiosConfig,
      BSA_BASE: bsaConfig.getBaseUrl(),
      normalizeBSAResponse,
      getLLMClient,
      getWorkflowLLMClient,  // Add GPT-5 client for workflow agent
      parseDateQuery,
      extractDateFromQuery
    };
    
    console.log('[ORCHESTRATOR] Processing query:', query);
    
    // Create and invoke the orchestrator
    const orchestrator = await createSupervisorOrchestrator(
      passKey, 
      org_id, 
      time_zone || "UTC", 
      dependencies
    );
    
    const result = await orchestrator.invoke({ input: query });
    
    console.log('[ORCHESTRATOR] Result metadata:', result.metadata);
    
    res.json({ 
      query,
      response: result.output,
      metadata: result.metadata,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[ORCHESTRATOR] Error:', error);
    res.status(500).json({ error: "Failed to process orchestrated request" });
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

// Reset conversation endpoint - clears checkpoint data
app.post("/api/reset-conversation", async (req, res) => {
  const requestId = crypto.randomBytes(4).toString("hex");
  console.log(`[RESET:${requestId}] Starting conversation reset`);
  
  try {
    const { session_id } = req.body;
    
    if (!session_id) {
      return res.status(400).json({ error: "session_id required" });
    }
    
    // Get user_id from session
    const { data: tokenData, error: tokenError } = await supabase
      .from("bsa_tokens")
      .select("user_id")
      .eq("session_id", session_id)
      .single();
    
    if (tokenError || !tokenData) {
      console.error(`[RESET:${requestId}] Invalid session:`, tokenError);
      return res.status(401).json({ error: "Invalid session" });
    }
    
    const userId = tokenData.user_id;
    const threadId = `${session_id}:${userId}`;
    
    console.log(`[RESET:${requestId}] Clearing checkpoints for thread: ${threadId}`);
    
    // Get the shared connection pool
    const pool = getPgPool();
    if (!pool) {
      console.error(`[RESET:${requestId}] PostgreSQL connection not configured`);
      return res.status(500).json({ error: "Database connection not configured" });
    }
    
    // Use a transaction for atomic deletion
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Clear all checkpoint-related data for this thread
      // Track deletion counts for each table
      const writesResult = await client.query('DELETE FROM checkpoint_writes WHERE thread_id = $1', [threadId]);
      const blobsResult = await client.query('DELETE FROM checkpoint_blobs WHERE thread_id = $1', [threadId]);
      const checkpointsResult = await client.query('DELETE FROM checkpoints WHERE thread_id = $1', [threadId]);
      
      // Also clear checkpoint_migrations if any exist for this thread
      // Note: checkpoint_migrations might not have thread_id column, so we check first
      let migrationsDeleted = 0;
      try {
        const migrationCheckResult = await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'checkpoint_migrations' AND column_name = 'thread_id'"
        );
        if (migrationCheckResult.rows.length > 0) {
          const migrationsResult = await client.query('DELETE FROM checkpoint_migrations WHERE thread_id = $1', [threadId]);
          migrationsDeleted = migrationsResult.rowCount;
        }
      } catch (migrationErr) {
        console.log(`[RESET:${requestId}] Note: checkpoint_migrations table may not have thread_id column`);
      }
      
      // Commit the transaction
      await client.query('COMMIT');
      
      const deletionCounts = {
        checkpoint_writes: writesResult.rowCount,
        checkpoint_blobs: blobsResult.rowCount,
        checkpoints: checkpointsResult.rowCount,
        checkpoint_migrations: migrationsDeleted
      };
      
      console.log(`[RESET:${requestId}] Successfully cleared checkpoints:`, deletionCounts);
      
      res.json({ 
        success: true, 
        message: "Conversation reset successfully",
        thread_id: threadId,
        deleted: deletionCounts
      });
      
    } catch (err) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      throw err;
    } finally {
      // Release the client back to the pool
      client.release();
    }
    
  } catch (error) {
    console.error(`[RESET:${requestId}] Error:`, error);
    res.status(500).json({ error: "Failed to reset conversation" });
  }
});

// =========================
// Interrupt Polling Endpoints (for production/Vercel)
// =========================

const { getInterruptPollingService } = require('./websocket/pollingFallback');
const pollingService = getInterruptPollingService();

// Check for pending interrupts
app.get('/api/interrupts/poll', async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const interrupt = pollingService.checkPending(sessionId);
  
  if (interrupt) {
    res.json({
      hasInterrupt: true,
      interrupt: interrupt
    });
  } else {
    res.json({
      hasInterrupt: false
    });
  }
});

// Acknowledge interrupt receipt
app.post('/api/interrupts/acknowledge', async (req, res) => {
  const { session_id } = req.body;
  
  if (!session_id) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  pollingService.acknowledgeInterrupt(session_id);
  
  res.json({
    success: true,
    message: 'Interrupt acknowledged'
  });
});

// Submit approval response
app.post('/api/interrupts/approve', async (req, res) => {
  const { session_id, approval_data } = req.body;
  
  if (!session_id || !approval_data) {
    return res.status(400).json({ error: 'Session ID and approval data required' });
  }
  
  const result = await pollingService.handleApprovalResponse(session_id, approval_data);
  
  res.json(result);
});

// Get polling service stats (for debugging)
app.get('/api/interrupts/stats', async (req, res) => {
  const stats = pollingService.getStats();
  res.json(stats);
});

// Module exports for Vercel
module.exports = app;

// Local development server with WebSocket support
if (require.main === module) {
  // Use PORT from environment or default to 3000
  const PORT = process.env.PORT || 3000;
  
  // Create HTTP server for WebSocket attachment
  const server = require('http').createServer(app);
  
  // Initialize WebSocket server (only in development)
  if (process.env.NODE_ENV !== 'production') {
    const { getInterruptWebSocketServer } = require('./websocket/interrupts');
    const wsServer = getInterruptWebSocketServer();
    wsServer.initialize(server);
    console.log('WebSocket server initialized for development');
  }
  
  // Start the server
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`OAuth start: http://localhost:${PORT}/auth/start?session_id=test`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
    }
  });
}