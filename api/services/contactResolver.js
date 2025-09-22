/**
 * ContactResolver Service - V2 Architecture
 * Handles contact search, disambiguation, and linking for BSA activities
 * Enhanced with scoring algorithm and memory integration
 */

const axios = require('axios');
const { normalizeBSAResponse, buildBSAHeaders } = require('../tools/bsa/common');
const { getMem0Service } = require('./mem0Service');
const bsaConfig = require('../config/bsa');

class ContactResolver {
  constructor() {
    this.cache = new Map(); // Simple in-memory cache
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    this.mem0Service = getMem0Service();
  }

  /**
   * Search for contacts in BSA with fuzzy matching fallback
   * @param {string} query - Search query (name, email, etc.)
   * @param {number} limit - Maximum results
   * @param {string} passKey - BSA authentication key
   * @param {string} orgId - Organization ID
   * @param {boolean} fuzzyFallback - Try fuzzy matching if exact fails
   * @returns {Promise<Array>} Array of matching contacts
   */
  async search(query, limit = 5, passKey, orgId, fuzzyFallback = true) {
    // Check cache first
    const cacheKey = `search:${query}:${limit}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log(`[CONTACT:CACHE_HIT] Found cached results for "${query}"`);
        return cached.data;
      }
    }

    console.log(`[CONTACT:SEARCH] Searching for "${query}"`);

    // Use the correct OrgData endpoint for search
    const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/search.json';
    const payload = {
      IncludeExtendedProperties: false,
      OrderBy: "LastName, FirstName",
      AscendingOrder: true,
      ResultsPerPage: limit,
      OrganizationId: orgId,
      PassKey: passKey,
      SearchTerm: query,
      PageOffset: 1,
      ObjectName: "contact"
    };

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
        console.warn(`[CONTACT:SEARCH] No results for "${query}"`);
        return [];
      }

      // Map BSA contact fields to our format
      const contacts = (normalized.Results || []).map(c => ({
        id: c.Id,
        name: c.FullName || `${c.FirstName || ''} ${c.LastName || ''}`.trim(),
        email: c.EMailAddress1 || c.EMailAddress2 || c.EMailAddress3,
        phone: c.MobilePhone || c.Telephone1 || c.Telephone2,
        company: c.CompanyName,
        title: c.JobTitle,
        // Additional useful fields
        firstName: c.FirstName,
        lastName: c.LastName,
        clientSince: c.ClientSince
      }));

      // Cache results
      this.cache.set(cacheKey, {
        data: contacts,
        timestamp: Date.now()
      });

      console.log(`[CONTACT:SEARCH] Found ${contacts.length} contacts`);

      // If no results and fuzzy fallback is enabled, try partial matches
      if (contacts.length === 0 && fuzzyFallback && query.length > 2) {
        console.log(`[CONTACT:SEARCH] No exact matches, trying fuzzy search`);

        // Try searching with just the first part of the name
        const nameParts = query.split(' ');
        if (nameParts.length > 1) {
          // Try first name only
          const fuzzyResults = await this.search(nameParts[0], limit * 2, passKey, orgId, false);

          // Filter results that have some similarity to the original query
          const filteredResults = fuzzyResults.filter(contact => {
            const similarity = this.calculateNameSimilarity(query, contact.name);
            return similarity > 0.5; // At least 50% similar
          });

          if (filteredResults.length > 0) {
            console.log(`[CONTACT:SEARCH] Found ${filteredResults.length} fuzzy matches`);

            // Add fuzzy match indicator
            return filteredResults.map(c => ({
              ...c,
              fuzzyMatch: true,
              similarity: this.calculateNameSimilarity(query, c.name)
            }));
          }
        }

        // Try searching for partial matches
        const partialQuery = query.substring(0, Math.min(query.length, 4));
        if (partialQuery !== query) {
          const partialResults = await this.search(partialQuery, limit * 3, passKey, orgId, false);

          // Filter and score results
          const scoredResults = partialResults
            .map(contact => ({
              ...contact,
              fuzzyMatch: true,
              similarity: this.calculateNameSimilarity(query, contact.name)
            }))
            .filter(c => c.similarity > 0.3)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);

          if (scoredResults.length > 0) {
            console.log(`[CONTACT:SEARCH] Found ${scoredResults.length} partial matches`);
            return scoredResults;
          }
        }
      }

      return contacts;
    } catch (error) {
      console.error('[CONTACT:SEARCH] Error:', error.message);
      return [];
    }
  }

  /**
   * Disambiguate multiple contact matches with enhanced scoring
   * @param {Array} candidates - Array of contact candidates
   * @param {Object} context - Context object with query, memoryContext, etc.
   * @returns {Promise<Object>} Selected contact or throws interrupt for user choice
   */
  async disambiguate(candidates, context = {}) {
    // If only one candidate, return it
    if (candidates.length === 1) {
      console.log(`[CONTACT:DISAMBIGUATE] Single match: ${candidates[0].name}`);
      return candidates[0];
    }

    if (candidates.length === 0) {
      throw new Error('No contacts found');
    }

    // Enhanced scoring algorithm (as per migration plan)
    const scored = await this.scoreContacts(candidates, context);

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    // Auto-select if top score is significantly better (2x or more)
    if (scored.length > 1 && scored[0].score > scored[1].score * 2) {
      console.log(`[CONTACT:DISAMBIGUATE] Auto-selected ${scored[0].name} (score: ${scored[0].score})`);
      return scored[0];
    }

    // Otherwise, require user selection via interrupt
    console.log(`[CONTACT:DISAMBIGUATE] Multiple candidates require user selection`);
    
    // Structure data for LangGraph interrupt
    const disambiguationData = {
      type: 'contact_disambiguation',
      message: 'Multiple contacts found. Please select the correct one:',
      candidates: scored.slice(0, 5).map((c, i) => ({
        index: i + 1,
        id: c.id,
        name: c.name,
        company: c.company || 'N/A',
        title: c.title || 'N/A',
        email: c.email || 'N/A',
        score: Math.round(c.score),
        lastInteraction: c.lastInteraction
      }))
    };

    // Return structured data for interrupt handling
    return {
      needsDisambiguation: true,
      topCandidate: scored[0],
      alternatives: disambiguationData.candidates,
      interruptData: disambiguationData
    };
  }

  /**
   * Score contacts using advanced algorithm
   * Scoring weights (from migration plan):
   * - 40% name similarity
   * - 30% role/company match 
   * - 30% recent interactions (from memory)
   */
  async scoreContacts(candidates, context) {
    const { query = '', memoryContext = {}, orgId, userId } = context;
    
    return Promise.all(candidates.map(async contact => {
      let score = 0;
      let lastInteraction = null;
      
      // 1. Name similarity (40%)
      if (contact.name) {
        const nameSimilarity = this.calculateNameSimilarity(query, contact.name);
        score += nameSimilarity * 40;
      }
      
      // 2. Role/Company match (30%)
      if (query) {
        const queryLower = query.toLowerCase();
        
        // Check company match
        if (contact.company && queryLower.includes(contact.company.toLowerCase())) {
          score += 15;
        }
        
        // Check title/role match
        if (contact.title && queryLower.includes(contact.title.toLowerCase())) {
          score += 15;
        }
        
        // Check email domain
        if (contact.email) {
          const domain = contact.email.split('@')[1];
          if (domain && queryLower.includes(domain.split('.')[0])) {
            score += 10;
          }
        }
      }
      
      // 3. Recent interactions from memory (30%)
      if (memoryContext.recalled_memories && memoryContext.recalled_memories.length > 0) {
        const contactNameLower = contact.name?.toLowerCase();
        
        for (const memory of memoryContext.recalled_memories) {
          if (memory.content?.toLowerCase().includes(contactNameLower)) {
            // Found in memory - boost score based on relevance
            score += memory.relevance ? memory.relevance * 30 : 15;
            
            // Track most recent interaction
            if (memory.metadata?.timestamp) {
              const memDate = new Date(memory.metadata.timestamp);
              if (!lastInteraction || memDate > lastInteraction) {
                lastInteraction = memDate;
              }
            }
            break; // Only count once
          }
        }
      }
      
      // Format last interaction for display
      if (lastInteraction) {
        const daysAgo = Math.floor((Date.now() - lastInteraction) / (1000 * 60 * 60 * 24));
        contact.lastInteraction = daysAgo === 0 ? 'Today' : 
                                  daysAgo === 1 ? 'Yesterday' : 
                                  `${daysAgo} days ago`;
      }
      
      return { ...contact, score };
    }));
  }

  /**
   * Calculate name similarity score (0-1)
   */
  calculateNameSimilarity(query, name) {
    if (!query || !name) return 0;
    
    const queryLower = query.toLowerCase();
    const nameLower = name.toLowerCase();
    
    // Exact match
    if (queryLower === nameLower) return 1.0;
    
    // Contains full name
    if (queryLower.includes(nameLower) || nameLower.includes(queryLower)) return 0.9;
    
    // Check individual words
    const queryWords = queryLower.split(/\s+/);
    const nameWords = nameLower.split(/\s+/);
    
    let matchedWords = 0;
    for (const qWord of queryWords) {
      for (const nWord of nameWords) {
        if (qWord === nWord) {
          matchedWords++;
          break;
        }
        // Partial match (e.g., "john" matches "johnson")
        if (qWord.length > 2 && nWord.includes(qWord)) {
          matchedWords += 0.5;
          break;
        }
      }
    }
    
    return Math.min(1.0, matchedWords / Math.max(queryWords.length, nameWords.length));
  }

  /**
   * Link a contact to an activity using the correct BSA linker pattern
   * @param {string} type - Activity type ('appointment' or 'task')
   * @param {string} activityId - Activity ID
   * @param {string} contactId - Contact ID
   * @param {string} passKey - BSA authentication key
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object>} Link result
   */
  async linkActivity(type, activityId, contactId, passKey, orgId) {
    // Map activity types to correct linker names (from listLinkerTypes documentation)
    const LINKER_NAMES = {
      'appointment': 'linker_appointments_contacts',
      'task': 'linker_tasks_contacts'
    };

    const linkerName = LINKER_NAMES[type];
    if (!linkerName) {
      throw new Error(`Unknown activity type for linking: ${type}`);
    }

    // Use the correct OrgData link endpoint
    const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/link.json';
    const payload = {
      LeftObjectName: type,           // 'appointment' or 'task'
      LeftId: activityId,             // The appointment/task ID
      ObjectName: linkerName,         // The specific linker type
      RightObjectName: 'contact',     // Always linking to contact
      RightId: contactId,             // The contact ID
      OrganizationId: orgId,
      PassKey: passKey
    };

    console.log(`[CONTACT:LINK] Linking contact ${contactId} to ${type} ${activityId} using ${linkerName}`);

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
        throw new Error(normalized.error || 'Failed to link contact');
      }

      console.log(`[CONTACT:LINK] Successfully linked using linker: ${linkerName}`);
      return { linked: true, type, activityId, contactId, linkerName };
    } catch (error) {
      console.error('[CONTACT:LINK] Error:', error.message);
      throw error;
    }
  }

  /**
   * Get contact details by ID
   * @param {string} contactId - Contact ID
   * @param {string} passKey - BSA authentication key
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object|null>} Contact details or null
   */
  async getById(contactId, passKey, orgId) {
    // Check cache
    const cacheKey = `contact:${contactId}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }
    }

    const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.portal.VCPortalEndpoint/getCRMEntity.json';
    const payload = {
      entity: "Contact",
      id: contactId,
      orgId
    };

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
        return null;
      }

      const contact = normalized.Contact || normalized.Result;
      if (contact) {
        // Cache the result
        this.cache.set(cacheKey, {
          data: contact,
          timestamp: Date.now()
        });
      }

      return contact;
    } catch (error) {
      console.error('[CONTACT:GET] Error:', error.message);
      return null;
    }
  }

  /**
   * Get multiple contacts by IDs
   * @param {Array<string>} contactIds - Array of contact IDs
   * @param {string} passKey - BSA authentication key
   * @param {string} orgId - Organization ID
   * @returns {Promise<Array>} Array of contact details
   */
  async getMultiple(contactIds, passKey, orgId) {
    const results = [];
    
    // Batch fetch contacts (BSA doesn't have bulk endpoint, so we fetch individually)
    for (const contactId of contactIds) {
      const contact = await this.getById(contactId, passKey, orgId);
      if (contact) {
        results.push(contact);
      }
    }
    
    return results;
  }

  /**
   * Clear the cache (useful for testing)
   */
  clearCache() {
    this.cache.clear();
    console.log('[CONTACT:CACHE] Cache cleared');
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getContactResolver: () => {
    if (!instance) {
      instance = new ContactResolver();
    }
    return instance;
  },
  ContactResolver // Export class for testing
};