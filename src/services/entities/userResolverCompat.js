/**
 * Backward-Compatible UserResolver Wrapper
 *
 * This wrapper maintains the OLD userResolver API while delegating
 * to the new PeopleService internally.
 */

const { getPeopleService } = require('../people');
const { NeedsClarification, PersonNotFound } = require('../people/errors');

class UserResolverCompat {
  constructor() {
    this.peopleService = getPeopleService();
    // Expose userSyncService for direct access (used by calendar agent)
    this.userSyncService = this.peopleService.userResolver.userSyncService;
  }

  /**
   * Resolve "me" pronoun (backward-compatible)
   */
  async resolveMe(sessionId, orgId) {
    console.log(`[USER:COMPAT] resolveMe() - delegating to PeopleService`);

    const context = { session_id: sessionId, org_id: orgId };
    return this.peopleService.resolveMe(context);
  }

  /**
   * Check if query is self-reference (backward-compatible)
   */
  isSelfReference(query) {
    return this.peopleService.userResolver.isSelfReference(query);
  }

  /**
   * Search for users (backward-compatible)
   * @param {string} query - Search query
   * @param {string} orgId - Organization ID
   * @param {number} limit - Maximum results
   * @param {boolean} fuzzyFallback - Enable fuzzy fallback
   * @returns {Promise<Array>} Matching users
   */
  async search(query, orgId, limit = 5, fuzzyFallback = true) {
    console.log(`[USER:COMPAT] search("${query}", ...) - delegating to PeopleService`);

    try {
      const context = {
        org_id: orgId,
        memory_context: {},
        entities: {}
      };

      // Use new service
      const results = await this.peopleService.resolveUsers([query], context);
      return results;

    } catch (error) {
      if (error instanceof NeedsClarification) {
        // Return candidates for backward compatibility
        console.log(`[USER:COMPAT] Multiple matches - returning candidates array`);
        return error.candidates;
      }

      if (error instanceof PersonNotFound) {
        console.log(`[USER:COMPAT] Not found - returning empty array`);
        return [];
      }

      throw error;
    }
  }

  /**
   * Disambiguate users (backward-compatible)
   */
  async disambiguate(candidates, context = {}) {
    console.log(`[USER:COMPAT] disambiguate(${candidates.length} candidates) - delegating to Disambiguator`);

    try {
      const selected = this.peopleService.disambiguator.autoSelect(
        candidates,
        {
          query: context.query || '',
          memory: context.memoryContext || {},
          type: 'user'
        }
      );

      return selected;

    } catch (error) {
      if (error instanceof NeedsClarification) {
        // Old API format
        return {
          needsDisambiguation: true,
          topCandidate: error.candidates[0],
          alternatives: error.candidates.slice(0, 5).map((c, i) => ({
            index: i + 1,
            id: c.id,
            name: c.name,
            title: c.title || 'N/A',
            email: c.email || 'N/A',
            department: c.department || 'N/A',
            score: Math.round(c.score || 0)
          })),
          interruptData: {
            type: 'user_disambiguation',
            message: 'Multiple users found. Please select the correct one:',
            candidates: error.candidates.slice(0, 5)
          }
        };
      }
      throw error;
    }
  }

  /**
   * Calculate name similarity (backward-compatible)
   */
  calculateNameSimilarity(query, name) {
    return this.peopleService.disambiguator.calculateNameSimilarity(query, name);
  }

  /**
   * Get user by ID (backward-compatible)
   */
  async getUserById(userId, orgId) {
    console.log(`[USER:COMPAT] getUserById("${userId}") - delegating to PeopleService`);

    const context = { org_id: orgId };
    return this.peopleService.userResolver.getDetails(userId, orgId);
  }
}

// Singleton instance
let instance = null;

function getUserResolver() {
  if (!instance) {
    instance = new UserResolverCompat();
  }
  return instance;
}

module.exports = {
  UserResolver: UserResolverCompat,
  getUserResolver
};
