/**
 * People Service - Unified resolution for users and contacts
 *
 * This service provides a single interface for resolving both internal users
 * and external contacts, with shared disambiguation and caching logic.
 *
 * Key features:
 * - Resolves internal users (faster, local DB)
 * - Resolves external contacts (BSA API)
 * - Smart resolution (tries users first, falls back to contacts)
 * - Shared disambiguation algorithm
 * - Field extraction for both users and contacts
 * - Secure caching with session + org scoping
 */

const { UserResolver } = require('./userResolver');
const { ContactResolver } = require('./contactResolver');
const { getDisambiguator } = require('./disambiguator');
const { getFieldExtractor } = require('./fieldExtractor');
const { NeedsClarification, PersonNotFound } = require('./errors');

class PeopleService {
  constructor() {
    this.userResolver = new UserResolver();
    this.contactResolver = new ContactResolver();
    this.disambiguator = getDisambiguator();
    this.fieldExtractor = getFieldExtractor();
  }

  /**
   * Resolve "me" to current user
   * @param {Object} context - { session_id, org_id }
   * @returns {Promise<Object|null>} Current user or null
   */
  async resolveMe(context) {
    const { session_id, org_id } = context;
    return this.userResolver.resolveMe(session_id, org_id);
  }

  /**
   * Resolve internal users only
   * @param {string[]} names - Array of user names to resolve
   * @param {Object} context - { session_id, org_id, memory_context, entities }
   * @returns {Promise<Object[]>} Resolved users
   * @throws {NeedsClarification} if disambiguation needed
   * @throws {PersonNotFound} if no matches found
   */
  async resolveUsers(names, context) {
    const { org_id, memory_context } = context;
    const results = [];

    for (const name of names) {
      // Check if "me" reference
      if (this.userResolver.isSelfReference(name)) {
        const me = await this.resolveMe(context);
        if (me) {
          results.push(me);
          continue;
        }
      }

      // Search for user
      const candidates = await this.userResolver.search(name, org_id);

      if (candidates.length === 0) {
        const suggestions = await this.userResolver.fuzzySearch(name, org_id);
        throw new PersonNotFound(name, 'user', suggestions);
      }

      // Disambiguate
      const selected = this.disambiguator.autoSelect(
        candidates,
        { query: name, memory: memory_context, type: 'user' }
      );

      results.push(selected);
    }

    return results;
  }

  /**
   * Resolve external contacts only
   * @param {string[]} names - Array of contact names to resolve
   * @param {Object} context - { passKey, org_id, memory_context, entities }
   * @returns {Promise<Object[]>} Resolved contacts
   * @throws {NeedsClarification} if disambiguation needed
   * @throws {PersonNotFound} if no matches found
   */
  async resolveContacts(names, context) {
    const { passKey, org_id, memory_context } = context;
    const results = [];

    for (const name of names) {
      // Search BSA
      const candidates = await this.contactResolver.search(name, passKey, org_id);

      if (candidates.length === 0) {
        const suggestions = await this.contactResolver.fuzzySearch(name, passKey, org_id);
        throw new PersonNotFound(name, 'contact', suggestions);
      }

      // Disambiguate
      const selected = this.disambiguator.autoSelect(
        candidates,
        { query: name, memory: memory_context, type: 'contact' }
      );

      results.push(selected);
    }

    return results;
  }

