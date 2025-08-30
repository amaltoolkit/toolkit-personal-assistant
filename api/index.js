const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BSA_BASE = process.env.BSA_BASE;
const BSA_CLIENT_ID = process.env.BSA_CLIENT_ID;
const BSA_CLIENT_SECRET = process.env.BSA_CLIENT_SECRET;
const BSA_REDIRECT_URI = process.env.BSA_REDIRECT_URI;
const APP_BASE_URL = process.env.APP_BASE_URL;

// 1) Start OAuth
app.get("/auth/start", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    console.log("[AUTH START] Session ID:", sessionId);
    
    if (!sessionId) {
      console.error("[AUTH START] Missing session_id");
      return res.status(400).json({ error: "missing session_id" });
    }

    const state = crypto.randomBytes(16).toString("hex");
    console.log("[AUTH START] Generated state:", state);
    
    const { error } = await supabase
      .from("oauth_sessions")
      .insert({ session_id: sessionId, state });
    
    if (error) {
      console.error("[AUTH START] Database error:", error);
      return res.status(500).json({ error: "database error" });
    }
    
    console.log("[AUTH START] Stored session in database");

    const authUrl = new URL(`${BSA_BASE}/oauth2/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", BSA_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", BSA_REDIRECT_URI);
    authUrl.searchParams.set("scope", "openid profile email");
    authUrl.searchParams.set("state", state);
    
    console.log("[AUTH START] Redirecting to:", authUrl.toString());
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error("[AUTH START] Error:", error);
    res.status(500).json({ error: "internal server error" });
  }
});

// 2) OAuth callback
app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    console.log("[AUTH CALLBACK] Received code:", code ? "present" : "missing");
    console.log("[AUTH CALLBACK] Received state:", state);
    
    if (!code || !state) {
      console.error("[AUTH CALLBACK] Missing code or state parameter");
      return res.status(400).send("Missing code or state parameter");
    }

    console.log("[AUTH CALLBACK] Redirecting user to BSA, processing in background");
    // Immediately redirect user to BSA while we process in the background
    res.redirect(`${BSA_BASE}`);

    // Continue processing asynchronously
    processOAuthCallback(code, state).catch(error => {
      console.error("[AUTH CALLBACK] Background OAuth processing error:", error);
    });

  } catch (error) {
    console.error("[AUTH CALLBACK] Error:", error);
    res.status(500).send("Internal server error");
  }
});

// Process OAuth callback in the background
async function processOAuthCallback(code, state) {
  console.log("[PROCESS OAUTH] Starting background processing");
  try {
    // Validate state
    console.log("[PROCESS OAUTH] Validating state:", state);
    const { data: rows, error } = await supabase
      .from("oauth_sessions")
      .select("*")
      .eq("state", state)
      .is("used_at", null)
      .limit(1);
    
    if (error) {
      console.error("[PROCESS OAUTH] Database error:", error);
      return;
    }
    
    const row = rows && rows[0];
    if (!row) {
      console.error("[PROCESS OAUTH] Invalid or expired state");
      return;
    }
    
    console.log("[PROCESS OAUTH] Found session:", row.session_id);

    // Step 1: Exchange code for bearer token
    console.log("[PROCESS OAUTH] Step 1: Exchanging code for bearer token");
    let tokenResp;
    try {
      const tokenUrl = `${BSA_BASE}/oauth2/token`;
      console.log("[PROCESS OAUTH] Token URL:", tokenUrl);
      
      tokenResp = await axios.post(
        tokenUrl,
        {
          grant_type: "authorization_code",
          client_id: BSA_CLIENT_ID,
          client_secret: BSA_CLIENT_SECRET,
          code,
          redirect_uri: BSA_REDIRECT_URI
        },
        { 
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 10000
        }
      );
      console.log("[PROCESS OAUTH] Token response received, status:", tokenResp.status);
    } catch (tokenError) {
      console.error("[PROCESS OAUTH] Token exchange error:", tokenError.response?.data || tokenError.message);
      console.error("[PROCESS OAUTH] Token error status:", tokenError.response?.status);
      return;
    }

    const bearerToken = tokenResp.data.access_token;
    console.log("[PROCESS OAUTH] Bearer token:", bearerToken ? "received" : "missing");
    
    if (!bearerToken) {
      console.error("[PROCESS OAUTH] No bearer token in response:", tokenResp.data);
      return;
    }

    // Step 2: Exchange bearer token for PassKey
    console.log("[PROCESS OAUTH] Step 2: Exchanging bearer token for PassKey");
    let passKeyResp;
    try {
      const passKeyUrl = `${BSA_BASE}/oauth2/passkey`;
      console.log("[PROCESS OAUTH] PassKey URL:", passKeyUrl);
      
      passKeyResp = await axios.post(
        passKeyUrl,
        {},
        {
          headers: {
            "Authorization": `Bearer ${bearerToken}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        }
      );
      console.log("[PROCESS OAUTH] PassKey response received, status:", passKeyResp.status);
      console.log("[PROCESS OAUTH] PassKey response data:", passKeyResp.data);
    } catch (passKeyError) {
      console.error("[PROCESS OAUTH] PassKey exchange error:", passKeyError.response?.data || passKeyError.message);
      console.error("[PROCESS OAUTH] PassKey error status:", passKeyError.response?.status);
      return;
    }

    const passKey = passKeyResp.data.passkey || passKeyResp.data.PassKey || passKeyResp.data.passKey;
    console.log("[PROCESS OAUTH] PassKey:", passKey ? "received" : "missing");
    
    if (!passKey) {
      console.error("[PROCESS OAUTH] No PassKey in response, trying all fields:", passKeyResp.data);
      return;
    }

    // Step 3: Store only the PassKey (expires in 1 hour)
    console.log("[PROCESS OAUTH] Step 3: Storing PassKey in database");
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString(); // 1 hour expiry

    const { error: tokenError } = await supabase
      .from("bsa_tokens")
      .upsert({
        session_id: row.session_id,
        passkey: passKey,  // Store PassKey in passkey field
        refresh_token: null,    // No refresh token, we'll use PassKey to refresh
        expires_at: expiresAt,
        updated_at: new Date().toISOString()
      }, { 
        onConflict: "session_id" 
      });
    
    if (tokenError) {
      console.error("[PROCESS OAUTH] Failed to store PassKey:", tokenError);
      console.error("[PROCESS OAUTH] Storage error details:", JSON.stringify(tokenError));
      return;
    }
    
    console.log("[PROCESS OAUTH] PassKey stored successfully");
    
    // Verify storage by reading back
    const { data: verifyRows, error: verifyError } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", row.session_id)
      .limit(1);
    
    if (verifyError) {
      console.error("[PROCESS OAUTH] Failed to verify storage:", verifyError);
    } else if (verifyRows && verifyRows[0]) {
      console.log("[PROCESS OAUTH] Verification - Token stored with fields:", Object.keys(verifyRows[0]));
      console.log("[PROCESS OAUTH] Verification - PassKey exists:", !!verifyRows[0].passkey);
      console.log("[PROCESS OAUTH] Verification - PassKey length:", verifyRows[0].passkey?.length);
    }

    // Mark session as used
    await supabase
      .from("oauth_sessions")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id);

    console.log("[PROCESS OAUTH] OAuth flow completed successfully for session:", row.session_id);
  } catch (error) {
    console.error("[PROCESS OAUTH] Unexpected error:", error);
  }
}

