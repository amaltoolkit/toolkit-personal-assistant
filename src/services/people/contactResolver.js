/**
 * Contact Resolver for People Service
 *
 * Handles external contact resolution (BSA contacts)
 * Refactored from original contactResolver to work with unified PeopleService
 */

const { searchContacts, getContactDetails, linkContactToActivity } = require('../../integrations/bsa/tools/contacts');

class ContactResolver {
  /**
   * Search for contacts in BSA
   * @param {string} query - Search query
   * @param {string} passKey - BSA PassKey
   * @param {string} orgId - Organization ID
   * @param {number} limit - Maximum results
   * @param {boolean} fuzzyFallback - Enable fuzzy fallback
   * @returns {Promise<Array>} Array of matching contacts
   */
  async search(query, passKey, orgId, limit = 10, fuzzyFallback = true) {
    console.log(`[CONTACT:SEARCH] Searching for: "${query}"`);

    try {
      // Direct search
      const contacts = await searchContacts(query, limit, passKey, orgId);

      if (contacts.length > 0) {
        console.log(`[CONTACT:SEARCH] Found ${contacts.length} exact matches`);
        return contacts;
      }

      // Fuzzy fallback if no exact matches
      if (fuzzyFallback && query.length > 2) {
        console.log(`[CONTACT:SEARCH] No exact matches, trying fuzzy search`);

        // Try partial match (first few characters)
        const partialQuery = query.substring(0, Math.min(query.length - 1, 4));
        const partialResults = await searchContacts(partialQuery, limit * 3, passKey, orgId);

        if (partialResults.length > 0) {
          console.log(`[CONTACT:SEARCH] Found ${partialResults.length} partial matches`);
          return partialResults.slice(0, limit);
        }
      }

      return [];
    } catch (error) {
      console.error('[CONTACT:SEARCH] Error:', error.message);
      return [];
    }
  }

  /**
   * Fuzzy search for suggestions
   * @param {string} query - Search query
   * @param {string} passKey - BSA PassKey
   * @param {string} orgId - Organization ID
   * @returns {Promise<Array>} Array of suggestions
   */
  async fuzzySearch(query, passKey, orgId) {
    if (query.length < 2) return [];

    const prefix = query.substring(0, Math.min(query.length, 4));
    const results = await searchContacts(prefix, 10, passKey, orgId);

    return results.slice(0, 3).map(c => ({
      id: c.id,
      name: c.name,
      company: c.company,
      email: c.email
    }));
  }

  /**
   * Get contact details by ID including custom fields
   * @param {string} contactId - Contact ID
   * @param {string} passKey - BSA PassKey
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object>} Contact details
   */
  async getDetails(contactId, passKey, orgId) {
    console.log(`[CONTACT:DETAILS] Fetching details for: ${contactId}`);

    const contact = await getContactDetails(contactId, passKey, orgId, true);

    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    return contact;
  }

  /**
   * Link contact to activity (appointment/task)
   * @param {string} activityType - 'appointment' or 'task'
   * @param {string} activityId - Activity ID
   * @param {string} contactId - Contact ID
   * @param {string} passKey - BSA PassKey
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object>} Link result
   */
  async linkToActivity(activityType, activityId, contactId, passKey, orgId) {
    console.log(`[CONTACT:LINK] Linking ${contactId} to ${activityType} ${activityId}`);

    await linkContactToActivity(activityType, activityId, contactId, passKey, orgId);

    return {
      linked: true,
      type: activityType,
      activityId,
      contactId
    };
  }
}

// Singleton instance
let instance = null;

function getContactResolver() {
  if (!instance) {
    instance = new ContactResolver();
  }
  return instance;
}

module.exports = {
  ContactResolver,
  getContactResolver
};
