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
   * Search for contacts in BSA
   * @param {string} query - Search query (name, email, etc.)
   * @param {number} limit - Maximum results
   * @param {string} passKey - BSA authentication key
   * @returns {Promise<Array>} Array of matching contacts
   */
  async search(query, limit = 5, passKey) {
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

    // Search BSA contacts
    const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.portal.VCPortalEndpoint/doRetrieveCRMData.json';
    const payload = {
      entity: "Contact",
      searchText: query,
      maxResults: limit,
      fields: ["id", "name", "email", "phone", "company", "title"]
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

      const contacts = (normalized.Results || normalized.contacts || []).map(c => ({
        id: c.id || c.Id,
        name: c.name || c.Name || c.DisplayName,
        email: c.email || c.Email,
        phone: c.phone || c.Phone,
        company: c.company || c.Company || c.AccountName,
        title: c.title || c.Title || c.JobTitle
      }));
      
      // Cache results
      this.cache.set(cacheKey, {
        data: contacts,
        timestamp: Date.now()
      });

      console.log(`[CONTACT:SEARCH] Found ${contacts.length} contacts`);
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
   * Link a contact to an activity
   * @param {string} type - Activity type ('appointment' or 'task')
   * @param {string} activityId - Activity ID
   * @param {string} contactId - Contact ID
   * @param {string} passKey - BSA authentication key
   * @param {string} orgId - Organization ID
   * @returns {Promise<Object>} Link result
   */
  async linkActivity(type, activityId, contactId, passKey, orgId) {
    const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/updateActivityLinks.json';
    const payload = {
      OrgId: orgId,
      Id: activityId,
      TypeCode: type,
      LinkerName: "ActivityContactLinker",
      LinkedEntitySchemaName: "Contact",
      Action: 1, // Add link
      ItemIds: [contactId]
    };
    
    console.log(`[CONTACT:LINK] Linking contact ${contactId} to ${type} ${activityId}`);
    
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
      
      console.log(`[CONTACT:LINK] Successfully linked`);
      return { linked: true, type, activityId, contactId };
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