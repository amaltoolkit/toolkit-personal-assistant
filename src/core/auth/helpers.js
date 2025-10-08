/**
 * PassKey Helper Functions
 * Shared utilities for PassKey management
 */

const axios = require('axios');

/**
 * Refresh an expired/expiring PassKey
 * @param {string} sessionId - Session ID
 * @param {Object} supabase - Supabase client
 * @param {Object} bsaConfig - BSA configuration
 * @param {Object} axiosConfig - Axios configuration
 * @returns {Promise<string|null>} New PassKey or null
 */
async function refreshPassKey(sessionId, { supabase, bsaConfig, axiosConfig }) {
  try {
    // Get existing PassKey from database
    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", sessionId)
      .limit(1);
    
    if (error || !rows || !rows[0]) {
      console.error("[AUTH:REFRESH] Failed to get current PassKey:", error);
      return null;
    }
    
    const currentPassKey = rows[0].passkey;
    
    if (!currentPassKey) {
      console.error("[AUTH:REFRESH] No existing PassKey to refresh");
      return null;
    }
    
    // Call BSA refresh endpoint
    const refreshUrl = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.data.VCDataEndpoint/login.json');
    
    try {
      const refreshResp = await axios.post(
        refreshUrl,
        { PassKey: currentPassKey },
        {
          headers: { "Content-Type": "application/json" },
          ...axiosConfig
        }
      );
      
      const responseData = Array.isArray(refreshResp.data) ? refreshResp.data[0] : refreshResp.data;
      const newPassKey = responseData?.PassKey || responseData?.passkey;
      const userId = responseData?.user_id || responseData?.UserId || responseData?.UserID;
      
      console.log("[AUTH:REFRESH] Refresh response structure:", {
        hasPassKey: !!newPassKey,
        hasUserId: !!userId,
        userId: userId || "not found",
        responseKeys: Object.keys(responseData || {})
      });
      
      if (!newPassKey) {
        console.error("[AUTH:REFRESH] No new PassKey in refresh response:", refreshResp.data);
        return null;
      }
      
      // Store the new PassKey with fresh 1-hour expiry
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      
      const { error: updateError } = await supabase
        .from("bsa_tokens")
        .update({
          passkey: newPassKey,
          expires_at: expiresAt,
          user_id: userId || null,
          updated_at: new Date().toISOString()
        })
        .eq("session_id", sessionId);
      
      if (updateError) {
        console.error("[AUTH:REFRESH] Failed to update PassKey in database:", updateError);
        return null;
      }
      
      return newPassKey;
      
    } catch (refreshError) {
      console.error("[AUTH:REFRESH] API error - Status:", refreshError.response?.status);
      console.error("[AUTH:REFRESH] API error - Data:", refreshError.response?.data);
      console.error("[AUTH:REFRESH] API error - Message:", refreshError.message);
      return null;
    }
  } catch (error) {
    console.error("[AUTH:REFRESH] Unexpected error:", error);
    return null;
  }
}

module.exports = {
  refreshPassKey
};