  /**
   * Smart resolution - tries users first (faster), then contacts
   * Use when type is ambiguous: "Book meeting with John"
   *
   * @param {string[]} names - Array of person names to resolve
   * @param {Object} context - { session_id, org_id, passKey, memory_context, entities }
   * @param {boolean} preferUsers - Try users first (default true)
   * @returns {Promise<Object[]>} Resolved people with resolved_as field
   * @throws {NeedsClarification} if disambiguation needed
   * @throws {PersonNotFound} if no matches found
   */
  async resolve(names, context, preferUsers = true) {
    const { session_id, org_id, passKey, memory_context } = context;
    const results = [];

    for (const name of names) {
      // Check if "me" reference
      if (this.userResolver.isSelfReference(name)) {
        const me = await this.resolveMe(context);
        if (me) {
          results.push({ ...me, resolved_as: 'user' });
          continue;
        }
      }

      let found = false;

      // Try users first (local DB, faster)
      if (preferUsers) {
        const userCandidates = await this.userResolver.search(name, org_id, 5, false);

        if (userCandidates.length > 0) {
          const selected = this.disambiguator.autoSelect(
            userCandidates,
            { query: name, memory: memory_context, type: 'user' }
          );
          results.push({ ...selected, resolved_as: 'user' });
          found = true;
        }
      }

      if (found) continue;

      // Try contacts (BSA API)
      const contactCandidates = await this.contactResolver.search(name, passKey, org_id, 5, false);

      if (contactCandidates.length > 0) {
        const selected = this.disambiguator.autoSelect(
          contactCandidates,
          { query: name, memory: memory_context, type: 'contact' }
        );
        results.push({ ...selected, resolved_as: 'contact' });
        found = true;
      }

      if (found) continue;

      // Not found in either - try fuzzy suggestions from both
      const userSuggestions = await this.userResolver.fuzzySearch(name, org_id);
      const contactSuggestions = await this.contactResolver.fuzzySearch(name, passKey, org_id);
      const allSuggestions = [...userSuggestions, ...contactSuggestions];

      throw new PersonNotFound(name, 'person', allSuggestions);
    }

    return results;
  }

  /**
   * Get contact/user details including custom fields
   * @param {string} nameOrId - Person name or ID
   * @param {string} type - 'user' | 'contact'
   * @param {Object} context - { session_id, org_id, passKey, memory_context }
   * @returns {Promise<Object>} Person details
   */
  async getDetails(nameOrId, type, context) {
    const { org_id, passKey } = context;

    // Resolve name to ID if needed
    let personId = nameOrId;

    if (!this._isId(nameOrId)) {
      // Name provided - resolve first
      const resolved = type === 'user'
        ? await this.resolveUsers([nameOrId], context)
        : await this.resolveContacts([nameOrId], context);

      personId = resolved[0].id;
    }

    // Fetch details
    if (type === 'user') {
      return this.userResolver.getDetails(personId, org_id);
    } else {
      return this.contactResolver.getDetails(personId, passKey, org_id);
    }
  }

  /**
   * Get specific field value
   * @param {string} nameOrId - Person name or ID
   * @param {string} fieldName - Field name to extract
   * @param {string} type - 'user' | 'contact'
   * @param {Object} context - Context object
   * @returns {Promise<string>} Formatted field value
   */
  async getField(nameOrId, fieldName, type, context) {
    const details = await this.getDetails(nameOrId, type, context);
    return this.fieldExtractor.extract(details, fieldName, type);
  }

  /**
   * Link contact to activity (contacts only, not users)
   * @param {string} activityType - 'appointment' | 'task'
   * @param {string} activityId - Activity ID
   * @param {string} contactId - Contact ID
   * @param {Object} context - { passKey, org_id }
   * @returns {Promise<Object>} Link result
   */
  async linkToActivity(activityType, activityId, contactId, context) {
    const { passKey, org_id } = context;
    return this.contactResolver.linkToActivity(
      activityType,
      activityId,
      contactId,
      passKey,
      org_id
    );
  }

  /**
   * Get all users in organization
   * @param {Object} context - { org_id }
   * @returns {Promise<Array>} All users
   */
  async getAllUsers(context) {
    const { org_id } = context;
    return this.userResolver.getAllUsers(org_id);
  }

  /**
   * Check if string is a UUID/ID
   * @private
   */
  _isId(str) {
    return /^[0-9a-f-]{36}$/i.test(str);
  }
}

// Singleton instance
let instance = null;

/**
 * Get singleton PeopleService instance
 * @returns {PeopleService}
 */
function getPeopleService() {
  if (!instance) {
    instance = new PeopleService();
  }
  return instance;
}

module.exports = {
  PeopleService,
  getPeopleService
};
