/**
 * PassKey Manager Service
 * Handles BSA PassKey retrieval, refresh, and auto-renewal
 * Extracted from index.js for modular architecture
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const bsaConfig = require('../../integrations/bsa/config');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Keep-alive agent configuration for HTTP connection reuse
const httpAgent = new (require('http').Agent)({ keepAlive: true });
const httpsAgent = new (require('https').Agent)({ keepAlive: true });
const axiosConfig = { httpAgent, httpsAgent };

class PassKeyManager {
  constructor() {
    this.cache = new Map(); // In-memory cache for PassKeys
    this.cacheTimeout = 60 * 1000; // 1 minute cache
    this.refreshBuffer = 5 * 60 * 1000; // 5 minutes before expiry
  }

  /**
   * Get a valid PassKey for a session, auto-refreshing if needed
   * @param {string} sessionId - Session ID
   * @returns {Promise<string|null>} Valid PassKey or null
   */
  async getPassKey(sessionId) {
    try {
      // Check cache first
      const cached = this.cache.get(sessionId);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log(`[PASSKEY:CACHE_HIT] Using cached PassKey for session ${sessionId}`);
        return cached.passKey;
      }

      // Fetch from database
      const { data: rows, error } = await supabase
        .from("bsa_tokens")
        .select("*")
        .eq("session_id", sessionId)
        .limit(1);
      
      // Handle database errors
      if (error) {
        console.error("[PASSKEY:GET] Database error:", error);
        return null;
      }
      
      // Check if token exists for this session
      if (!rows || !rows[0]) {
        console.error("[PASSKEY:GET] No token found for session:", sessionId);
        return null;
      }
      
      const token = rows[0];
      
      const passKey = token.passkey;
      if (!passKey) {
        console.error("[PASSKEY:GET] Token exists but passkey field is empty");
        return null;
      }
      
      // Check expiration and refresh if needed
      if (token.expires_at) {
        const expiry = new Date(token.expires_at);
        const now = new Date();
        const timeLeft = expiry - now;  // Time remaining in milliseconds
        
        // Refresh if less than 5 minutes remaining
        if (timeLeft < this.refreshBuffer) {
          console.log(`[PASSKEY:REFRESH] PassKey expiring in ${Math.floor(timeLeft/1000)}s, refreshing...`);
          
          // Attempt to refresh the PassKey
          const newPassKey = await this.refreshPassKey(sessionId, passKey);
          
          if (newPassKey) {
            // Cache the new PassKey
            this.cache.set(sessionId, {
              passKey: newPassKey,
              timestamp: Date.now()
            });
            return newPassKey;
          } else {
            // Refresh failed - return existing PassKey (might still work)
            console.error("[PASSKEY:REFRESH] Failed to refresh, using existing PassKey");
            return passKey;
          }
        }
      }
      
      // Cache the PassKey
      this.cache.set(sessionId, {
        passKey,
        timestamp: Date.now()
      });
      
      return passKey;
      
    } catch (error) {
      console.error("[PASSKEY:GET] Unexpected error:", error);
      return null;
    }
  }

  /**
   * Refresh an existing PassKey using BSA's refresh endpoint
   * @param {string} sessionId - Session ID
   * @param {string} currentPassKey - Current PassKey to use for authentication
   * @returns {Promise<string|null>} New PassKey or null
   */
  async refreshPassKey(sessionId, currentPassKey = null) {
    try {
      // If no current PassKey provided, fetch from database
      if (!currentPassKey) {
        const { data: rows, error } = await supabase
          .from("bsa_tokens")
          .select("passkey")
          .eq("session_id", sessionId)
          .limit(1);
        
        if (error || !rows || !rows[0] || !rows[0].passkey) {
          console.error("[PASSKEY:REFRESH] Failed to get current PassKey:", error);
          return null;
        }
        
        currentPassKey = rows[0].passkey;
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
            timeout: 10000,
            ...axiosConfig  // Apply keep-alive agents
          }
        );
        
        // Extract new PassKey from response
        const responseData = Array.isArray(refreshResp.data) ? refreshResp.data[0] : refreshResp.data;
        const newPassKey = responseData?.PassKey || responseData?.passkey;
        const userId = responseData?.user_id || responseData?.UserId || responseData?.UserID;
        
        console.log("[PASSKEY:REFRESH] Response structure:", {
          hasPassKey: !!newPassKey,
          hasUserId: !!userId,
          responseKeys: Object.keys(responseData || {}).slice(0, 5)
        });
        
        if (!newPassKey) {
          console.error("[PASSKEY:REFRESH] No new PassKey in response");
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
          console.error("[PASSKEY:REFRESH] Failed to update database:", updateError);
          return null;
        }
        
        console.log("[PASSKEY:REFRESH] Successfully refreshed PassKey");
        return newPassKey;
        
      } catch (refreshError) {
        console.error("[PASSKEY:REFRESH] API error:", {
          status: refreshError.response?.status,
          message: refreshError.message
        });
        return null;
      }
    } catch (error) {
      console.error("[PASSKEY:REFRESH] Unexpected error:", error);
      return null;
    }
  }

  /**
   * Store a new PassKey in the database
   * @param {string} sessionId - Session ID
   * @param {string} passKey - PassKey to store
   * @param {string} refreshToken - Refresh token (optional)
   * @param {number} expiresIn - Expiry time in seconds (default: 3600)
   * @returns {Promise<boolean>} Success status
   */
  async storePassKey(sessionId, passKey, refreshToken = null, expiresIn = 3600) {
    try {
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      
      const { error } = await supabase
        .from("bsa_tokens")
        .upsert({
          session_id: sessionId,
          passkey: passKey,
          refresh_token: refreshToken,
          expires_at: expiresAt,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'session_id'
        });
      
      if (error) {
        console.error("[PASSKEY:STORE] Database error:", error);
        return false;
      }
      
      // Clear cache for this session
      this.cache.delete(sessionId);
      
      console.log("[PASSKEY:STORE] Successfully stored PassKey for session:", sessionId);
      return true;
      
    } catch (error) {
      console.error("[PASSKEY:STORE] Unexpected error:", error);
      return false;
    }
  }

  /**
   * Delete PassKey and session data
   * @param {string} sessionId - Session ID
   * @returns {Promise<boolean>} Success status
   */
  async deletePassKey(sessionId) {
    try {
      const { error } = await supabase
        .from("bsa_tokens")
        .delete()
        .eq("session_id", sessionId);
      
      if (error) {
        console.error("[PASSKEY:DELETE] Database error:", error);
        return false;
      }
      
      // Clear cache
      this.cache.delete(sessionId);
      
      console.log("[PASSKEY:DELETE] Successfully deleted PassKey for session:", sessionId);
      return true;
      
    } catch (error) {
      console.error("[PASSKEY:DELETE] Unexpected error:", error);
      return false;
    }
  }

  /**
   * Check if a PassKey exists and is valid
   * @param {string} sessionId - Session ID
   * @returns {Promise<boolean>} True if valid PassKey exists
   */
  async hasValidPassKey(sessionId) {
    const passKey = await this.getPassKey(sessionId);
    return !!passKey;
  }

  /**
   * Get PassKey expiry time
   * @param {string} sessionId - Session ID
   * @returns {Promise<Date|null>} Expiry date or null
   */
  async getExpiry(sessionId) {
    try {
      const { data: rows, error } = await supabase
        .from("bsa_tokens")
        .select("expires_at")
        .eq("session_id", sessionId)
        .limit(1);
      
      if (error || !rows || !rows[0]) {
        return null;
      }
      
      return rows[0].expires_at ? new Date(rows[0].expires_at) : null;
      
    } catch (error) {
      console.error("[PASSKEY:EXPIRY] Error:", error);
      return null;
    }
  }

  /**
   * Clear the in-memory cache
   */
  clearCache() {
    this.cache.clear();
    console.log('[PASSKEY:CACHE] Cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys())
    };
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getPassKeyManager: () => {
    if (!instance) {
      instance = new PassKeyManager();
    }
    return instance;
  },
  PassKeyManager // Export class for testing
};