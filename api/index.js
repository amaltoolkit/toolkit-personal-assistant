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
      return;
    }
    
    console.log("[PROCESS OAUTH] PassKey stored successfully");

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
  try {
    // Get current PassKey
    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", sessionId)
      .limit(1);
    
    if (error || !rows || !rows[0]) {
      console.error("Failed to get current PassKey:", error);
      return null;
    }
    
    const currentPassKey = rows[0].passkey;
    
    // Refresh PassKey using the login endpoint
    try {
      const refreshResp = await axios.post(
        `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/login.json`,
        { PassKey: currentPassKey },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 10000
        }
      );
      
      const newPassKey = refreshResp.data.PassKey || refreshResp.data.passKey || refreshResp.data.passkey;
      if (!newPassKey) {
        console.error("No new PassKey in refresh response:", refreshResp.data);
        return null;
      }
      
      // Update stored PassKey with new 1-hour expiry
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      
      const { error: updateError } = await supabase
        .from("bsa_tokens")
        .update({
          passkey: newPassKey,
          expires_at: expiresAt,
          updated_at: new Date().toISOString()
        })
        .eq("session_id", sessionId);
      
      if (updateError) {
        console.error("Failed to update PassKey:", updateError);
        return null;
      }
      
      console.log("PassKey refreshed successfully for session:", sessionId);
      return newPassKey;
      
    } catch (refreshError) {
      console.error("PassKey refresh API error:", refreshError.response?.data || refreshError.message);
      return null;
    }
  } catch (error) {
    console.error("Error in refreshPassKey:", error);
    return null;
  }
}

// Helper function to get valid PassKey (refreshes if needed)
async function getValidPassKey(sessionId) {
  const { data: rows, error } = await supabase
    .from("bsa_tokens")
    .select("*")
    .eq("session_id", sessionId)
    .limit(1);
  
  if (error || !rows || !rows[0]) {
    return null;
  }
  
  const token = rows[0];
  const passKey = token.passkey;
  
  // Check if PassKey is about to expire (refresh if less than 5 minutes left)
  if (token.expires_at) {
    const expiry = new Date(token.expires_at);
    const now = new Date();
    const timeLeft = expiry - now;
    
    if (timeLeft < 5 * 60 * 1000) { // Less than 5 minutes
      console.log("PassKey expiring soon, refreshing...");
      const newPassKey = await refreshPassKey(sessionId);
      return newPassKey || passKey; // Return new or fall back to current
    }
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
    if (!sessionId) {
      return res.status(400).json({ error: "missing session_id" });
    }

    // Get valid PassKey (auto-refreshes if needed)
    const passKey = await getValidPassKey(sessionId);
    if (!passKey) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json`;
    
    try {
      const resp = await axios.post(
        url, 
        { PassKey: passKey }, 
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
            const retryResp = await axios.post(
              url, 
              { PassKey: newPassKey }, 
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
      res.status(500).json({ error: "failed to fetch organizations" });
    }
  } catch (error) {
    console.error("Error in /api/orgs:", error);
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