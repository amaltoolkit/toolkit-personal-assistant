/**
 * UserResolver Service - Handles user resolution and linking for calendar activities
 * Extends ContactResolver patterns for organization users
 */

const axios = require('axios');
const { normalizeBSAResponse, buildBSAHeaders } = require('../tools/bsa/common');
const { getMem0Service } = require('./mem0Service');
const { getUserSyncService } = require('./userSyncService');
const bsaConfig = require('../config/bsa');

class UserResolver {
  constructor() {
    this.mem0Service = getMem0Service();
    this.userSyncService = getUserSyncService();
  }

  /**
   * Resolve "me" pronoun to current user
   * @param {string} sessionId - Session ID
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object|null>} Current user or null
   */
  async resolveMe(sessionId, orgId) {
    console.log('[USER_RESOLVER] Resolving "me" pronoun');

    const currentUser = await this.userSyncService.getCurrentUser(sessionId, orgId);

    if (currentUser) {
      console.log(`[USER_RESOLVER] Resolved "me" to: ${currentUser.full_name}`);
      return {
        id: currentUser.user_id,
        name: currentUser.full_name,
        email: currentUser.email,
        title: currentUser.job_title,
        isCurrentUser: true
      };
    }

    console.warn('[USER_RESOLVER] Could not resolve "me" - no current user found');
    return null;
  }

  /**
   * Search for users in organization
   * @param {string} query - Search query
   * @param {string} orgId - Organization ID
   * @param {number} limit - Maximum results
   * @returns {Promise<Array>} Array of matching users
   */
  async search(query, orgId, limit = 5) {
    console.log(`[USER_RESOLVER] Searching for user: "${query}"`);

    // Check if query is "me" or similar
    if (this.isSelfReference(query)) {
      console.log('[USER_RESOLVER] Detected self-reference');
      return []; // Handle separately in resolve method
    }

    // Search from local database (already synced)
    const users = await this.userSyncService.searchUsers(query, orgId, limit);

    // Map to standard format
    const mappedUsers = users.map(u => ({
      id: u.user_id,
      name: u.full_name,
      email: u.email,
      title: u.job_title,
      firstName: u.first_name,
      lastName: u.last_name,
      isCurrentUser: u.is_current_user
    }));

    console.log(`[USER_RESOLVER] Found ${mappedUsers.length} users`);
    return mappedUsers;
  }

  /**
   * Check if query is a self-reference
   * @param {string} query - Query string
   * @returns {boolean} True if self-reference
   */
  isSelfReference(query) {
    const selfReferences = ['me', 'myself', 'i'];
    return selfReferences.includes(query.toLowerCase().trim());
  }

  /**
   * Disambiguate multiple user matches
   * @param {Array} candidates - Array of user candidates
   * @param {Object} context - Context with query, memoryContext, etc.
   * @returns {Promise<Object>} Selected user or disambiguation data
   */
  async disambiguate(candidates, context = {}) {
    // If only one candidate, return it
    if (candidates.length === 1) {
      console.log(`[USER_RESOLVER] Single match: ${candidates[0].name}`);
      return candidates[0];
    }

    if (candidates.length === 0) {
      throw new Error('No users found');
    }

    // Score users similar to contact scoring
    const scored = await this.scoreUsers(candidates, context);

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Auto-select if top score is significantly better
    if (scored.length > 1 && scored[0].score > scored[1].score * 2) {
      console.log(`[USER_RESOLVER] Auto-selected ${scored[0].name} (score: ${scored[0].score})`);
      return scored[0];
    }

    // Otherwise, require user selection
    console.log(`[USER_RESOLVER] Multiple candidates require user selection`);

    return {
      needsDisambiguation: true,
      topCandidate: scored[0],
      alternatives: scored.slice(0, 5).map((u, i) => ({
        index: i + 1,
        id: u.id,
        name: u.name,
        title: u.title || 'N/A',
        email: u.email || 'N/A',
        score: Math.round(u.score),
        isCurrentUser: u.isCurrentUser
      }))
    };
  }

