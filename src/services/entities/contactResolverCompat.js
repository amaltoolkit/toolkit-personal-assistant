/**
 * Backward-Compatible ContactResolver Wrapper
 *
 * This wrapper maintains the OLD contactResolver API while delegating
 * to the new PeopleService internally. This ensures calendar/task agents
 * keep working during migration.
 *
 * OLD API: search(query, limit, passKey, orgId, fuzzyFallback)
 * NEW API: peopleService.resolveContacts(names, context)
 */

const { getPeopleService } = require('../people');
const { NeedsClarification, PersonNotFound } = require('../people/errors');

class ContactResolverCompat {
  constructor() {
    this.peopleService = getPeopleService();
  }

  /**
   * Search for contacts (backward-compatible signature)
   * @param {string} query - Search query
   * @param {number} limit - Maximum results (ignored, we use disambiguation)
   * @param {string} passKey - BSA PassKey
   * @param {string} orgId - Organization ID
   * @param {boolean} fuzzyFallback - Enable fuzzy fallback (always true in new service)
   * @returns {Promise<Array>} Matching contacts
   */
  async search(query, limit = 5, passKey, orgId, fuzzyFallback = true) {
    console.log(`[CONTACT:COMPAT] search("${query}", ${limit}, ...) - delegating to PeopleService`);

    try {
      // Build context for new service
      const context = {
        passKey,
        org_id: orgId,
        memory_context: {},
        entities: {}
      };

      // Use new service (this will auto-disambiguate or throw error)
      const results = await this.peopleService.resolveContacts([query], context);

      // Return first result (old API expected array but we return single match)
      return results;

    } catch (error) {
      if (error instanceof NeedsClarification) {
        // Old API expected array of candidates, not error
        // Return candidates array for backward compatibility
        console.log(`[CONTACT:COMPAT] Multiple matches - returning candidates array`);
        return error.candidates;
      }

      if (error instanceof PersonNotFound) {
        // Old API expected empty array on not found
        console.log(`[CONTACT:COMPAT] Not found - returning empty array`);
        return [];
      }

      throw error;
    }
  }

  /**
   * Disambiguate contacts (backward-compatible)
   * @param {Array} candidates - Contact candidates
   * @param {Object} context - Context with query, memoryContext
   * @returns {Promise<Object>} Selected contact or disambiguation data
   */
  async disambiguate(candidates, context = {}) {
    console.log(`[CONTACT:COMPAT] disambiguate(${candidates.length} candidates) - delegating to Disambiguator`);

    try {
      const selected = this.peopleService.disambiguator.autoSelect(
        candidates,
        {
          query: context.query || '',
          memory: context.memoryContext || {},
          type: 'contact'
        }
      );

      return selected;

    } catch (error) {
      if (error instanceof NeedsClarification) {
        // Old API format for disambiguation
        return {
          needsDisambiguation: true,
          topCandidate: error.candidates[0],
          alternatives: error.candidates.slice(0, 5).map((c, i) => ({
            index: i + 1,
            id: c.id,
            name: c.name,
            company: c.company || 'N/A',
            title: c.title || 'N/A',
            email: c.email || 'N/A',
            score: Math.round(c.score || 0),
            lastInteraction: c.lastInteraction
          })),
          interruptData: {
            type: 'contact_disambiguation',
            message: 'Multiple contacts found. Please select the correct one:',
            candidates: error.candidates.slice(0, 5)
          }
        };
      }
      throw error;
    }
  }

  /**
   * Link contact to activity (backward-compatible)
   */
  async linkActivity(type, activityId, contactId, passKey, orgId) {
    console.log(`[CONTACT:COMPAT] linkActivity("${type}", ...) - delegating to PeopleService`);

    const context = { passKey, org_id: orgId };
    return this.peopleService.linkToActivity(type, activityId, contactId, context);
  }

  /**
   * Calculate name similarity (backward-compatible)
   */
  calculateNameSimilarity(query, name) {
    return this.peopleService.disambiguator.calculateNameSimilarity(query, name);
  }

  /**
   * Get contact by ID (backward-compatible)
   */
  async getById(contactId, passKey, orgId) {
    console.log(`[CONTACT:COMPAT] getById("${contactId}") - delegating to PeopleService`);

    const context = { passKey, org_id: orgId };
    return this.peopleService.contactResolver.getDetails(contactId, passKey, orgId);
  }
}

// Singleton instance
let instance = null;

function getContactResolver() {
  if (!instance) {
    instance = new ContactResolverCompat();
  }
  return instance;
}

module.exports = {
  ContactResolver: ContactResolverCompat,
  getContactResolver
};
