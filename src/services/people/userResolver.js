/**
 * User Resolver for People Service
 *
 * Handles internal user resolution (organization users/employees)
 * Refactored from original userResolver to work with unified PeopleService
 */

const { getUserSyncService } = require('../sync/userSyncService');

class UserResolver {
  constructor() {
    this.userSyncService = getUserSyncService();
  }

  /**
   * Resolve "me" pronoun to current user
   * @param {string} sessionId - Session ID
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object|null>} Current user or null
   */
  async resolveMe(sessionId, orgId) {
    console.log('[USER:RESOLVE_ME] Resolving "me" pronoun');

    const currentUser = await this.userSyncService.getCurrentUser(sessionId, orgId);

    if (currentUser) {
      console.log(`[USER:RESOLVE_ME] Resolved "me" to: ${currentUser.full_name}`);
      return {
        id: currentUser.user_id,
        name: currentUser.full_name,
        email: currentUser.email,
        title: currentUser.job_title,
        firstName: currentUser.first_name,
        lastName: currentUser.last_name,
        isCurrentUser: true
      };
    }

    console.warn('[USER:RESOLVE_ME] Could not resolve "me" - no current user found');
    return null;
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
   * Search for users in organization
   * @param {string} query - Search query
   * @param {string} orgId - Organization ID
   * @param {number} limit - Maximum results
   * @param {boolean} fuzzyFallback - Enable fuzzy fallback
   * @returns {Promise<Array>} Array of matching users
   */
  async search(query, orgId, limit = 5, fuzzyFallback = true) {
    console.log(`[USER:SEARCH] Searching for user: "${query}"`);

    // Check if query is "me" or similar
    if (this.isSelfReference(query)) {
      console.log('[USER:SEARCH] Detected self-reference');
      return []; // Handle separately in resolveMe()
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
      department: u.department,
      isCurrentUser: u.is_current_user
    }));

    console.log(`[USER:SEARCH] Found ${mappedUsers.length} users`);

    // Fuzzy fallback if no exact matches
    if (mappedUsers.length === 0 && fuzzyFallback && query.length > 2) {
      console.log(`[USER:SEARCH] No exact matches, trying fuzzy search`);

      // Try searching with partial query (first few characters)
      const partialQuery = query.substring(0, Math.min(query.length - 1, 3));
      const fuzzyUsers = await this.userSyncService.searchUsers(partialQuery, orgId, limit * 3);

      const fuzzyMapped = fuzzyUsers.map(u => ({
        id: u.user_id,
        name: u.full_name,
        email: u.email,
        title: u.job_title,
        firstName: u.first_name,
        lastName: u.last_name,
        department: u.department,
        isCurrentUser: u.is_current_user,
        fuzzyMatch: true
      })).slice(0, limit);

      if (fuzzyMapped.length > 0) {
        console.log(`[USER:SEARCH] Found ${fuzzyMapped.length} fuzzy matches`);
        return fuzzyMapped;
      }
    }

    return mappedUsers;
  }

  /**
   * Fuzzy search for suggestions
   * @param {string} query - Search query
   * @param {string} orgId - Organization ID
   * @returns {Promise<Array>} Array of suggestions
   */
  async fuzzySearch(query, orgId) {
    if (query.length < 2) return [];

    const prefix = query.substring(0, Math.min(query.length, 3));
    const users = await this.userSyncService.searchUsers(prefix, orgId, 10);

    return users.slice(0, 3).map(u => ({
      id: u.user_id,
      name: u.full_name,
      email: u.email,
      title: u.job_title
    }));
  }

  /**
   * Get user details by ID
   * @param {string} userId - User ID
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object>} User details
   */
  async getDetails(userId, orgId) {
    console.log(`[USER:DETAILS] Fetching details for: ${userId}`);

    const user = await this.userSyncService.getUserById(userId, orgId);

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    return {
      id: user.user_id,
      name: user.full_name,
      email: user.email,
      title: user.job_title,
      firstName: user.first_name,
      lastName: user.last_name,
      department: user.department,
      isCurrentUser: user.is_current_user
    };
  }

  /**
   * Get all users in organization (for team queries)
   * @param {string} orgId - Organization ID
   * @returns {Promise<Array>} Array of all users
   */
  async getAllUsers(orgId) {
    console.log(`[USER:ALL] Fetching all users for org: ${orgId}`);

    const users = await this.userSyncService.getAllUsers(orgId);

    return users.map(u => ({
      id: u.user_id,
      name: u.full_name,
      email: u.email,
      title: u.job_title,
      firstName: u.first_name,
      lastName: u.last_name,
      department: u.department,
      isCurrentUser: u.is_current_user
    }));
  }
}

// Singleton instance
let instance = null;

function getUserResolver() {
  if (!instance) {
    instance = new UserResolver();
  }
  return instance;
}

module.exports = {
  UserResolver,
  getUserResolver
};