  /**
   * Score users for disambiguation
   * @param {Array} candidates - User candidates
   * @param {Object} context - Context information
   * @returns {Promise<Array>} Scored users
   */
  async scoreUsers(candidates, context) {
    const { query = '', memoryContext = {} } = context;

    return Promise.all(candidates.map(async user => {
      let score = 0;

      // Name similarity (40%)
      if (user.name) {
        const nameSimilarity = this.calculateNameSimilarity(query, user.name);
        score += nameSimilarity * 40;
      }

      // Title match (20%)
      if (user.title && query.toLowerCase().includes(user.title.toLowerCase())) {
        score += 20;
      }

      // Current user boost (20%)
      if (user.isCurrentUser && this.isSelfReference(query)) {
        score += 20;
      }

      // Recent interactions from memory (20%)
      if (memoryContext.recalled_memories?.length > 0) {
        const userNameLower = user.name?.toLowerCase();

        for (const memory of memoryContext.recalled_memories) {
          if (memory.content?.toLowerCase().includes(userNameLower)) {
            score += memory.relevance ? memory.relevance * 20 : 10;
            break;
          }
        }
      }

      return { ...user, score };
    }));
  }

  /**
   * Calculate name similarity (reused from ContactResolver)
   */
  calculateNameSimilarity(query, name) {
    if (!query || !name) return 0;

    const queryLower = query.toLowerCase();
    const nameLower = name.toLowerCase();

    if (queryLower === nameLower) return 1.0;
    if (queryLower.includes(nameLower) || nameLower.includes(queryLower)) return 0.9;

    const queryWords = queryLower.split(/\s+/);
    const nameWords = nameLower.split(/\s+/);

    let matchedWords = 0;
    for (const qWord of queryWords) {
      for (const nWord of nameWords) {
        if (qWord === nWord) {
          matchedWords++;
          break;
        }
        if (qWord.length > 2 && nWord.includes(qWord)) {
          matchedWords += 0.5;
          break;
        }
      }
    }

    return Math.min(1.0, matchedWords / Math.max(queryWords.length, nameWords.length));
  }

  /**
   * Link a user to an activity
   * @param {string} type - Activity type ('appointment' or 'task')
   * @param {string} activityId - Activity ID
   * @param {string} userId - User ID
   * @param {string} passKey - BSA authentication key
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object>} Link result
   */
  async linkActivity(type, activityId, userId, passKey, orgId) {
    const LINKER_NAMES = {
      'appointment': 'linker_appointments_users',
      'task': 'linker_tasks_users'
    };

    const linkerName = LINKER_NAMES[type];
    if (!linkerName) {
      throw new Error(`Unknown activity type for user linking: ${type}`);
    }

    const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/link.json';
    const payload = {
      LeftObjectName: type,
      LeftId: activityId,
      ObjectName: linkerName,
      RightObjectName: 'organization_user',
      RightId: userId,
      OrganizationId: orgId,
      PassKey: passKey
    };

    console.log(`[USER_RESOLVER] Linking user ${userId} to ${type} ${activityId}`);

    try {
      const response = await axios.post(
        bsaConfig.buildEndpoint(endpoint),
        payload,
        {
          headers: buildBSAHeaders(passKey),
          timeout: 10000
        }
      );

      const normalized = normalizeBSAResponse(response.data);
      if (!normalized.valid) {
        throw new Error(normalized.error || 'Failed to link user');
      }

      console.log(`[USER_RESOLVER] Successfully linked user using: ${linkerName}`);
      return { linked: true, type, activityId, userId, linkerName };
    } catch (error) {
      console.error('[USER_RESOLVER] Error linking user:', error.message);
      throw error;
    }
  }

  /**
   * Resolve multiple users including "me" references
   * @param {Array} userQueries - Array of user names/queries
   * @param {string} sessionId - Session ID
   * @param {string} orgId - Organization ID
   * @param {Object} context - Additional context
   * @returns {Promise<Array>} Resolved users
   */
  async resolveMultiple(userQueries, sessionId, orgId, context = {}) {
    const resolved = [];

    for (const query of userQueries) {
      try {
        // Check for "me" reference
        if (this.isSelfReference(query)) {
          const currentUser = await this.resolveMe(sessionId, orgId);
          if (currentUser) {
            resolved.push(currentUser);
            continue;
          }
        }

        // Search for user
        const candidates = await this.search(query, orgId, 5);

        if (candidates.length === 0) {
          console.warn(`[USER_RESOLVER] No matches for: ${query}`);
          continue;
        }

        // Disambiguate if needed
        const selected = await this.disambiguate(candidates, {
          ...context,
          query
        });

        // Handle disambiguation requirement
        if (selected.needsDisambiguation) {
          // Would throw interrupt here in actual flow
          console.log('[USER_RESOLVER] Disambiguation needed for:', query);
          continue;
        }

        resolved.push(selected);
      } catch (error) {
        console.error(`[USER_RESOLVER] Error resolving "${query}":`, error.message);
      }
    }

    return resolved;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getUserResolver: () => {
    if (!instance) {
      instance = new UserResolver();
    }
    return instance;
  },
  UserResolver // Export class for testing
};