// Helper function to refresh PassKey
async function refreshPassKey(sessionId) {
  console.log("[REFRESH_PASSKEY] Starting refresh for session:", sessionId);
  
  try {
    // Get current PassKey
    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", sessionId)
      .limit(1);
    
    if (error || !rows || !rows[0]) {
      console.error("[REFRESH_PASSKEY] Failed to get current PassKey:", error);
      return null;
    }
    
    const currentPassKey = rows[0].passkey;
    console.log("[REFRESH_PASSKEY] Current PassKey length:", currentPassKey?.length);
    
    if (!currentPassKey) {
      console.error("[REFRESH_PASSKEY] No existing PassKey to refresh");
      return null;
    }
    
    // Refresh PassKey using the login endpoint
    const refreshUrl = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/login.json`;
    console.log("[REFRESH_PASSKEY] Calling refresh endpoint:", refreshUrl);
    
    try {
      const refreshResp = await axios.post(
        refreshUrl,
        { PassKey: currentPassKey },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 10000
        }
      );
      
      console.log("[REFRESH_PASSKEY] Refresh response status:", refreshResp.status);
      console.log("[REFRESH_PASSKEY] Refresh response keys:", Object.keys(refreshResp.data));
      
      const newPassKey = refreshResp.data.PassKey || refreshResp.data.passKey || refreshResp.data.passkey;
      if (!newPassKey) {
        console.error("[REFRESH_PASSKEY] No new PassKey in refresh response:", refreshResp.data);
        return null;
      }
      
      console.log("[REFRESH_PASSKEY] New PassKey received, length:", newPassKey.length);
      
      // Update stored PassKey with new 1-hour expiry
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      console.log("[REFRESH_PASSKEY] Setting new expiry:", expiresAt);
      
      const { error: updateError } = await supabase
        .from("bsa_tokens")
        .update({
          passkey: newPassKey,
          expires_at: expiresAt,
          updated_at: new Date().toISOString()
        })
        .eq("session_id", sessionId);
      
      if (updateError) {
        console.error("[REFRESH_PASSKEY] Failed to update PassKey in database:", updateError);
        return null;
      }
      
      console.log("[REFRESH_PASSKEY] PassKey refreshed and stored successfully");
      return newPassKey;
      
    } catch (refreshError) {
      console.error("[REFRESH_PASSKEY] API error - Status:", refreshError.response?.status);
      console.error("[REFRESH_PASSKEY] API error - Data:", refreshError.response?.data);
      console.error("[REFRESH_PASSKEY] API error - Message:", refreshError.message);
      return null;
    }
  } catch (error) {
    console.error("[REFRESH_PASSKEY] Unexpected error:", error);
    return null;
  }
}

// Helper function to get valid PassKey (refreshes if needed)
async function getValidPassKey(sessionId) {
  console.log("[GET_PASSKEY] Querying database for session:", sessionId);
  
  const { data: rows, error } = await supabase
    .from("bsa_tokens")
    .select("*")
    .eq("session_id", sessionId)
    .limit(1);
  
  if (error) {
    console.error("[GET_PASSKEY] Database error:", error);
    return null;
  }
  
  if (!rows || !rows[0]) {
    console.error("[GET_PASSKEY] No token found for session:", sessionId);
    console.log("[GET_PASSKEY] Query returned rows:", rows);
    return null;
  }
  
  const token = rows[0];
  console.log("[GET_PASSKEY] Token found, fields:", Object.keys(token));
  
  const passKey = token.passkey;
  if (!passKey) {
    console.error("[GET_PASSKEY] Token exists but passkey field is empty");
    console.log("[GET_PASSKEY] Token data:", JSON.stringify(token).substring(0, 200));
    return null;
  }
  
  console.log("[GET_PASSKEY] PassKey found, length:", passKey.length);
  
  // Check if PassKey is about to expire (refresh if less than 5 minutes left)
  if (token.expires_at) {
    const expiry = new Date(token.expires_at);
    const now = new Date();
    const timeLeft = expiry - now;
    const minutesLeft = Math.floor(timeLeft / 60000);
    
    console.log("[GET_PASSKEY] PassKey expires at:", token.expires_at);
    console.log("[GET_PASSKEY] Time remaining (minutes):", minutesLeft);
    
    if (timeLeft < 5 * 60 * 1000) { // Less than 5 minutes
      console.log("[GET_PASSKEY] PassKey expiring soon, attempting refresh...");
      const newPassKey = await refreshPassKey(sessionId);
      if (newPassKey) {
        console.log("[GET_PASSKEY] Successfully refreshed PassKey");
        return newPassKey;
      } else {
        console.error("[GET_PASSKEY] Failed to refresh PassKey, using existing");
        return passKey;
      }
    }
  } else {
    console.log("[GET_PASSKEY] No expiry time set for PassKey");
  }
  
  return passKey;
}

// 3) Auth status for polling
app.get("/auth/status", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.json({ ok: false, error: "missing session_id" });
    }
    
    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("session_id, expires_at")
      .eq("session_id", sessionId)
      .limit(1);
    
    if (error) {
      console.error("Database error:", error);
      return res.json({ ok: false, error: "database error" });
    }
    
    const token = rows && rows[0];
    if (!token) {
      return res.json({ ok: false });
    }
    
    // Check if token is expired
    if (token.expires_at) {
      const expiry = new Date(token.expires_at);
      if (expiry < new Date()) {
        // Try to refresh the PassKey
        const newPassKey = await refreshPassKey(sessionId);
        if (newPassKey) {
          return res.json({ ok: true, refreshed: true });
        }
        return res.json({ ok: false, expired: true });
      }
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error("Error in /auth/status:", error);
    res.json({ ok: false, error: "internal error" });
  }
});

// 4) List organizations
app.get("/api/orgs", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    console.log("[API/ORGS] Request received with session_id:", sessionId);
    
    if (!sessionId) {
      console.error("[API/ORGS] Missing session_id parameter");
      return res.status(400).json({ error: "missing session_id" });
    }

    // Get valid PassKey (auto-refreshes if needed)
    console.log("[API/ORGS] Retrieving PassKey for session:", sessionId);
    const passKey = await getValidPassKey(sessionId);
    
    if (!passKey) {
      console.error("[API/ORGS] No PassKey found for session:", sessionId);
      return res.status(401).json({ error: "not authenticated" });
    }
    
    console.log("[API/ORGS] PassKey retrieved successfully, length:", passKey.length);
    console.log("[API/ORGS] PassKey prefix:", passKey.substring(0, 10) + "...");

    const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json`;
    console.log("[API/ORGS] Calling BSA API:", url);
    
    // Try different field name variations for PassKey
    let payload = { PassKey: passKey };
    console.log("[API/ORGS] Request payload structure:", Object.keys(payload));
    console.log("[API/ORGS] Trying with field name 'PassKey':", payload);
    
    try {
      const resp = await axios.post(
        url, 
        payload, 
        { 
          headers: { "Content-Type": "application/json" },
          timeout: 10000
        }
      );
      
      console.log("[API/ORGS] BSA API response status:", resp.status);
      console.log("[API/ORGS] BSA API response data type:", typeof resp.data);
      console.log("[API/ORGS] BSA API response keys:", resp.data ? Object.keys(resp.data) : "null");
      console.log("[API/ORGS] Full response data:", JSON.stringify(resp.data));
      
      // Log first part of response for debugging
      if (resp.data) {
        const dataPreview = JSON.stringify(resp.data).substring(0, 200);
        console.log("[API/ORGS] Response data preview:", dataPreview);
        
        // Check if response indicates an error
        if (resp.data.error || resp.data.Error) {
          console.error("[API/ORGS] BSA API returned error:", resp.data.error || resp.data.Error);
          return res.status(500).json({ error: "BSA API error", details: resp.data.error || resp.data.Error });
        }
        
        // Check if response has organizations
        const orgsArray = resp.data.organizations || resp.data.Organizations || resp.data.items || resp.data;
        if (Array.isArray(orgsArray)) {
          console.log("[API/ORGS] Found organizations array with", orgsArray.length, "items");
        } else {
          console.log("[API/ORGS] Response structure:", JSON.stringify(resp.data).substring(0, 500));
        }
      }
      
      res.json(resp.data);
    } catch (apiError) {
      console.error("[API/ORGS] BSA API error - Status:", apiError.response?.status);
      console.error("[API/ORGS] BSA API error - Data:", JSON.stringify(apiError.response?.data));
      console.error("[API/ORGS] BSA API error - Message:", apiError.message);
      console.error("[API/ORGS] BSA API error - Headers:", apiError.response?.headers);
      
      // If error is not 401, try with lowercase 'passkey' field
      if (apiError.response?.status !== 401) {
        console.log("[API/ORGS] Retrying with lowercase 'passkey' field");
        try {
          const retryResp = await axios.post(
            url,
            { passkey: passKey },  // Try lowercase
            {
              headers: { "Content-Type": "application/json" },
              timeout: 10000
            }
          );
          console.log("[API/ORGS] Lowercase retry successful!");
          return res.json(retryResp.data);
        } catch (lcError) {
          console.error("[API/ORGS] Lowercase retry also failed:", lcError.response?.status);
        }
      }
      
      if (apiError.response?.status === 401) {
        console.log("[API/ORGS] Got 401, attempting to refresh PassKey");
        // Try to refresh PassKey once more
        const newPassKey = await refreshPassKey(sessionId);
        if (newPassKey) {
          console.log("[API/ORGS] PassKey refreshed, retrying API call");
          // Retry with new PassKey
          try {
            const retryResp = await axios.post(
              url, 
              { PassKey: newPassKey }, 
              { 
                headers: { "Content-Type": "application/json" },
                timeout: 10000
              }
            );
            console.log("[API/ORGS] Retry successful, status:", retryResp.status);
            return res.json(retryResp.data);
          } catch (retryError) {
            console.error("[API/ORGS] Retry failed - Status:", retryError.response?.status);
            console.error("[API/ORGS] Retry failed - Data:", retryError.response?.data);
          }
        }
        return res.status(401).json({ error: "authentication expired" });
      }
      res.status(500).json({ error: "failed to fetch organizations", details: apiError.message });
    }
  } catch (error) {
    console.error("[API/ORGS] Unexpected error:", error);
    console.error("[API/ORGS] Error stack:", error.stack);
    res.status(500).json({ error: "internal server error" });
  }
});

