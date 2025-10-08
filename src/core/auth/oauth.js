/**
 * OAuth 2.0 Flow Management
 * Handles BSA OAuth authentication and PassKey exchange
 */

const crypto = require('crypto');
const axios = require('axios');

/**
 * Handle OAuth start - initiate authentication flow
 * @param {Object} params - Request parameters
 * @param {string} params.sessionId - Session ID from extension
 * @param {Object} params.supabase - Supabase client
 * @param {Object} params.bsaConfig - BSA configuration
 * @param {string} params.clientId - BSA client ID
 * @param {string} params.redirectUri - OAuth redirect URI
 * @returns {Promise<{success: boolean, authUrl?: string, error?: string}>}
 */
async function startOAuthFlow({ sessionId, supabase, bsaConfig, clientId, redirectUri }) {
  try {
    // Validate that session_id was provided
    if (!sessionId) {
      console.error("[OAUTH:START] Missing session_id");
      return { success: false, error: "missing session_id" };
    }

    // Generate CSRF protection token
    const state = crypto.randomBytes(16).toString("hex");
    
    // Store the session in database for later validation
    const { error } = await supabase
      .from("oauth_sessions")
      .insert({ 
        session_id: sessionId,
        state
      });
    
    if (error) {
      console.error("[OAUTH:START] Database error:", error);
      return { success: false, error: "database error" };
    }
    
    // Construct the BSA OAuth authorization URL
    const authUrl = new URL(bsaConfig.buildOAuthUrl('authorize'));
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "openid profile email");
    authUrl.searchParams.set("state", state);
    
    return { success: true, authUrl: authUrl.toString() };
  } catch (error) {
    console.error("[OAUTH:START] Error:", error);
    return { success: false, error: "internal server error" };
  }
}

/**
 * Process OAuth callback - exchange code for PassKey
 * @param {Object} params - Callback parameters
 * @param {string} params.code - Authorization code from BSA
 * @param {string} params.state - CSRF protection token
 * @param {Object} params.supabase - Supabase client
 * @param {Object} params.bsaConfig - BSA configuration
 * @param {string} params.clientId - BSA client ID
 * @param {string} params.clientSecret - BSA client secret
 * @param {string} params.redirectUri - OAuth redirect URI
 * @param {Object} params.axiosConfig - Axios configuration
 */
async function processOAuthCallback({ code, state, supabase, bsaConfig, clientId, clientSecret, redirectUri, axiosConfig }) {
  try {
    // Validate state token for CSRF protection
    const { data: rows, error } = await supabase
      .from("oauth_sessions")
      .select("*")
      .eq("state", state)
      .is("used_at", null)
      .limit(1);
    
    if (error) {
      console.error("[OAUTH:PROCESS] Database error:", error);
      return;
    }
    
    const row = rows && rows[0];
    if (!row) {
      console.error("[OAUTH:PROCESS] Invalid or expired state");
      return;
    }

    // Exchange authorization code for bearer token
    let tokenResp;
    try {
      const tokenUrl = bsaConfig.buildOAuthUrl('token');
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri
      });
      
      tokenResp = await axios.post(
        tokenUrl,
        form.toString(),
        { 
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          ...axiosConfig
        }
      );
    } catch (tokenError) {
      console.error("[OAUTH:PROCESS] Token exchange error:", tokenError.response?.data || tokenError.message);
      console.error("[OAUTH:PROCESS] Token error status:", tokenError.response?.status);
      return;
    }

    console.log("[OAUTH:PROCESS] Token endpoint full response:", JSON.stringify(tokenResp.data, null, 2));
    console.log("[OAUTH:PROCESS] Token response keys:", Object.keys(tokenResp.data));
    
    const bearerToken = tokenResp.data.access_token;
    const userIdFromToken = tokenResp.data.user_id || tokenResp.data.UserId || tokenResp.data.UserID || tokenResp.data.userId;
    const refreshToken = tokenResp.data.refresh_token;
    const expiresIn = tokenResp.data.expires_in;
    
    console.log("[OAUTH:PROCESS] Token endpoint extracted values:", {
      hasAccessToken: !!bearerToken,
      hasUserId: !!userIdFromToken,
      userId: userIdFromToken || "not in token response",
      hasRefreshToken: !!refreshToken,
      expiresIn
    });
    
    if (!bearerToken) {
      console.error("[OAUTH:PROCESS] No bearer token in response:", tokenResp.data);
      return;
    }

    // Exchange bearer token for PassKey
    let passKeyResp;
    try {
      const passKeyUrl = bsaConfig.buildOAuthUrl('passkey');
      passKeyResp = await axios.post(
        passKeyUrl,
        {},
        {
          headers: {
            "Authorization": `Bearer ${bearerToken}`,
            "Content-Type": "application/json"
          },
          ...axiosConfig
        }
      );
    } catch (passKeyError) {
      console.error("[OAUTH:PROCESS] PassKey exchange error:", passKeyError.response?.data || passKeyError.message);
      console.error("[OAUTH:PROCESS] PassKey error status:", passKeyError.response?.status);
      return;
    }

    console.log("[OAUTH:PROCESS] PassKey endpoint full response:", JSON.stringify(passKeyResp.data, null, 2));
    console.log("[OAUTH:PROCESS] PassKey response keys:", Object.keys(passKeyResp.data));
    
    const responseData = Array.isArray(passKeyResp.data) ? passKeyResp.data[0] : passKeyResp.data;
    const passKey = responseData?.PassKey || responseData?.passkey;
    const userIdFromPassKey = responseData?.user_id || responseData?.UserId || responseData?.UserID || responseData?.userId;
    
    console.log("[OAUTH:PROCESS] PassKey endpoint extracted values:", {
      hasPassKey: !!passKey,
      hasUserId: !!userIdFromPassKey,
      userId: userIdFromPassKey || "not in passkey response",
      responseStructure: Array.isArray(passKeyResp.data) ? "array" : "object",
      responseDataKeys: responseData ? Object.keys(responseData) : []
    });
    
    const userId = userIdFromToken || userIdFromPassKey || null;
    
    console.log("[OAUTH:PROCESS] Final userId determination:", {
      fromToken: userIdFromToken || "none",
      fromPassKey: userIdFromPassKey || "none",
      final: userId || "not found",
      source: userIdFromToken ? "token" : (userIdFromPassKey ? "passkey" : "none")
    });
    
    if (!passKey) {
      console.error("[OAUTH:PROCESS] No PassKey in response:", passKeyResp.data);
      return;
    }

    // Store PassKey in database
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    
    console.log("[OAUTH:PROCESS] About to store in database:", {
      session_id: row.session_id,
      hasPassKey: !!passKey,
      hasUserId: !!userId,
      userId: userId || "null",
      expires_at: expiresAt
    });

    const { error: tokenError } = await supabase
      .from("bsa_tokens")
      .upsert({
        session_id: row.session_id,
        passkey: passKey,
        refresh_token: null,
        expires_at: expiresAt,
        user_id: userId || null,
        updated_at: new Date().toISOString()
      }, { 
        onConflict: "session_id"
      });
    
    if (tokenError) {
      console.error("[OAUTH:PROCESS] Failed to store PassKey:", tokenError);
      console.error("[OAUTH:PROCESS] Storage error details:", JSON.stringify(tokenError));
      return;
    }

    // Mark OAuth session as used
    await supabase
      .from("oauth_sessions")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id);
      
  } catch (error) {
    console.error("[OAUTH:PROCESS] Unexpected error:", error);
  }
}

module.exports = {
  startOAuthFlow,
  processOAuthCallback
};

