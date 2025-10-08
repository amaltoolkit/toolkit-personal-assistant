/**
 * Authentication Routes
 * Handles OAuth flow and auth status endpoints
 */

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const bsaConfig = require('../integrations/bsa/config');
const { startOAuthFlow, processOAuthCallback } = require('../core/auth');
const { refreshPassKey } = require('../core/auth/helpers');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Axios config (imported from parent context)
const http = require('http');
const https = require('https');
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10
});
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10
});

const axiosConfig = {
  timeout: 10000,
  httpAgent: keepAliveAgent,
  httpsAgent: keepAliveHttpsAgent
};

// Environment variables
const BSA_CLIENT_ID = process.env.BSA_CLIENT_ID;
const BSA_CLIENT_SECRET = process.env.BSA_CLIENT_SECRET;
const BSA_REDIRECT_URI = process.env.BSA_REDIRECT_URI;

/**
 * GET /auth/start
 * Start OAuth authentication flow
 */
router.get("/start", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    
    const result = await startOAuthFlow({
      sessionId,
      supabase,
      bsaConfig,
      clientId: BSA_CLIENT_ID,
      redirectUri: BSA_REDIRECT_URI
    });
    
    if (!result.success) {
      console.error("[AUTH:START] OAuth start failed:", result.error);
      return res.status(400).json({ error: result.error });
    }
    
    // Redirect to OAuth provider
    res.redirect(result.authUrl);
  } catch (error) {
    console.error("[AUTH:START] Error:", error);
    res.status(500).json({ error: "internal server error" });
  }
});

/**
 * GET /auth/callback
 * Handle OAuth callback from BSA
 */
router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    
    // Validate required parameters
    if (!code || !state) {
      console.error("[AUTH:CALLBACK] Missing code or state parameter");
      return res.status(400).send("Missing code or state parameter");
    }

    // Immediately redirect user to BSA main page
    res.redirect(bsaConfig.getBaseUrl());

    // Process OAuth callback asynchronously
    processOAuthCallback({
      code,
      state,
      supabase,
      bsaConfig,
      clientId: BSA_CLIENT_ID,
      clientSecret: BSA_CLIENT_SECRET,
      redirectUri: BSA_REDIRECT_URI,
      axiosConfig
    }).catch(error => {
      console.error("[AUTH:CALLBACK] Background OAuth processing error:", error);
    });

  } catch (error) {
    console.error("[AUTH:CALLBACK] Error:", error);
    res.status(500).send("Internal server error");
  }
});

/**
 * GET /auth/status
 * Check authentication status (polled by Chrome extension)
 */
router.get("/status", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) {
      return res.json({ ok: false, error: "missing session_id" });
    }
    
    // Check if token exists
    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("session_id, expires_at, passkey")
      .eq("session_id", sessionId)
      .limit(1);
    
    if (error) {
      console.error("[AUTH:STATUS] Database error:", error);
      return res.json({ ok: false, error: "database error" });
    }
    
    const token = rows && rows[0];
    if (!token) {
      // No token yet - OAuth flow might still be in progress
      return res.json({ ok: false });
    }
    
    // Check if passkey exists
    if (!token.passkey) {
      return res.json({ ok: false, requiresReauth: true });
    }
    
    // Check token expiration
    if (token.expires_at) {
      const expiry = new Date(token.expires_at);
      const now = new Date();
      
      if (expiry < now) {
        // Token has expired - attempt refresh
        const newPassKey = await refreshPassKey(sessionId, {
          supabase,
          bsaConfig,
          axiosConfig
        });
        
        if (newPassKey) {
          // Refresh successful
          return res.json({ ok: true, refreshed: true });
        }
        
        // Refresh failed
        return res.json({ ok: false, expired: true, requiresReauth: true });
      }
    }
    
    // Token exists and is valid
    res.json({ ok: true });
  } catch (error) {
    console.error("[AUTH:STATUS] Error:", error);
    res.json({ ok: false, error: "internal error" });
  }
});

module.exports = router;

