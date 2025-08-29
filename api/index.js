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
    if (!sessionId) {
      return res.status(400).json({ error: "missing session_id" });
    }

    const state = crypto.randomBytes(16).toString("hex");
    
    const { error } = await supabase
      .from("oauth_sessions")
      .insert({ session_id: sessionId, state });
    
    if (error) {
      console.error("Database error:", error);
      return res.status(500).json({ error: "database error" });
    }

    const authUrl = new URL(`${BSA_BASE}/auth/oauth2/authorize`);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", BSA_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", BSA_REDIRECT_URI);
    authUrl.searchParams.set("scope", "basic");
    authUrl.searchParams.set("state", state);
    
    res.redirect(authUrl.toString());
  } catch (error) {
    console.error("Error in /auth/start:", error);
    res.status(500).json({ error: "internal server error" });
  }
});

// 2) OAuth callback
app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send("Missing code or state parameter");
    }

    const { data: rows, error } = await supabase
      .from("oauth_sessions")
      .select("*")
      .eq("state", state)
      .is("used_at", null)
      .limit(1);
    
    if (error) {
      console.error("Database error:", error);
      return res.status(500).send("Database error");
    }
    
    const row = rows && rows[0];
    if (!row) {
      return res.status(400).send("Invalid or expired state");
    }

    let tokenResp;
    try {
      tokenResp = await axios.post(
        `${BSA_BASE}/auth/oauth2/token`,
        {
          grant_type: "authorization_code",
          client_id: BSA_CLIENT_ID,
          client_secret: BSA_CLIENT_SECRET,
          code,
          redirect_uri: BSA_REDIRECT_URI
        },
        { 
          headers: { "Content-Type": "application/json" },
          timeout: 10000
        }
      );
    } catch (tokenError) {
      console.error("Token exchange error:", tokenError.response?.data || tokenError.message);
      return res.status(500).send("Failed to exchange authorization code");
    }

    // Treat the returned access token as the PassKey
    const accessToken = tokenResp.data.access_token || 
                       tokenResp.data.token || 
                       tokenResp.data.PassKey;
    
    if (!accessToken) {
      console.error("No access token in response:", tokenResp.data);
      return res.status(500).send("No access token received");
    }
    
    const refreshToken = tokenResp.data.refresh_token || null;
    const expiresIn = tokenResp.data.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Store the PassKey in plain text
    const { error: tokenError } = await supabase
      .from("bsa_tokens")
      .upsert({
        session_id: row.session_id,
        access_token: accessToken,       // plain text storage
        refresh_token: refreshToken,
        expires_at: expiresAt,
        updated_at: new Date().toISOString()
      }, { 
        onConflict: "session_id" 
      });
    
    if (tokenError) {
      console.error("Failed to store token:", tokenError);
      return res.status(500).send("Failed to store authentication");
    }

    // Mark session as used
    await supabase
      .from("oauth_sessions")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Successful</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          }
          .success-card {
            background: white;
            padding: 2rem;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            text-align: center;
            max-width: 400px;
          }
          h1 { color: #10b981; margin: 0 0 1rem 0; }
          p { color: #6b7280; margin: 0 0 1rem 0; }
          .close-btn {
            background: #6366f1;
            color: white;
            border: none;
            padding: 0.5rem 1.5rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
          }
          .close-btn:hover { background: #4f46e5; }
        </style>
      </head>
      <body>
        <div class="success-card">
          <h1>✓ Authentication Successful</h1>
          <p>You have been successfully authenticated with BlueSquareApps.</p>
          <p>You can now close this window and return to the extension.</p>
          <button class="close-btn" onclick="window.close()">Close Window</button>
        </div>
        <script>
          setTimeout(() => { window.close(); }, 3000);
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Error in /auth/callback:", error);
    res.status(500).send("Internal server error");
  }
});

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

    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", sessionId)
      .limit(1);
    
    if (error) {
      console.error("Database error:", error);
      return res.status(500).json({ error: "database error" });
    }
    
    if (!rows || !rows[0]) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const passKey = rows[0].access_token;  // use plain text PassKey
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

    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", sessionId)
      .limit(1);
    
    if (error) {
      console.error("Database error:", error);
      return res.status(500).json({ error: "database error" });
    }
    
    if (!rows || !rows[0]) {
      return res.status(401).json({ error: "not authenticated" });
    }

    const passKey = rows[0].access_token;  // use plain text PassKey
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
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
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