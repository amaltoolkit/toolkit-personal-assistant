/**
 * Contact Subgraph - Domain-specific graph for contact resolution
 * 
 * Handles contact disambiguation, caching, and entity registration
 * for cross-subgraph contact references.
 */

const { StateGraph, END, interrupt } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { searchContacts, getContactDetails } = require("../tools/bsa/contacts");
const { getMem0Service } = require("../services/mem0Service");
const { getErrorHandler } = require("../services/errorHandler");
const { getPerformanceMetrics } = require("../coordinator/metrics");

// State channels for contact operations
const ContactStateChannels = {
  // Input
  messages: {
    value: (x, y) => y || x,
    default: () => []
  },
  query: {
    value: (x, y) => y || x,
    default: () => ""
  },
  memory_context: {
    value: (x, y) => y || x,
    default: () => ({})
  },
  
  // Processing
  searchQuery: {
    value: (x, y) => y || x,
    default: () => ""
  },
  candidates: {
    value: (x, y) => y || x,
    default: () => []
  },
  selectedContact: {
    value: (x, y) => y || x,
    default: () => null
  },
  scores: {
    value: (x, y) => y || x,
    default: () => {}
  },
  
  // Cache
  sessionCache: {
    value: (x, y) => ({ ...x, ...y }),
    default: () => ({})
  },
  cacheHit: {
    value: (x, y) => y,
    default: () => false
  },
  
  // Output
  entities: {
    value: (x, y) => ({ ...x, ...y }),
    default: () => ({})
  },
  response: {
    value: (x, y) => y || x,
    default: () => ""
  },
  error: {
    value: (x, y) => y || x,
    default: () => null
  }
};

