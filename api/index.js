// ============================================
// DEPENDENCIES AND IMPORTS
// ============================================
// Express.js - Main web framework for creating the backend server
// This handles all HTTP requests from the Chrome extension
const express = require("express");

// Axios - HTTP client for making API calls to BlueSquareApps
// Used for OAuth token exchange and all BSA API interactions
const axios = require("axios");

// Crypto - Node.js built-in module for cryptographic operations
// Used to generate secure random state tokens for OAuth flow
const crypto = require("crypto");

// CORS - Cross-Origin Resource Sharing middleware
// Allows the Chrome extension to make requests to this backend
const cors = require("cors");

// Cookie Parser - Middleware to parse cookies from requests
// Currently used for potential cookie-based session management
const cookieParser = require("cookie-parser");

// Supabase Client - JavaScript client for Supabase database
// Used to store OAuth sessions and PassKeys securely
const { createClient } = require("@supabase/supabase-js");

// HTTP/HTTPS modules for keep-alive agents
const http = require('http');
const https = require('https');

// ============================================
// PERFORMANCE OPTIMIZATIONS
// ============================================
// Keep-alive agents for connection reuse
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

// Enhanced axios config
const axiosConfig = {
  httpAgent: keepAliveAgent,
  httpsAgent: keepAliveHttpsAgent,
  timeout: 10000
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

// ============================================
// EXPRESS APP INITIALIZATION
// ============================================
// Create the Express application instance
const app = express();

// Middleware to parse JSON request bodies
// Required for handling POST requests with JSON payloads
app.use(express.json());

// Middleware to parse cookies from incoming requests
// Enables reading and setting cookies for session management
app.use(cookieParser());

// Configure CORS to allow requests from any origin
// origin: true - Reflects the request origin in the CORS response
// credentials: true - Allows cookies and authentication headers
app.use(cors({ origin: true, credentials: true }));

// ============================================
// SUPABASE DATABASE CONNECTION
// ============================================
// Initialize Supabase client with service role key
// Service role key provides full database access (bypasses Row Level Security)
// This key should NEVER be exposed to the frontend
// Used to store OAuth sessions and PassKeys in the database
const supabase = createClient(
  process.env.SUPABASE_URL,           // Supabase project URL
  process.env.SUPABASE_SERVICE_ROLE_KEY  // Service role key for full access
);

// ============================================
// ENVIRONMENT VARIABLES AND CONFIGURATION
// ============================================
// BlueSquareApps (BSA) OAuth and API configuration
// These values are stored in environment variables for security

// Base URL for all BlueSquareApps API endpoints
// Example: https://rc.bluesquareapps.com
const BSA_BASE = process.env.BSA_BASE;

// OAuth 2.0 client credentials provided by BlueSquareApps
// Client ID identifies this application to BSA
const BSA_CLIENT_ID = process.env.BSA_CLIENT_ID;

// Client secret for OAuth authentication (keep secure!)
// Used during the OAuth token exchange process
const BSA_CLIENT_SECRET = process.env.BSA_CLIENT_SECRET;

// Redirect URI registered with BSA for OAuth callbacks
// Must match exactly what's configured in BSA OAuth settings
// Example: https://yourapp.vercel.app/auth/callback
const BSA_REDIRECT_URI = process.env.BSA_REDIRECT_URI;

// Base URL of this application (used for redirects)
// Example: https://yourapp.vercel.app
const APP_BASE_URL = process.env.APP_BASE_URL;

// ============================================
// OAUTH ENDPOINT 1: START AUTHENTICATION FLOW
// ============================================
// This endpoint initiates the OAuth 2.0 authorization flow with BlueSquareApps
// Called by the Chrome extension when user clicks "Login"
// 
// Flow:
// 1. Extension sends session_id (unique identifier for this login attempt)
// 2. Generate cryptographically secure random state token for CSRF protection
// 3. Store session_id and state in database for later validation
// 4. Redirect user to BSA OAuth authorization page
// 5. User will authenticate with BSA and grant permissions
// 6. BSA will redirect back to our callback endpoint with authorization code
app.get("/auth/start", async (req, res) => {
  try {
    // Extract session_id from query parameters
    // This is generated by the Chrome extension to track the login session
    const sessionId = req.query.session_id;
    console.log("[AUTH START] Session ID:", sessionId);
    
    // Validate that session_id was provided
    // Without it, we can't track this OAuth flow
    if (!sessionId) {
      console.error("[AUTH START] Missing session_id");
      return res.status(400).json({ error: "missing session_id" });
    }

    // Generate a cryptographically secure random state token
    // This prevents CSRF attacks by ensuring the callback is from our request
    // 16 bytes = 32 hex characters
    const state = crypto.randomBytes(16).toString("hex");
    console.log("[AUTH START] Generated state:", state);
    
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
    
    console.log("[AUTH START] Stored session in database");

    // Construct the BSA OAuth authorization URL
    // This is where we send the user to authenticate
    const authUrl = new URL(`${BSA_BASE}/oauth2/authorize`);
    
    // OAuth 2.0 standard parameters
    authUrl.searchParams.set("response_type", "code");        // We want an authorization code
    authUrl.searchParams.set("client_id", BSA_CLIENT_ID);      // Our app's client ID
    authUrl.searchParams.set("redirect_uri", BSA_REDIRECT_URI); // Where BSA should redirect after auth
    authUrl.searchParams.set("scope", "openid profile email");  // Permissions we're requesting
    authUrl.searchParams.set("state", state);                   // CSRF protection token
    
    console.log("[AUTH START] Redirecting to:", authUrl.toString());
    
    // Redirect the user's browser to BSA's OAuth page
    // User will authenticate there and grant permissions
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error("[AUTH START] Error:", error);
    res.status(500).json({ error: "internal server error" });
  }
});

// ============================================
// OAUTH ENDPOINT 2: HANDLE CALLBACK FROM BSA
// ============================================
// This endpoint receives the OAuth callback from BlueSquareApps
// BSA redirects here after user successfully authenticates
// 
// Flow:
// 1. BSA redirects here with authorization code and state
// 2. Immediately redirect user to BSA (better UX - no waiting page)
// 3. Process OAuth token exchange in the background
// 4. Chrome extension polls /auth/status to detect completion
//
// This asynchronous approach prevents the user from seeing a blank page
// while we perform the token exchange operations
app.get("/auth/callback", async (req, res) => {
  try {
    // Extract OAuth parameters from query string
    // code: Authorization code from BSA (exchange this for tokens)
    // state: CSRF protection token (must match what we sent)
    const { code, state } = req.query;
    console.log("[AUTH CALLBACK] Received code:", code ? "present" : "missing");
    console.log("[AUTH CALLBACK] Received state:", state);
    
    // Validate required parameters
    // Both code and state are required for secure OAuth flow
    if (!code || !state) {
      console.error("[AUTH CALLBACK] Missing code or state parameter");
      return res.status(400).send("Missing code or state parameter");
    }

    console.log("[AUTH CALLBACK] Redirecting user to BSA, processing in background");
    
    // IMPORTANT: Immediately redirect user to BSA main page
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

// ============================================
// BACKGROUND OAUTH PROCESSING FUNCTION
// ============================================
// This function runs asynchronously after the OAuth callback
// It performs the critical token exchange operations:
// 1. Validates the state token for CSRF protection
// 2. Exchanges authorization code for bearer token
// 3. Exchanges bearer token for PassKey
// 4. Stores PassKey in database for future API calls
//
// This is the core of the OAuth flow - converting the authorization
// code into a usable PassKey that can access BSA APIs
async function processOAuthCallback(code, state) {
  console.log("[PROCESS OAUTH] Starting background processing");
  try {
    // ========================================
    // STEP 1: VALIDATE STATE TOKEN
    // ========================================
    // Retrieve the OAuth session from database using the state token
    // This validates that the callback is from a request we initiated
    // and prevents CSRF attacks
    console.log("[PROCESS OAUTH] Validating state:", state);
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
    
    console.log("[PROCESS OAUTH] Found session:", row.session_id);

    // ========================================
    // STEP 2: EXCHANGE CODE FOR BEARER TOKEN
    // ========================================
    // First OAuth exchange: authorization code -> bearer token
    // This is standard OAuth 2.0 flow
    // The bearer token is temporary and will be exchanged for a PassKey
    console.log("[PROCESS OAUTH] Step 1: Exchanging code for bearer token");
    let tokenResp;
    try {
      // BSA's OAuth token endpoint
      const tokenUrl = `${BSA_BASE}/oauth2/token`;
      console.log("[PROCESS OAUTH] Token URL:", tokenUrl);
      
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
      console.log("[PROCESS OAUTH] Token response received, status:", tokenResp.status);
    } catch (tokenError) {
      // Log detailed error information for debugging
      console.error("[PROCESS OAUTH] Token exchange error:", tokenError.response?.data || tokenError.message);
      console.error("[PROCESS OAUTH] Token error status:", tokenError.response?.status);
      return;
    }

    // Extract the bearer token from response
    // This is a temporary token that we'll exchange for a PassKey
    const bearerToken = tokenResp.data.access_token;
    console.log("[PROCESS OAUTH] Bearer token:", bearerToken ? "received" : "missing");
    
    // Validate bearer token was received
    if (!bearerToken) {
      console.error("[PROCESS OAUTH] No bearer token in response:", tokenResp.data);
      return;
    }

    // ========================================
    // STEP 3: EXCHANGE BEARER TOKEN FOR PASSKEY
    // ========================================
    // Second exchange (BSA-specific): bearer token -> PassKey
    // PassKey is BSA's proprietary token format that's used for all API calls
    // It expires in 1 hour and can be refreshed using a special endpoint
    console.log("[PROCESS OAUTH] Step 2: Exchanging bearer token for PassKey");
    let passKeyResp;
    try {
      // BSA's PassKey exchange endpoint
      // This is specific to BlueSquareApps, not standard OAuth
      const passKeyUrl = `${BSA_BASE}/oauth2/passkey`;
      console.log("[PROCESS OAUTH] PassKey URL:", passKeyUrl);
      
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
      console.log("[PROCESS OAUTH] PassKey response received, status:", passKeyResp.status);
      console.log("[PROCESS OAUTH] PassKey response data:", passKeyResp.data);
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
    // Check both PascalCase 'PassKey' and lowercase 'passkey' field names
    const passKey = responseData?.PassKey || responseData?.passkey;
    console.log("[PROCESS OAUTH] PassKey:", passKey ? "received" : "missing");
    
    // Validate PassKey was received
    if (!passKey) {
      console.error("[PROCESS OAUTH] No PassKey in response:", passKeyResp.data);
      return;
    }

    // ========================================
    // STEP 4: STORE PASSKEY IN DATABASE
    // ========================================
    // Store the PassKey in Supabase for future API calls
    // PassKey expires in 1 hour and must be refreshed before expiry
    console.log("[PROCESS OAUTH] Step 3: Storing PassKey in database");
    
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
    
    console.log("[PROCESS OAUTH] PassKey stored successfully");
    
    // ========================================
    // STEP 5: VERIFY STORAGE (DEBUGGING)
    // ========================================
    // Read back the stored token to verify it was saved correctly
    // This helps debug any storage issues
    const { data: verifyRows, error: verifyError } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", row.session_id)
      .limit(1);
    
    if (verifyError) {
      console.error("[PROCESS OAUTH] Failed to verify storage:", verifyError);
    } else if (verifyRows && verifyRows[0]) {
      // Log verification details for debugging
      console.log("[PROCESS OAUTH] Verification - Token stored with fields:", Object.keys(verifyRows[0]));
      console.log("[PROCESS OAUTH] Verification - PassKey exists:", !!verifyRows[0].passkey);
      console.log("[PROCESS OAUTH] Verification - PassKey length:", verifyRows[0].passkey?.length);
    }

    // ========================================
    // STEP 6: MARK OAUTH SESSION AS USED
    // ========================================
    // Update the OAuth session to prevent reuse
    // This prevents replay attacks using the same state token
    await supabase
      .from("oauth_sessions")
      .update({ used_at: new Date().toISOString() })  // Mark when it was used
      .eq("id", row.id);

    console.log("[PROCESS OAUTH] OAuth flow completed successfully for session:", row.session_id);
  } catch (error) {
    // Catch any unexpected errors in the entire flow
    console.error("[PROCESS OAUTH] Unexpected error:", error);
  }
}

// ============================================
// PASSKEY REFRESH HELPER FUNCTION
// ============================================
// Refreshes an expired or expiring PassKey using BSA's refresh endpoint
// PassKeys expire after 1 hour and must be refreshed to maintain access
// 
// Process:
// 1. Retrieve current PassKey from database
// 2. Use current PassKey to authenticate refresh request
// 3. Receive new PassKey with fresh 1-hour expiry
// 4. Update database with new PassKey
//
// This function is called automatically when a PassKey has <5 minutes remaining
// or when an API call fails with 401 (authentication expired)
async function refreshPassKey(sessionId) {
  console.log("[REFRESH_PASSKEY] Starting refresh for session:", sessionId);
  
  try {
    // ========================================
    // STEP 1: RETRIEVE CURRENT PASSKEY
    // ========================================
    // Get the existing PassKey from database
    // We need this to authenticate the refresh request
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
    
    // Extract current PassKey
    const currentPassKey = rows[0].passkey;
    console.log("[REFRESH_PASSKEY] Current PassKey length:", currentPassKey?.length);
    
    // Validate PassKey exists
    if (!currentPassKey) {
      console.error("[REFRESH_PASSKEY] No existing PassKey to refresh");
      return null;
    }
    
    // ========================================
    // STEP 2: CALL BSA REFRESH ENDPOINT
    // ========================================
    // BSA provides a special login endpoint that accepts an existing PassKey
    // and returns a new one with fresh expiry
    // This is NOT a standard OAuth refresh - it's BSA-specific
    const refreshUrl = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/login.json`;
    console.log("[REFRESH_PASSKEY] Calling refresh endpoint:", refreshUrl);
    
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
      
      console.log("[REFRESH_PASSKEY] Refresh response status:", refreshResp.status);
      console.log("[REFRESH_PASSKEY] Refresh response keys:", Object.keys(refreshResp.data));
      
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
      
      console.log("[REFRESH_PASSKEY] New PassKey received, length:", newPassKey.length);
      
      // ========================================
      // STEP 3: UPDATE DATABASE WITH NEW PASSKEY
      // ========================================
      // Store the new PassKey with fresh 1-hour expiry
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      console.log("[REFRESH_PASSKEY] Setting new expiry:", expiresAt);
      
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
      
      console.log("[REFRESH_PASSKEY] PassKey refreshed and stored successfully");
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

// ============================================
// GET VALID PASSKEY HELPER FUNCTION
// ============================================
// Primary function for retrieving a valid PassKey for API calls
// This function handles automatic refresh when needed
//
// Features:
// 1. Retrieves PassKey from database
// 2. Checks expiration time
// 3. Automatically refreshes if <5 minutes remaining
// 4. Returns valid PassKey ready for API calls
//
// This is called by all API endpoints before making BSA requests
// It ensures we always have a valid, non-expired PassKey
async function getValidPassKey(sessionId) {
  console.log("[GET_PASSKEY] Querying database for session:", sessionId);
  
  // ========================================
  // STEP 1: RETRIEVE TOKEN FROM DATABASE
  // ========================================
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
  console.log("[GET_PASSKEY] Token found, fields:", Object.keys(token));
  
  // ========================================
  // STEP 2: VALIDATE PASSKEY EXISTS
  // ========================================
  const passKey = token.passkey;
  if (!passKey) {
    console.error("[GET_PASSKEY] Token exists but passkey field is empty");
    console.log("[GET_PASSKEY] Token data:", JSON.stringify(token).substring(0, 200));
    return null;
  }
  
  console.log("[GET_PASSKEY] PassKey found, length:", passKey.length);
  
  // ========================================
  // STEP 3: CHECK EXPIRATION & REFRESH IF NEEDED
  // ========================================
  // PassKeys expire after 1 hour
  // We refresh proactively when <5 minutes remaining to avoid failures
  if (token.expires_at) {
    const expiry = new Date(token.expires_at);
    const now = new Date();
    const timeLeft = expiry - now;  // Time remaining in milliseconds
    const minutesLeft = Math.floor(timeLeft / 60000);  // Convert to minutes
    
    console.log("[GET_PASSKEY] PassKey expires at:", token.expires_at);
    console.log("[GET_PASSKEY] Time remaining (minutes):", minutesLeft);
    
    // Refresh if less than 5 minutes remaining
    // This prevents API calls from failing due to expired tokens
    if (timeLeft < 5 * 60 * 1000) { // 5 minutes in milliseconds
      console.log("[GET_PASSKEY] PassKey expiring soon, attempting refresh...");
      
      // Attempt to refresh the PassKey
      const newPassKey = await refreshPassKey(sessionId);
      
      if (newPassKey) {
        // Refresh successful - return new PassKey
        console.log("[GET_PASSKEY] Successfully refreshed PassKey");
        return newPassKey;
      } else {
        // Refresh failed - return existing PassKey (might still work)
        console.error("[GET_PASSKEY] Failed to refresh PassKey, using existing");
        return passKey;
      }
    }
  } else {
    // No expiry set - this shouldn't happen but handle gracefully
    console.log("[GET_PASSKEY] No expiry time set for PassKey");
  }
  
  // PassKey is still valid - return it
  return passKey;
}

// ============================================
// AUTH STATUS ENDPOINT - FOR POLLING
// ============================================
// This endpoint is polled by the Chrome extension to check authentication status
// After initiating OAuth, the extension polls this to detect when authentication completes
//
// Returns:
// - { ok: true } - Authentication successful, PassKey stored
// - { ok: true, refreshed: true } - PassKey was expired but successfully refreshed
// - { ok: false } - Not authenticated or authentication pending
// - { ok: false, expired: true } - PassKey expired and refresh failed
//
// The extension polls this every second until it gets ok: true
app.get("/auth/status", async (req, res) => {
  try {
    // Extract session ID from query parameters
    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.json({ ok: false, error: "missing session_id" });
    }
    
    // ========================================
    // CHECK IF TOKEN EXISTS IN DATABASE
    // ========================================
    // Query for token with minimal fields (optimization)
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
    
    // ========================================
    // CHECK TOKEN EXPIRATION
    // ========================================
    // Verify the token hasn't expired
    // If expired, attempt to refresh it
    if (token.expires_at) {
      const expiry = new Date(token.expires_at);
      const now = new Date();
      
      if (expiry < now) {
        // Token has expired - attempt refresh
        console.log("[AUTH STATUS] Token expired, attempting refresh");
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

// ============================================
// BSA RESPONSE NORMALIZATION HELPER
// ============================================
// BSA APIs return data in an array wrapper format:
// [{ Results/Organizations/etc: [...], Valid: true, TotalResults: n, ... }]
// This helper unwraps the array and returns the normalized response
//
// Returns: { data: {...}, valid: boolean, error: string|null }
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

// ============================================
// FETCH ORGANIZATIONS HELPER FUNCTION
// ============================================
// Shared helper function to fetch user's organizations from BSA
// Used by the /api/orgs endpoint
//
// BSA Response Format:
// The API returns: [{ Organizations: [...], Valid: true, TotalResults: n, ... }]
// Each organization contains:
// - Id: Unique identifier for the organization
// - Name: Organization display name
// - Other metadata fields
//
// This function handles the array wrapper and extracts Organizations
async function fetchOrganizations(passKey) {
  // BSA endpoint for listing user's organizations
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json`;
  console.log("[FETCH_ORGS] Calling BSA API:", url);
  
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
    
    console.log("[FETCH_ORGS] BSA API response status:", resp.status);
    console.log("[FETCH_ORGS] BSA API raw response:", JSON.stringify(resp.data).substring(0, 200));
    
    // ========================================
    // NORMALIZE AND EXTRACT ORGANIZATIONS
    // ========================================
    // BSA returns: [{ Organizations: [...], Valid: true, ... }]
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
      console.log("[FETCH_ORGS] Found", orgsArray.length, "organizations");
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

// ============================================
// API ENDPOINT: LIST ORGANIZATIONS
// ============================================
// Returns a list of organizations the authenticated user has access to
// Called by the Chrome extension after successful authentication
//
// Request: GET /api/orgs?session_id=...
// Response: { Organizations: [...] }
//
// Each organization contains:
// - OrganizationId: Unique identifier
// - Name: Display name
// - Other metadata from BSA
//
// This endpoint handles authentication, automatic PassKey refresh,
// and retry logic for failed requests
app.get("/api/orgs", async (req, res) => {
  try {
    // Extract session ID from query parameters
    const sessionId = req.query.session_id;
    console.log("[API/ORGS] Request received with session_id:", sessionId);
    
    // Validate session ID is provided
    if (!sessionId) {
      console.error("[API/ORGS] Missing session_id parameter");
      return res.status(400).json({ error: "missing session_id" });
    }

    // ========================================
    // RETRIEVE AND VALIDATE PASSKEY
    // ========================================
    // Get valid PassKey (auto-refreshes if needed)
    console.log("[API/ORGS] Retrieving PassKey for session:", sessionId);
    const passKey = await getValidPassKey(sessionId);
    
    // Check if user is authenticated
    if (!passKey) {
      console.error("[API/ORGS] No PassKey found for session:", sessionId);
      return res.status(401).json({ error: "not authenticated" });
    }
    
    console.log("[API/ORGS] PassKey retrieved successfully, length:", passKey.length);
    
    try {
      // ========================================
      // FETCH ORGANIZATIONS FROM BSA
      // ========================================
      // Use the shared helper function to get organizations
      const orgs = await fetchOrganizations(passKey);
      
      // Return in the format expected by the frontend
      // Wrap in Organizations object for consistency
      res.json({ Organizations: orgs });
      
    } catch (apiError) {
      console.error("[API/ORGS] Error fetching organizations:", apiError.message);
      
      // ========================================
      // HANDLE 401 UNAUTHORIZED - RETRY LOGIC
      // ========================================
      // If we get 401, the PassKey might have just expired
      // Try refreshing once and retry the request
      if (apiError.response?.status === 401) {
        console.log("[API/ORGS] Got 401, attempting to refresh PassKey");
        
        // Attempt to refresh the PassKey
        const newPassKey = await refreshPassKey(sessionId);
        
        if (newPassKey) {
          // Refresh successful - retry the API call
          console.log("[API/ORGS] PassKey refreshed, retrying");
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

// ============================================
// API ENDPOINT: LIST CONTACTS FOR ORGANIZATION
// ============================================
// Returns a list of contacts for a specific organization
// Called by the Chrome extension when user selects an organization
//
// Request: POST /api/orgs/:orgId/contacts?session_id=...
// Response: { items: [...contacts...], ... }
//
// Each contact contains:
// - ContactId: Unique identifier
// - FirstName, LastName: Name fields
// - Email, Phone: Contact information
// - Other fields from BSA
//
// Note: This is a POST endpoint because BSA's API requires POST
// even though it's fetching data (not RESTful)
app.post("/api/orgs/:orgId/contacts", async (req, res) => {
  try {
    // Extract parameters
    const sessionId = req.query.session_id;      // From query string
    const orgId = req.params.orgId;              // From URL path
    
    // ========================================
    // VALIDATE REQUIRED PARAMETERS
    // ========================================
    if (!sessionId) {
      return res.status(400).json({ error: "missing session_id" });
    }
    if (!orgId) {
      return res.status(400).json({ error: "missing orgId" });
    }

    // ========================================
    // RETRIEVE AND VALIDATE PASSKEY
    // ========================================
    // Get valid PassKey (auto-refreshes if needed)
    const passKey = await getValidPassKey(sessionId);
    if (!passKey) {
      return res.status(401).json({ error: "not authenticated" });
    }

    // ========================================
    // PREPARE BSA API REQUEST
    // ========================================
    // BSA endpoint for listing objects within an organization
    const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json`;
    
    // Request payload specifying we want contacts
    const payload = { 
      PassKey: passKey,              // Authentication
      OrganizationId: orgId,         // Which organization
      ObjectName: "contact"          // Type of objects to retrieve
    };
    
    try {
      // ========================================
      // MAKE API CALL TO BSA
      // ========================================
      const resp = await axios.post(
        url, 
        payload, 
        { 
          headers: { "Content-Type": "application/json" },
          timeout: 10000  // 10 second timeout
        }
      );
      
      // ========================================
      // NORMALIZE AND EXTRACT CONTACTS
      // ========================================
      // BSA returns: [{ Results: [...], Valid: true, TotalResults: n, ... }]
      const normalized = normalizeBSAResponse(resp.data);
      
      // Check if response is valid
      if (!normalized.valid) {
        console.error("[API/CONTACTS] BSA returned invalid response:", normalized.error);
        return res.status(500).json({ error: normalized.error || 'Invalid response from BSA' });
      }
      
      // Extract Results array and return in format expected by sidepanel.js
      // The sidepanel expects Items field for contacts (see sidepanel.js:325)
      const contacts = normalized.data?.Results || [];
      
      // Return contacts in the format expected by the extension
      res.json({
        Items: contacts,                          // Use Items field for compatibility with sidepanel.js
        TotalResults: normalized.data?.TotalResults || contacts.length,
        Valid: true
      });
      
    } catch (apiError) {
      console.error("BSA API error:", apiError.response?.data || apiError.message);
      
      // ========================================
      // HANDLE 401 UNAUTHORIZED - RETRY LOGIC
      // ========================================
      // If authentication failed, try refreshing PassKey once
      if (apiError.response?.status === 401) {
        console.log("[API/CONTACTS] Got 401, attempting to refresh PassKey");
        
        // Attempt to refresh the PassKey
        const newPassKey = await refreshPassKey(sessionId);
        
        if (newPassKey) {
          // Refresh successful - retry with new PassKey
          console.log("[API/CONTACTS] PassKey refreshed, retrying");
          try {
            // Update payload with new PassKey
            const retryPayload = { ...payload, PassKey: newPassKey };
            
            // Retry the API call
            const retryResp = await axios.post(
              url, 
              retryPayload, 
              { 
                headers: { "Content-Type": "application/json" },
                timeout: 10000
              }
            );
            
            // Normalize and extract contacts from retry response
            const retryNormalized = normalizeBSAResponse(retryResp.data);
            
            if (!retryNormalized.valid) {
              console.error("[API/CONTACTS] Retry BSA returned invalid response:", retryNormalized.error);
              return res.status(500).json({ error: retryNormalized.error || 'Invalid response from BSA' });
            }
            
            const retryContacts = retryNormalized.data?.Results || [];
            
            // Return successful retry response in expected format
            return res.json({
              Items: retryContacts,
              TotalResults: retryNormalized.data?.TotalResults || retryContacts.length,
              Valid: true
            });
            
          } catch (retryError) {
            // Retry also failed
            console.error("BSA API retry error:", retryError.response?.data || retryError.message);
          }
        }
        
        // PassKey refresh failed or retry failed
        return res.status(401).json({ error: "authentication expired" });
      }
      
      // Other API errors (not authentication related)
      res.status(500).json({ error: "failed to fetch contacts" });
    }
  } catch (error) {
    // Unexpected errors
    console.error("Error in /api/orgs/:orgId/contacts:", error);
    res.status(500).json({ error: "internal server error" });
  }
});

// ============================================
// LANGCHAIN CALENDAR AGENT IMPLEMENTATION
// ============================================
// Helper functions for BSA API calls and Calendar Agent with tools

// Helper to normalize BSA responses (handle array wrapper format)
// NOTE: This is for regular BSA endpoints only, NOT for /oauth2/passkey
function normalizeBSAResponse(response) {
  // Most BSA endpoints return responses in array format: [{ data }]
  // Exception: /oauth2/passkey returns plain object { passkey, user_id, expires_in }
  // This helper unwraps the array and validates the response
  if (!response) {
    return { data: null, valid: false, error: 'No response data' };
  }
  
  // Unwrap array wrapper
  const responseData = Array.isArray(response) ? response[0] : response;
  
  // Check Valid field for errors
  if (responseData?.Valid === false) {
    return {
      data: responseData,
      valid: false,
      error: responseData.ResponseMessage || responseData.StackMessage || 'BSA API error'
    };
  }
  
  return {
    data: responseData,
    valid: true,
    error: null
  };
}

// Fetch appointments from BSA
async function getAppointments(passKey, orgId, options = {}) {
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json`;
  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "appointment",
    IncludeExtendedProperties: true,
    ResultsPerPage: options.limit || 100,
    PageOffset: options.offset || 0
  };
  
  const resp = await axios.post(url, payload, axiosConfig);
  // Handle array wrapper format: [{ Results: [...], Valid: true }]
  const normalized = normalizeBSAResponse(resp.data);
  
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Invalid BSA response');
  }
  
  return {
    appointments: normalized.data?.Results || [],
    totalResults: normalized.data?.TotalResults || 0,
    valid: true
  };
}

// Get contacts linked to an appointment
async function getAppointmentContacts(passKey, orgId, appointmentId) {
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/listLinked.json`;
  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "linker_appointments_contacts",
    ListObjectName: "contact",
    LinkParentId: appointmentId
  };
  
  const resp = await axios.post(url, payload, axiosConfig);
  // Handle array wrapper format: [{ Results: [...], Valid: true }]
  const normalized = normalizeBSAResponse(resp.data);
  
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Invalid BSA response');
  }
  
  return normalized.data?.Results || [];
}

// Helper function for safe JSON parsing in tools
function parseToolInput(input, schema = {}) {
  try {
    const parsed = JSON.parse(input || '{}');
    
    // Validate required fields if schema provided
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (parsed[field] === undefined || parsed[field] === null) {
          return { 
            error: `Missing required field: '${field}'`, 
            isError: true 
          };
        }
      }
    }
    
    return { data: parsed, isError: false };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { 
        error: `Invalid JSON format: ${error.message}`, 
        isError: true 
      };
    }
    return { 
      error: `Error parsing input: ${error.message}`, 
      isError: true 
    };
  }
}

// Define Calendar Agent Tools using StructuredTool with Zod
function createCalendarTools(StructuredTool, z, passKey, orgId) {
  return [
    // Tool 1: Get appointments
    new StructuredTool({
      name: "get_appointments",
      description: "Fetch calendar appointments. Use when user asks about meetings, appointments, or calendar events.",
      schema: z.object({
        limit: z.number().optional().default(100).describe("Maximum number of appointments to return"),
        offset: z.number().optional().default(0).describe("Number of appointments to skip")
      }),
      func: async ({ limit, offset }) => {
        try {
          const data = await getAppointments(passKey, orgId, { limit, offset });
          
          return JSON.stringify({
            count: data.appointments?.length || 0,
            appointments: data.appointments?.slice(0, 5), // Limit for readability
            total: data.totalResults || 0
          });
        } catch (error) {
          console.error("[Calendar Tool] Error fetching appointments:", error);
          return JSON.stringify({ 
            error: `Failed to fetch appointments: ${error.message}` 
          });
        }
      }
    }),
    
    // Tool 2: Search appointments by date range
    new StructuredTool({
      name: "search_appointments_by_date",
      description: "Search appointments by date range. Use for queries about specific dates or time periods.",
      schema: z.object({
        startDate: z.string().describe("Start date in YYYY-MM-DD format"),
        endDate: z.string().describe("End date in YYYY-MM-DD format")
      }),
      func: async ({ startDate, endDate }) => {
        try {
          // Validate date formats
          const startDateObj = new Date(startDate);
          const endDateObj = new Date(endDate);
          if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
            return JSON.stringify({ 
              error: "Invalid date format. Please use YYYY-MM-DD format.",
              example: "startDate: '2025-09-01', endDate: '2025-09-30'"
            });
          }
          
          // Fetch and filter appointments by date
          const response = await getAppointments(passKey, orgId);
          const filtered = response.appointments?.filter(apt => {
            const aptDate = new Date(apt.StartTime);
            return aptDate >= startDateObj && aptDate <= endDateObj;
          });
          
          return JSON.stringify({
            dateRange: { startDate, endDate },
            count: filtered?.length || 0,
            appointments: filtered?.slice(0, 10)
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to search appointments: ${error.message}` 
          });
        }
      }
    }),
    
    // Tool 3: Get appointment contacts
    new StructuredTool({
      name: "get_appointment_contacts",
      description: "Get contacts linked to a specific appointment. Use when user asks who is attending a meeting.",
      schema: z.object({
        appointmentId: z.string().describe("The appointment ID to get contacts for")
      }),
      func: async ({ appointmentId }) => {
        try {
          const contacts = await getAppointmentContacts(passKey, orgId, appointmentId);
          return JSON.stringify({
            appointmentId,
            contacts,
            count: contacts.length
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to fetch appointment contacts: ${error.message}` 
          });
        }
      }
    }),
    
    // Tool 4: Get appointment details
    new StructuredTool({
      name: "get_appointment_details",
      description: "Get detailed information about a specific appointment by ID.",
      schema: z.object({
        appointmentId: z.string().describe("The appointment ID to get details for")
      }),
      func: async ({ appointmentId }) => {
        try {
          const response = await getAppointments(passKey, orgId);
          const appointment = response.appointments?.find(apt => apt.Id === appointmentId);
          
          if (!appointment) {
            return JSON.stringify({ 
              error: "Appointment not found",
              appointmentId 
            });
          }
          
          return JSON.stringify({
            appointment,
            formattedDate: new Date(appointment.StartTime).toLocaleString(),
            formattedEndDate: new Date(appointment.EndTime).toLocaleString()
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to fetch appointment details: ${error.message}` 
          });
        }
      }
    }),
    
    // Tool 5: Get organizations
    new StructuredTool({
      name: "get_organizations",
      description: "List available organizations. Use when user needs to select an organization.",
      schema: z.object({}), // No input required
      func: async () => {
        try {
          const orgs = await fetchOrganizations(passKey);
          return JSON.stringify({
            organizations: orgs,
            count: orgs.length
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to fetch organizations: ${error.message}` 
          });
        }
      }
    })
  ];
}

// Create Calendar Agent
async function createCalendarAgent(passKey, orgId) {
  // Dynamic imports for LangChain and Zod
  const { z } = await import("zod");
  const { StructuredTool } = await import("@langchain/core/tools");
  const { ChatOpenAI } = await import("@langchain/openai");
  const { AgentExecutor, createToolCallingAgent } = await import("langchain/agents");
  const { ChatPromptTemplate } = await import("@langchain/core/prompts");
  
  const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0
  });
  
  const tools = createCalendarTools(StructuredTool, z, passKey, orgId);
  
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a helpful calendar assistant. Use the available tools to answer questions about appointments, meetings, and schedules. Be concise and informative."],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"]
  ]);
  
  const agent = await createToolCallingAgent({
    llm,
    tools,
    prompt
  });
  
  return new AgentExecutor({
    agent,
    tools,
    verbose: true // Set to false in production
  });
}

// ============================================
// RATE LIMITING IMPLEMENTATION
// ============================================
// In-memory rate limiting (per-instance)
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

// ============================================
// ASSISTANT API ENDPOINT
// ============================================
// Endpoint for AI assistant queries using Calendar Agent
app.post("/api/assistant/query", async (req, res) => {
  const requestId = crypto.randomBytes(8).toString('hex');
  
  try {
    const { query, session_id, org_id } = req.body;
    console.log(`[ASSISTANT:${requestId}] Query: "${query}"`);
    
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
    console.error(`[ASSISTANT:${requestId}] Error:`, error);
    res.status(500).json({ 
      error: "Failed to process query",
      details: error.message 
    });
  }
});

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
// Simple endpoint to verify the server is running
// Used by monitoring services and deployment checks
//
// Request: GET /health
// Response: { status: "healthy", timestamp: "..." }
//
// Returns current timestamp to verify server is responsive
app.get("/health", (_, res) => {
  res.json({ 
    status: "healthy",                        // Server status
    timestamp: new Date().toISOString()        // Current server time
  });
});

// ============================================
// GLOBAL ERROR HANDLING MIDDLEWARE
// ============================================
// Catches any unhandled errors in the application
// This is a safety net to prevent the server from crashing
// and to ensure clients always get a proper error response
//
// Express calls this middleware when:
// - An async function throws an error
// - next(error) is called
// - Synchronous errors occur in route handlers
app.use((err, _, res, __) => {
  // Log the full error for debugging
  console.error("Unhandled error:", err);
  
  // Send generic error response to client
  // Don't expose internal error details for security
  res.status(500).json({ error: "internal server error" });
});

// ============================================
// MODULE EXPORTS AND SERVER INITIALIZATION
// ============================================
// Export the Express app for Vercel serverless deployment
// Vercel imports this module and handles the HTTP server
module.exports = app;

// ============================================
// LOCAL DEVELOPMENT SERVER
// ============================================
// When running locally (not on Vercel), start the Express server
// This allows local testing with 'npm run dev'
//
// require.main === module checks if this file is being run directly
// (not imported by another module like Vercel)
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