// 5) List contacts for organization
app.post("/api/orgs/:orgId/contacts", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    const orgId = req.params.orgId;
    
    if (!sessionId) {
      return res.status(400).json({ error: "missing session_id" });
    }
    if (!orgId) {
      return res.status(400).json({ error: "missing orgId" });
    }

    // Get valid PassKey (auto-refreshes if needed)
    const passKey = await getValidPassKey(sessionId);
    if (!passKey) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json`;
    const payload = { 
      PassKey: passKey, 
      OrganizationId: orgId, 
      ObjectName: "contact" 
    };
    
    try {
      const resp = await axios.post(
        url, 
        payload, 
        { 
          headers: { "Content-Type": "application/json" },
          timeout: 10000
        }
      );
      
      res.json(resp.data);
    } catch (apiError) {
      console.error("BSA API error:", apiError.response?.data || apiError.message);
      if (apiError.response?.status === 401) {
        // Try to refresh PassKey once more
        const newPassKey = await refreshPassKey(sessionId);
        if (newPassKey) {
          // Retry with new PassKey
          try {
            const retryPayload = { ...payload, PassKey: newPassKey };
            const retryResp = await axios.post(
              url, 
              retryPayload, 
              { 
                headers: { "Content-Type": "application/json" },
                timeout: 10000
              }
            );
            return res.json(retryResp.data);
          } catch (retryError) {
            console.error("BSA API retry error:", retryError.response?.data || retryError.message);
          }
        }
        return res.status(401).json({ error: "authentication expired" });
      }
      res.status(500).json({ error: "failed to fetch contacts" });
    }
  } catch (error) {
    console.error("Error in /api/orgs/:orgId/contacts:", error);
    res.status(500).json({ error: "internal server error" });
  }
});

// Health check endpoint
app.get("/health", (_, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, _, res, __) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "internal server error" });
});

// Export for Vercel
module.exports = app;

// For local development
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}