class ContactSubgraph {
  constructor(checkpointer = null) {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.3
    });

    this.mem0 = getMem0Service();
    this.errorHandler = getErrorHandler();
    this.metrics = getPerformanceMetrics();
    this.checkpointer = checkpointer;
    
    // Cache TTL: 1 hour
    this.cacheTTL = 60 * 60 * 1000;
    
    this.graph = this.buildGraph();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: ContactStateChannels
    });

    // Add nodes
    workflow.addNode("check_cache", this.checkSessionCache.bind(this));
    workflow.addNode("extract_name", this.extractContactName.bind(this));
    workflow.addNode("search_bsa", this.searchBSAContacts.bind(this));
    workflow.addNode("score_matches", this.scoreAndRankMatches.bind(this));
    workflow.addNode("disambiguate", this.disambiguateContact.bind(this));
    workflow.addNode("cache_result", this.cacheContactResult.bind(this));
    workflow.addNode("create_entity", this.createContactEntity.bind(this));
    workflow.addNode("format_response", this.formatResponse.bind(this));

    // Define flow
    workflow.setEntryPoint("check_cache");
    
    // Route from cache check
    workflow.addConditionalEdges(
      "check_cache",
      (state) => {
        if (state.error) return "format_response";
        if (state.cacheHit) return "create_entity";
        return "extract_name";
      },
      {
        "format_response": "format_response",
        "create_entity": "create_entity",
        "extract_name": "extract_name"
      }
    );
    
    workflow.addEdge("extract_name", "search_bsa");
    workflow.addEdge("search_bsa", "score_matches");
    
    // Route from scoring
    workflow.addConditionalEdges(
      "score_matches",
      (state) => {
        if (state.error) return "format_response";
        if (state.selectedContact) return "cache_result";
        if (state.candidates?.length > 1) return "disambiguate";
        if (state.candidates?.length === 1) {
          // Auto-select single match
          state.selectedContact = state.candidates[0];
          return "cache_result";
        }
        return "format_response";
      },
      {
        "format_response": "format_response",
        "cache_result": "cache_result",
        "disambiguate": "disambiguate"
      }
    );
    
    workflow.addEdge("disambiguate", "cache_result");
    workflow.addEdge("cache_result", "create_entity");
    workflow.addEdge("create_entity", "format_response");
    workflow.addEdge("format_response", END);

    // Compile with checkpointer if available
    const compileOptions = {};
    if (this.checkpointer) {
      compileOptions.checkpointer = this.checkpointer;
      console.log("[CONTACT] Compiling graph with checkpointer");
    }

    return workflow.compile(compileOptions);
  }

  /**
   * Check session cache for previously resolved contacts
   */
  async checkSessionCache(state) {
    console.log("[CONTACT:CACHE] Checking session cache");
    this.metrics.startTimer("contact_cache_check");
    
    try {
      // Extract query or use from messages
      let query = state.query;
      if (!query && state.messages?.length > 0) {
        const lastMessage = state.messages[state.messages.length - 1];
        query = lastMessage.content;
      }
      
      if (!query) {
        this.metrics.endTimer("contact_cache_check", false, { reason: "no_query" });
        return state;
      }
      
      // Normalize cache key
      const cacheKey = this.normalizeCacheKey(query);
      
      // Check if exists in cache and not expired
      const cached = state.sessionCache[cacheKey];
      if (cached) {
        const age = Date.now() - cached.timestamp;
        if (age < this.cacheTTL) {
          console.log(`[CONTACT:CACHE] Cache hit for "${cacheKey}"`);
          this.metrics.recordCacheHit("contact");
          this.metrics.endTimer("contact_cache_check", true, { hit: true });
          
          return {
            ...state,
            selectedContact: cached.contact,
            cacheHit: true,
            searchQuery: cacheKey
          };
        } else {
          console.log(`[CONTACT:CACHE] Cache expired for "${cacheKey}"`);
          // Clean expired entry
          delete state.sessionCache[cacheKey];
        }
      }
      
      this.metrics.recordCacheMiss("contact");
      this.metrics.endTimer("contact_cache_check", true, { hit: false });
      
      return {
        ...state,
        cacheHit: false,
        searchQuery: query
      };
      
    } catch (error) {
      console.error("[CONTACT:CACHE] Error checking cache:", error);
      this.metrics.endTimer("contact_cache_check", false, { error: error.message });
      return {
        ...state,
        error: `Cache check failed: ${error.message}`
      };
    }
  }

  /**
   * Extract contact name and context from query
   */
  async extractContactName(state) {
    console.log("[CONTACT:EXTRACT] Extracting contact name from query");
    
    try {
      const query = state.searchQuery || state.query;
      
      const prompt = `
        Extract the contact name and any contextual information from this query.
        Query: "${query}"
        
        Return JSON:
        {
          "name": "extracted name or null",
          "context": {
            "role": "if mentioned (e.g., advisor, client, manager)",
            "company": "if mentioned",
            "relationship": "if mentioned (e.g., my, our, the)"
          }
        }
        
        Examples:
        "Schedule with John Smith" -> {"name": "John Smith", "context": {}}
        "Meet with my advisor Sarah" -> {"name": "Sarah", "context": {"relationship": "my", "role": "advisor"}}
        "Call the client from ABC Corp" -> {"name": null, "context": {"relationship": "the", "role": "client", "company": "ABC Corp"}}
      `;
      
      const response = await this.llm.invoke(prompt);
      const extracted = JSON.parse(response.content);
      
      console.log("[CONTACT:EXTRACT] Extracted:", extracted);
      
      return {
        ...state,
        searchQuery: extracted.name || query,
        extractedContext: extracted.context
      };
      
    } catch (error) {
      console.error("[CONTACT:EXTRACT] Error extracting name:", error);
      // Continue with original query
      return state;
    }
  }

  /**
   * Search BSA for matching contacts
   */
  async searchBSAContacts(state, config) {
    console.log("[CONTACT:SEARCH] Searching BSA for contacts");
    this.metrics.startTimer("contact_bsa_search");
    
    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      // Search with retry logic
      const contacts = await this.errorHandler.executeWithRetry(
        async () => await searchContacts(
          state.searchQuery,
          10,
          passKey,
          orgId
        ),
        {
          operation: "contact_search",
          maxRetries: 2,
          circuitBreakerKey: "bsa_contacts"
        }
      );
      
      console.log(`[CONTACT:SEARCH] Found ${contacts.length} contacts`);
      this.metrics.endTimer("contact_bsa_search", true, { count: contacts.length });
      
      return {
        ...state,
        candidates: contacts
      };
      
    } catch (error) {
      console.error("[CONTACT:SEARCH] Error searching contacts:", error);
      this.metrics.endTimer("contact_bsa_search", false, { error: error.message });
      
      return {
        ...state,
        error: `Contact search failed: ${error.message}`,
        candidates: []
      };
    }
  }

  /**
   * Score and rank contact matches
   */
  async scoreAndRankMatches(state) {
    console.log("[CONTACT:SCORE] Scoring contact matches");
    
    if (!state.candidates || state.candidates.length === 0) {
      return {
        ...state,
        selectedContact: null
      };
    }
    
    try {
      const scores = {};
      const context = state.extractedContext || {};
      const memoryContext = state.memory_context;
      
      // Score each candidate
      for (const contact of state.candidates) {
        let score = 0;
        
        // 1. Name similarity (40%)
        const nameSimilarity = this.calculateNameSimilarity(
          state.searchQuery,
          contact.name
        );
        score += nameSimilarity * 40;
        
        // 2. Role/Company match (30%)
        if (context.role && contact.title) {
          const roleMatch = this.fuzzyMatch(context.role, contact.title);
          score += roleMatch * 15;
        }
        if (context.company && contact.company) {
          const companyMatch = this.fuzzyMatch(context.company, contact.company);
          score += companyMatch * 15;
        }
        
        // 3. Recent interactions (30%)
        if (memoryContext?.recalled_memories) {
          const mentioned = memoryContext.recalled_memories.some(m => 
            m.content?.toLowerCase().includes(contact.name?.toLowerCase())
          );
          if (mentioned) score += 30;
        }
        
        scores[contact.id] = Math.round(score);
        contact.score = scores[contact.id];
      }
      
      // Sort by score
      state.candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
      
      // Auto-select if clear winner
      if (state.candidates.length === 1) {
        console.log("[CONTACT:SCORE] Single match, auto-selecting");
        return {
          ...state,
          selectedContact: state.candidates[0],
          scores
        };
      }
      
      const topScore = state.candidates[0].score || 0;
      const secondScore = state.candidates[1]?.score || 0;
      
      if (topScore >= 80 && secondScore < 50) {
        console.log(`[CONTACT:SCORE] Clear winner with score ${topScore}, auto-selecting`);
        return {
          ...state,
          selectedContact: state.candidates[0],
          scores
        };
      }
      
      console.log("[CONTACT:SCORE] Multiple candidates need disambiguation");
      return {
        ...state,
        scores,
        selectedContact: null
      };
      
    } catch (error) {
      console.error("[CONTACT:SCORE] Error scoring matches:", error);
      return {
        ...state,
        error: `Scoring failed: ${error.message}`
      };
    }
  }

  /**
   * Trigger disambiguation interrupt for user selection
   */
  async disambiguateContact(state) {
    console.log("[CONTACT:DISAMBIGUATE] Multiple matches, requesting user selection");
    
    try {
      // Format candidates for UI with enhanced display data
      const formattedCandidates = state.candidates.slice(0, 5).map(c => ({
        id: c.id,
        name: c.name,
        role: c.title || c.role || '',
        company: c.company || '',
        email: c.email || '',
        phone: c.phone || '',
        score: Math.round(c.score || 0),
        initials: this.getInitials(c.name),
        avatarColor: this.getAvatarColor(c.name),
        lastInteraction: this.formatLastInteraction(c, state.memory_context),
        metadata: {
          department: c.department,
          location: c.location,
          linkedin: c.linkedin
        }
      }));
      
      // Throw interrupt for user selection
      throw interrupt({
        value: {
          type: "contact_disambiguation",
          message: `Multiple contacts found for "${state.searchQuery}". Please select the correct one:`,
          query: state.searchQuery,
          candidates: formattedCandidates,
          allowCreate: false, // Don't allow creating new contacts for now
          allowSearch: true   // Allow searching if none match
        }
      });
      
    } catch (error) {
      // If it's an interrupt, re-throw it
      if (error.name === "Interrupt") {
        throw error;
      }
      
      console.error("[CONTACT:DISAMBIGUATE] Error:", error);
      return {
        ...state,
        error: `Disambiguation failed: ${error.message}`
      };
    }
  }
  
  /**
   * Get initials from name for avatar display
   */
  getInitials(name) {
    if (!name) return '??';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  }
  
  /**
   * Generate consistent avatar color based on name
   */
  getAvatarColor(name) {
    if (!name) return '#gray';
    // Generate color from name hash
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  }
  
  /**
   * Format last interaction date for display
   */
  formatLastInteraction(contact, memoryContext) {
    // First check memory context
    if (memoryContext?.recalled_memories) {
      const contactNameLower = contact.name?.toLowerCase();
      for (const memory of memoryContext.recalled_memories) {
        if (memory.content?.toLowerCase().includes(contactNameLower)) {
          if (memory.metadata?.timestamp) {
            const date = new Date(memory.metadata.timestamp);
            const daysAgo = Math.floor((Date.now() - date) / (1000 * 60 * 60 * 24));
            
            if (daysAgo === 0) return 'Today';
            if (daysAgo === 1) return 'Yesterday';
            if (daysAgo < 7) return `${daysAgo} days ago`;
            if (daysAgo < 30) return `${Math.floor(daysAgo / 7)} weeks ago`;
            if (daysAgo < 365) return `${Math.floor(daysAgo / 30)} months ago`;
            return 'Over a year ago';
          }
        }
      }
    }
    
    // Check if contact has lastInteraction field
    if (contact.lastInteraction) {
      return contact.lastInteraction;
    }
    
    return null; // No interaction found
  }

  /**
   * Cache the selected contact
   */
  async cacheContactResult(state) {
    console.log("[CONTACT:CACHE] Caching selected contact");
    
    if (!state.selectedContact) {
      return state;
    }
    
    try {
      const cacheKey = this.normalizeCacheKey(state.searchQuery);
      
      // Store in session cache
      const updatedCache = {
        ...state.sessionCache,
        [cacheKey]: {
          contact: state.selectedContact,
          timestamp: Date.now()
        }
      };
      
      // Clean old entries (keep max 50)
      const entries = Object.entries(updatedCache);
      if (entries.length > 50) {
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, entries.length - 50);
        toRemove.forEach(([key]) => delete updatedCache[key]);
      }
      
      console.log(`[CONTACT:CACHE] Cached contact "${state.selectedContact.name}"`);
      
      return {
        ...state,
        sessionCache: updatedCache
      };
      
    } catch (error) {
      console.error("[CONTACT:CACHE] Error caching result:", error);
      // Continue without caching
      return state;
    }
  }

  /**
   * Create contact entity for cross-subgraph sharing
   */
  async createContactEntity(state) {
    console.log("[CONTACT:ENTITY] Creating contact entity");
    
    if (!state.selectedContact) {
      return state;
    }
    
    try {
      const contact = state.selectedContact;
      
      // Create entity with multiple references
      const entity = {
        id: `contact_${contact.id}`,
        type: "contact",
        name: contact.name,
        data: {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          company: contact.company,
          title: contact.title
        },
        references: [
          contact.name,
          contact.name.toLowerCase(),
          contact.email,
          `contact ${contact.id}`
        ],
        createdAt: Date.now()
      };
      
      // Add to first name reference if exists
      const firstName = contact.name?.split(' ')[0];
      if (firstName) {
        entity.references.push(firstName);
        entity.references.push(firstName.toLowerCase());
      }
      
      console.log(`[CONTACT:ENTITY] Created entity for "${contact.name}"`);
      
      return {
        ...state,
        entities: {
          ...state.entities,
          [entity.id]: entity,
          // Also store as "last_contact" for easy reference
          last_contact: entity
        }
      };
      
    } catch (error) {
      console.error("[CONTACT:ENTITY] Error creating entity:", error);
      return {
        ...state,
        error: `Entity creation failed: ${error.message}`
      };
    }
  }

  /**
   * Format final response
   */
  async formatResponse(state) {
    console.log("[CONTACT:RESPONSE] Formatting response");
    
    if (state.error) {
      return {
        ...state,
        response: `Error resolving contact: ${state.error}`
      };
    }
    
    if (state.selectedContact) {
      return {
        ...state,
        response: `Contact resolved: ${state.selectedContact.name}${
          state.selectedContact.company ? ` (${state.selectedContact.company})` : ''
        }`
      };
    }
    
    return {
      ...state,
      response: "No matching contacts found"
    };
  }

  // Helper methods

  /**
   * Normalize cache key
   */
  normalizeCacheKey(query) {
    return query.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  }

  /**
   * Calculate name similarity (Levenshtein distance)
   */
  calculateNameSimilarity(query, name) {
    if (!query || !name) return 0;
    
    const q = query.toLowerCase();
    const n = name.toLowerCase();
    
    // Exact match
    if (q === n) return 1;
    
    // Contains match
    if (n.includes(q) || q.includes(n)) return 0.8;
    
    // Calculate Levenshtein distance
    const matrix = [];
    for (let i = 0; i <= n.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= q.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= n.length; i++) {
      for (let j = 1; j <= q.length; j++) {
        if (n[i - 1] === q[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    const distance = matrix[n.length][q.length];
    const maxLength = Math.max(n.length, q.length);
    return Math.max(0, 1 - distance / maxLength);
  }

  /**
   * Fuzzy string matching
   */
  fuzzyMatch(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    
    if (s1 === s2) return 1;
    if (s1.includes(s2) || s2.includes(s1)) return 0.7;
    
    // Check word overlap
    const words1 = s1.split(/\s+/);
    const words2 = s2.split(/\s+/);
    const overlap = words1.filter(w => words2.includes(w)).length;
    
    return overlap / Math.max(words1.length, words2.length);
  }

  /**
   * Get recent interaction from memory
   */
  getRecentInteraction(contact, memoryContext) {
    if (!memoryContext?.recalled_memories) return null;
    
    const memory = memoryContext.recalled_memories.find(m =>
      m.content?.toLowerCase().includes(contact.name?.toLowerCase())
    );
    
    if (memory) {
      // Extract date if present
      const dateMatch = memory.content.match(/\d{4}-\d{2}-\d{2}/);
      if (dateMatch) {
        return `Last mentioned: ${dateMatch[0]}`;
      }
      return "Recently mentioned";
    }
    
    return null;
  }

  /**
   * Main entry point for contact resolution
   */
  async resolve(query, context = {}) {
    console.log("[CONTACT] Resolving contact:", query);
    
    const initialState = {
      query,
      messages: context.messages || [],
      memory_context: context.memory_context || {},
      sessionCache: context.sessionCache || {},
      entities: context.entities || {}
    };
    
    try {
      const result = await this.graph.invoke(initialState, {
        configurable: context.configurable || {}
      });
      
      return result;
      
    } catch (error) {
      console.error("[CONTACT] Error resolving contact:", error);
      return {
        ...initialState,
        error: error.message,
        response: `Failed to resolve contact: ${error.message}`
      };
    }
  }
}

// Export factory function for coordinator
async function createSubgraph(checkpointer = null) {
  const subgraph = new ContactSubgraph(checkpointer);
  return subgraph.graph;
}

// Export singleton instance (for backward compatibility)
let instance = null;

module.exports = {
  createSubgraph,
  getContactSubgraph: () => {
    if (!instance) {
      instance = new ContactSubgraph();
    }
    return instance;
  },
  ContactSubgraph
};