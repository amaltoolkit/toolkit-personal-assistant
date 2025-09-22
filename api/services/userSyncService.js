/**
 * UserSyncService - Manages organization user synchronization
 * Fetches users from BSA and maintains local cache for fast lookups
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { normalizeBSAResponse, buildBSAHeaders } = require('../tools/bsa/common');
const bsaConfig = require('../config/bsa');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

class UserSyncService {
  constructor() {
    this.syncCache = new Map(); // Track recent syncs
    this.syncInterval = 60 * 60 * 1000; // 1 hour
  }

  /**
   * Sync organization users from BSA to local database
   * @param {string} passKey - BSA authentication key
   * @param {string} orgId - Organization ID
   * @param {string} sessionId - Current session ID
   * @param {string} currentUserId - Current user's BSA ID
   * @returns {Promise<Object>} Sync result
   */
  async syncOrganizationUsers(passKey, orgId, sessionId, currentUserId = null) {
    console.log("[USER_SYNC] =====================================");
    console.log("[USER_SYNC] syncOrganizationUsers called with:");
    console.log("[USER_SYNC]   - Org ID:", orgId);
    console.log("[USER_SYNC]   - Session ID:", sessionId);
    console.log("[USER_SYNC]   - Current User ID:", currentUserId || "none");
    console.log("[USER_SYNC]   - Has PassKey:", !!passKey);

    // Check if we recently synced this org
    const cacheKey = `${orgId}:${sessionId}`;
    if (this.syncCache.has(cacheKey)) {
      const lastSync = this.syncCache.get(cacheKey);
      const timeSinceSync = Date.now() - lastSync;
      console.log(`[USER_SYNC] Found cache entry, time since last sync: ${timeSinceSync}ms`);
      if (timeSinceSync < 5 * 60 * 1000) { // 5 minute cache
        console.log('[USER_SYNC] Using cached sync result (< 5 minutes old)');
        return { cached: true, message: 'Recently synced' };
      }
    } else {
      console.log('[USER_SYNC] No cache entry found, proceeding with sync');
    }

    try {
      // Step 1: Fetch users from BSA
      console.log("[USER_SYNC] Step 1: Fetching users from BSA API...");
      const users = await this.fetchUsersFromBSA(passKey, orgId);
      console.log(`[USER_SYNC] Successfully fetched ${users.length} users from BSA`);
      if (users.length > 0) {
        console.log("[USER_SYNC] First user sample:", JSON.stringify(users[0]));
      }

      // Step 2: Get existing users from database
      console.log("[USER_SYNC] Step 2: Checking existing users in database...");
      const { data: existingUsers, error: fetchError } = await supabase
        .from('organization_users')
        .select('user_id')
        .eq('org_id', orgId);

      if (fetchError) {
        console.error('[USER_SYNC] ERROR fetching existing users from DB:', JSON.stringify(fetchError));
        throw fetchError;
      }

      console.log(`[USER_SYNC] Found ${existingUsers?.length || 0} existing users in database`);

      const existingUserIds = new Set(existingUsers?.map(u => u.user_id) || []);

      // Step 3: Prepare users for upsert
      console.log("[USER_SYNC] Step 3: Preparing users for database upsert...");
      const usersToUpsert = users.map(user => ({
        org_id: orgId,
        user_id: user.Id,
        full_name: user.FullName || `${user.FirstName || ''} ${user.LastName || ''}`.trim(),
        first_name: user.FirstName,
        last_name: user.LastName,
        email: user.EmailAddress,
        job_title: user.JobTitle,
        is_current_user: currentUserId ? user.Id === currentUserId : false,
        session_id: sessionId,
        last_synced: new Date().toISOString()
      }));

      console.log(`[USER_SYNC] Prepared ${usersToUpsert.length} users for upsert`);
      if (usersToUpsert.length > 0) {
        console.log("[USER_SYNC] First user to upsert:", JSON.stringify(usersToUpsert[0]));
      }

      // Step 4: Upsert users to database
      console.log("[USER_SYNC] Step 4: Upserting users to database...");
      const { data: upsertedUsers, error: upsertError } = await supabase
        .from('organization_users')
        .upsert(usersToUpsert, {
          onConflict: 'org_id,user_id',
          returning: 'minimal'
        });

      if (upsertError) {
        console.error('[USER_SYNC] ERROR upserting users to DB:', JSON.stringify(upsertError));
        throw upsertError;
      }

      console.log("[USER_SYNC] Successfully upserted users to database");

      // Step 5: Mark current user if provided
      if (currentUserId) {
        // First, clear any existing current user flags for this org
        await supabase
          .from('organization_users')
          .update({ is_current_user: false })
          .eq('org_id', orgId)
          .eq('is_current_user', true);

        // Then set the new current user
        const { error: updateError } = await supabase
          .from('organization_users')
          .update({
            is_current_user: true,
            session_id: sessionId
          })
          .eq('org_id', orgId)
          .eq('user_id', currentUserId);

        if (updateError) {
          console.warn('[USER_SYNC] Error marking current user:', updateError);
        } else {
          console.log(`[USER_SYNC] Marked user ${currentUserId} as current`);
        }
      }

      // Step 6: Clean up deleted users
      const fetchedUserIds = new Set(users.map(u => u.Id));
      const deletedUserIds = Array.from(existingUserIds).filter(id => !fetchedUserIds.has(id));

      if (deletedUserIds.length > 0) {
        const { error: deleteError } = await supabase
          .from('organization_users')
          .delete()
          .eq('org_id', orgId)
          .in('user_id', deletedUserIds);

        if (deleteError) {
          console.warn('[USER_SYNC] Error deleting removed users:', deleteError);
        } else {
          console.log(`[USER_SYNC] Removed ${deletedUserIds.length} deleted users`);
        }
      }

      // Update cache
      this.syncCache.set(cacheKey, Date.now());

      return {
        success: true,
        synced: users.length,
        added: users.length - existingUserIds.size + deletedUserIds.length,
        deleted: deletedUserIds.length,
        currentUser: currentUserId
      };

    } catch (error) {
      console.error('[USER_SYNC] Sync failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Fetch users from BSA API
   * @param {string} passKey - BSA authentication key
   * @param {string} orgId - Organization ID
   * @returns {Promise<Array>} Array of users
   */
  async fetchUsersFromBSA(passKey, orgId) {
    const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json';
    const fullUrl = bsaConfig.buildEndpoint(endpoint);

    const payload = {
      PassKey: passKey,
      OrganizationId: orgId,
      ObjectName: 'organization_user',
      IncludeExtendedProperties: false,
      AscendingOrder: true,
      OrderBy: 'LastName, FirstName'
    };

    console.log("[USER_SYNC:BSA] Making API call to BSA:");
    console.log("[USER_SYNC:BSA]   - URL:", fullUrl);
    console.log("[USER_SYNC:BSA]   - Payload:", JSON.stringify(payload));

    try {
      const response = await axios.post(
        fullUrl,
        payload,
        {
          headers: buildBSAHeaders(passKey),
          timeout: 10000
        }
      );

      console.log("[USER_SYNC:BSA] Response status:", response.status);
      console.log("[USER_SYNC:BSA] Response data type:", typeof response.data);
      console.log("[USER_SYNC:BSA] Response data:", JSON.stringify(response.data).substring(0, 500) + "...");

      const normalized = normalizeBSAResponse(response.data);
      console.log("[USER_SYNC:BSA] Normalized response valid:", normalized.valid);
      console.log("[USER_SYNC:BSA] Normalized Results count:", normalized.Results?.length || 0);

      if (!normalized.valid) {
        console.error("[USER_SYNC:BSA] ERROR: Invalid response -", normalized.error);
        throw new Error(normalized.error || 'Failed to fetch users');
      }

      return normalized.Results || [];
    } catch (error) {
      console.error('[USER_SYNC:BSA] ERROR in API call:', error.message);
      if (error.response) {
        console.error('[USER_SYNC:BSA] Error response status:', error.response.status);
        console.error('[USER_SYNC:BSA] Error response data:', JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  /**
   * Get current user for a session
   * @param {string} sessionId - Session ID
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object|null>} Current user or null
   */
  async getCurrentUser(sessionId, orgId) {
    try {
      const { data, error } = await supabase
        .from('organization_users')
        .select('*')
        .eq('org_id', orgId)
        .eq('is_current_user', true)
        .single();

      if (error) {
        console.warn('[USER_SYNC] No current user found:', error);
        return null;
      }

      return data;
    } catch (error) {
      console.error('[USER_SYNC] Error getting current user:', error);
      return null;
    }
  }

  /**
   * Get all users for an organization
   * @param {string} orgId - Organization ID
   * @returns {Promise<Array>} Array of users
   */
  async getOrganizationUsers(orgId) {
    try {
      const { data, error } = await supabase
        .from('organization_users')
        .select('*')
        .eq('org_id', orgId)
        .order('last_name', { ascending: true });

      if (error) {
        console.error('[USER_SYNC] Error fetching org users:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      console.error('[USER_SYNC] Error getting org users:', error);
      return [];
    }
  }

  /**
   * Search users by name
   * @param {string} query - Search query
   * @param {string} orgId - Organization ID
   * @param {number} limit - Maximum results
   * @returns {Promise<Array>} Matching users
   */
  async searchUsers(query, orgId, limit = 5) {
    try {
      const queryLower = query.toLowerCase();

      // Use ILIKE for case-insensitive search
      const { data, error } = await supabase
        .from('organization_users')
        .select('*')
        .eq('org_id', orgId)
        .or(`full_name.ilike.%${query}%,first_name.ilike.%${query}%,last_name.ilike.%${query}%,email.ilike.%${query}%`)
        .limit(limit);

      if (error) {
        console.error('[USER_SYNC] Error searching users:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      console.error('[USER_SYNC] Error searching users:', error);
      return [];
    }
  }

  /**
   * Clear sync cache (useful for forcing refresh)
   */
  clearCache() {
    this.syncCache.clear();
    console.log('[USER_SYNC] Cache cleared');
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getUserSyncService: () => {
    if (!instance) {
      instance = new UserSyncService();
    }
    return instance;
  },
  UserSyncService // Export class for testing
};