/**
 * Contact Subgraph - Domain-specific graph for contact resolution
 * 
 * Handles contact disambiguation, caching, and entity registration
 * for cross-subgraph contact references.
 */

const { StateGraph, END, interrupt } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { searchContacts, getContactDetails } = require("../../../integrations/bsa/tools/contacts");
const { getMem0Service } = require("../../../services/memory/mem0Service");
const { getErrorHandler } = require("../../../services/errors/errorHandler");
const { getPerformanceMetrics } = require("../../coordinator/metrics");

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
  
  // Query processing fields
  queryType: {
    value: (x, y) => y || x,
    default: () => null  // 'search' | 'info' | 'mixed'
  },
  requestedField: {
    value: (x, y) => y || x,
    default: () => null
  },
  contactDetails: {
    value: (x, y) => y || x,
    default: () => null  // Full contact with extended properties
  },
  fieldValue: {
    value: (x, y) => y || x,
    default: () => null
  },
  isCustomField: {
    value: (x, y) => y !== undefined ? y : x,
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
  },

  // Context fields (required for authentication and state management)
  session_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  org_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  user_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  thread_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  timezone: {
    value: (x, y) => y || x,
    default: () => 'UTC'
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
    workflow.addNode("classify_query", this.classifyQuery.bind(this));
    workflow.addNode("check_cache", this.checkSessionCache.bind(this));
    workflow.addNode("extract_name", this.extractContactName.bind(this));
    workflow.addNode("search_bsa", this.searchBSAContacts.bind(this));
    workflow.addNode("score_matches", this.scoreAndRankMatches.bind(this));
    workflow.addNode("disambiguate", this.disambiguateContact.bind(this));
    workflow.addNode("cache_result", this.cacheContactResult.bind(this));
    workflow.addNode("create_entity", this.createContactEntity.bind(this));
    workflow.addNode("resolve_contact", this.resolveContact.bind(this));
    workflow.addNode("fetch_details", this.fetchContactDetails.bind(this));
    workflow.addNode("extract_field", this.extractField.bind(this));
    workflow.addNode("answer_query", this.answerQuery.bind(this));
    workflow.addNode("format_response", this.formatResponse.bind(this));

    // Define flow
    workflow.setEntryPoint("classify_query");

    // Route from query classification
    workflow.addConditionalEdges(
      "classify_query",
      (state) => {
        if (state.error) return "format_response";
        if (state.queryType === 'info') return "resolve_contact";
        // Default: 'search' or null goes to normal search flow
        return "check_cache";
      },
      {
        "format_response": "format_response",
        "resolve_contact": "resolve_contact",
        "check_cache": "check_cache"
      }
    );

    // Route from cache check (existing search flow)
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

    // After caching search results, check if this was an info query
    workflow.addConditionalEdges(
      "cache_result",
      (state) => {
        if (state.queryType === 'info') return "fetch_details";
        return "create_entity";
      },
      {
        "fetch_details": "fetch_details",
        "create_entity": "create_entity"
      }
    );

    workflow.addEdge("create_entity", "format_response");

    // Info query flow - conditional routing based on whether contact was resolved
    workflow.addConditionalEdges(
      "resolve_contact",
      (state) => {
        if (state.error) return "format_response";
        if (state.selectedContact) return "fetch_details";
        // Contact not found - route to search flow
        return "extract_name";
      },
      {
        "format_response": "format_response",
        "fetch_details": "fetch_details",
        "extract_name": "extract_name"
      }
    );
    workflow.addEdge("fetch_details", "extract_field");
    workflow.addEdge("extract_field", "answer_query");
    workflow.addEdge("answer_query", "create_entity");

    workflow.addEdge("format_response", END);

    // Always compile WITHOUT checkpointer - subgraphs are stateless
    // This prevents deadlocks from concurrent checkpoint writes
    const compileOptions = {};
    console.log("[CONTACT] Compiling graph in STATELESS mode (no checkpointer)");

    return workflow.compile(compileOptions);
  }

  /**
   * Classify the query type: search vs. information request
   */
  async classifyQuery(state) {
    console.log("[CONTACT:CLASSIFY] Classifying query type");
    this.metrics.startTimer("contact_classify");

    try {
      // Extract query
      let query = state.query;
      if (!query && state.messages?.length > 0) {
        const lastMessage = state.messages[state.messages.length - 1];
        query = lastMessage.content;
      }

      if (!query) {
        this.metrics.endTimer("contact_classify", false, { reason: "no_query" });
        return {
          ...state,
          queryType: 'search',  // Default to search
          error: null
        };
      }

      // Use LLM to classify the query
      const prompt = `
        You are classifying a contact-related query.

        Query: "${query}"

        Classification types:
        - "search": User wants to find/resolve a contact by name (e.g., "Find Norman", "Who is Sarah")
        - "info": User wants specific information about a contact (e.g., "When is Norman's birthday?", "What's his email?")
        - "mixed": Both (e.g., "Find Norman and tell me his email")

        Return ONLY JSON (no markdown, no explanation):
        {
          "type": "search|info|mixed",
          "contactName": "extracted name or null",
          "fieldRequested": "field being asked about or null"
        }

        Examples:
        - "Find Norman" → {"type": "search", "contactName": "Norman", "fieldRequested": null}
        - "When is Norman's birthday?" → {"type": "info", "contactName": "Norman", "fieldRequested": "birthday"}
        - "What's his email?" → {"type": "info", "contactName": null, "fieldRequested": "email"}
        - "Find Sarah and get her phone number" → {"type": "mixed", "contactName": "Sarah", "fieldRequested": "phone"}
      `;

      const response = await this.llm.invoke(prompt);
      let content = response.content;

      // Strip markdown formatting if present
      if (content.includes('```json')) {
        content = content.split('```json')[1].split('```')[0].trim();
      } else if (content.includes('```')) {
        content = content.split('```')[1].split('```')[0].trim();
      }

      const classification = JSON.parse(content);

      console.log("[CONTACT:CLASSIFY] Classification result:", {
        type: classification.type,
        contactName: classification.contactName,
        fieldRequested: classification.fieldRequested
      });

      this.metrics.endTimer("contact_classify", true, { type: classification.type });

      return {
        ...state,
        queryType: classification.type,
        searchQuery: classification.contactName || query,
        requestedField: classification.fieldRequested,
        error: null
      };

    } catch (error) {
      console.error("[CONTACT:CLASSIFY] Error classifying query:", error);
      this.metrics.endTimer("contact_classify", false, { error: error.message });

      // Fallback to search on error
      return {
        ...state,
        queryType: 'search',
        error: null  // Don't fail the whole flow
      };
    }
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
      let content = response.content;

      // Strip markdown formatting if present
      if (content.includes('```json')) {
        content = content.split('```json')[1].split('```')[0].trim();
      } else if (content.includes('```')) {
        content = content.split('```')[1].split('```')[0].trim();
      }

      const extracted = JSON.parse(content);

      console.log("[CONTACT:EXTRACT] Extracted:", extracted);

      return {
        ...state,
        searchQuery: extracted.name || query,
        extractedContext: extracted.context
      };

    } catch (error) {
      console.error("[CONTACT:EXTRACT] Error extracting name:", error);

      // Try basic extraction as fallback
      const query = state.searchQuery || state.messages?.[0]?.content || '';

      // Look for common patterns like "with NAME" or "and NAME"
      const patterns = [
        /with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
        /and\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
        /[Cc]ontact\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
        /meet\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
        /call\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
        /email\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
      ];

      for (const pattern of patterns) {
        const match = query.match(pattern);
        if (match) {
          console.log("[CONTACT:EXTRACT] Fallback extracted:", match[1]);
          return {
            ...state,
            searchQuery: match[1],
            extractedContext: {}
          };
        }
      }

      // If no pattern matches, return empty to avoid bad search
      console.log("[CONTACT:EXTRACT] No name found, skipping search");
      return {
        ...state,
        searchQuery: null,
        error: "Could not extract contact name from query"
      };
    }
  }

  /**
   * Search BSA for matching contacts
   */
  async searchBSAContacts(state, config) {
    console.log("[CONTACT:SEARCH] Searching BSA for contacts");
    this.metrics.startTimer("contact_bsa_search");

    try {
      // Validate search query
      if (!state.searchQuery) {
        console.log("[CONTACT:SEARCH] No search query available, skipping search");
        return {
          ...state,
          candidates: []
        };
      }

      // Prevent searching with full query - should only be a name
      if (state.searchQuery.length > 50) {
        console.error("[CONTACT:SEARCH] Search query too long, likely full sentence instead of name");
        return {
          ...state,
          error: "Could not extract a valid contact name from the query",
          candidates: []
        };
      }

      // Validate config exists
      if (!config?.configurable) {
        console.error("[CONTACT:SEARCH] Missing config or configurable");
        return {
          ...state,
          error: "Authentication configuration missing",
          candidates: []
        };
      }

      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;

      // Validate required fields
      if (!passKey) {
        console.error("[CONTACT:SEARCH] No valid PassKey available");
        return {
          ...state,
          error: "Authentication failed - no valid PassKey",
          candidates: []
        };
      }

      if (!orgId) {
        console.error("[CONTACT:SEARCH] No organization ID available");
        return {
          ...state,
          error: "Organization ID missing",
          candidates: []
        };
      }

      console.log(`[CONTACT:SEARCH] Searching for: "${state.searchQuery}"`);

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
   * Resolve contact from entities, cache, or search
   */
  async resolveContact(state) {
    console.log("[CONTACT:RESOLVE] Resolving contact for info query");
    this.metrics.startTimer("contact_resolve");

    try {
      const contactName = state.searchQuery;

      // Step 1: Check if contact is in entities (from previous query in session)
      if (state.entities) {
        // Look for last_contact if no name specified (pronoun reference)
        if (!contactName || contactName === state.query) {
          if (state.entities.last_contact) {
            console.log("[CONTACT:RESOLVE] Using last_contact from entities");
            this.metrics.endTimer("contact_resolve", true, { source: "entity_last" });
            return {
              ...state,
              selectedContact: {
                id: state.entities.last_contact.data.id,
                name: state.entities.last_contact.data.name,
                ...state.entities.last_contact.data
              }
            };
          }
        }

        // Search entities by name
        for (const [key, entity] of Object.entries(state.entities)) {
          if (entity.type === 'contact' && entity.name) {
            const entityNameLower = entity.name.toLowerCase();
            const searchLower = contactName?.toLowerCase() || '';
            if (entityNameLower.includes(searchLower) || searchLower.includes(entityNameLower)) {
              console.log(`[CONTACT:RESOLVE] Found contact in entities: ${entity.name}`);
              this.metrics.endTimer("contact_resolve", true, { source: "entity_match" });
              return {
                ...state,
                selectedContact: {
                  id: entity.data.id,
                  name: entity.data.name,
                  ...entity.data
                }
              };
            }
          }
        }
      }

      // Step 2: Check session cache
      const cacheKey = this.normalizeCacheKey(contactName);
      const cached = state.sessionCache?.[cacheKey];
      if (cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
        console.log(`[CONTACT:RESOLVE] Found contact in cache: ${cached.contact.name}`);
        this.metrics.endTimer("contact_resolve", true, { source: "cache" });
        return {
          ...state,
          selectedContact: cached.contact
        };
      }

      // Step 3: Search BSA - delegate to existing search flow
      console.log("[CONTACT:RESOLVE] Contact not in entities/cache, searching BSA");
      this.metrics.endTimer("contact_resolve", true, { source: "bsa_search_needed" });

      // Trigger search by going through normal flow
      return {
        ...state,
        selectedContact: null,
        // The graph will need to route through search if no contact found
        error: null
      };

    } catch (error) {
      console.error("[CONTACT:RESOLVE] Error resolving contact:", error);
      this.metrics.endTimer("contact_resolve", false, { error: error.message });
      return {
        ...state,
        error: `Failed to resolve contact: ${error.message}`
      };
    }
  }

  /**
   * Fetch full contact details with extended properties
   */
  async fetchContactDetails(state, config) {
    console.log("[CONTACT:FETCH] Fetching full contact details with extended properties");
    this.metrics.startTimer("contact_fetch_details");

    try {
      // Validate we have a selected contact
      if (!state.selectedContact || !state.selectedContact.id) {
        console.error("[CONTACT:FETCH] No selected contact to fetch details for");
        return {
          ...state,
          error: "No contact selected for fetching details"
        };
      }

      // Check if we already have extended properties in the contact
      if (state.selectedContact._raw && state.selectedContact._hasExtendedProps) {
        console.log("[CONTACT:FETCH] Contact already has extended properties, skipping fetch");
        this.metrics.endTimer("contact_fetch_details", true, { cached: true });
        return {
          ...state,
          contactDetails: state.selectedContact
        };
      }

      // Validate config
      if (!config?.configurable) {
        console.error("[CONTACT:FETCH] Missing config or configurable");
        return {
          ...state,
          error: "Authentication configuration missing"
        };
      }

      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      const contactId = state.selectedContact.id;

      if (!passKey || !orgId) {
        console.error("[CONTACT:FETCH] Missing PassKey or OrgId");
        return {
          ...state,
          error: "Missing authentication credentials"
        };
      }

      console.log(`[CONTACT:FETCH] Fetching details for contact ${contactId}`);

      // Import getContactDetails
      const { getContactDetails } = require('../../../integrations/bsa/tools/contacts');

      // Fetch with extended properties
      const fullContact = await this.errorHandler.executeWithRetry(
        async () => await getContactDetails(
          contactId,
          passKey,
          orgId,
          true  // IncludeExtendedProperties = true
        ),
        {
          operation: "contact_fetch_details",
          maxRetries: 2,
          circuitBreakerKey: "bsa_contacts"
        }
      );

      console.log("[CONTACT:FETCH] Successfully fetched contact details");
      this.metrics.endTimer("contact_fetch_details", true, { hasExtended: !!fullContact._raw });

      return {
        ...state,
        contactDetails: fullContact
      };

    } catch (error) {
      console.error("[CONTACT:FETCH] Error fetching contact details:", error);
      this.metrics.endTimer("contact_fetch_details", false, { error: error.message });
      return {
        ...state,
        error: `Failed to fetch contact details: ${error.message}`
      };
    }
  }

  /**
   * Extract requested field from contact (supports custom fields)
   */
  async extractField(state) {
    console.log("[CONTACT:EXTRACT_FIELD] Extracting requested field");
    this.metrics.startTimer("contact_extract_field");

    try {
      const query = state.query || (state.messages?.[state.messages.length - 1]?.content);
      const requestedField = state.requestedField;
      const contact = state.contactDetails;

      if (!contact) {
        return {
          ...state,
          error: "No contact details available for field extraction"
        };
      }

      // Build list of standard fields
      const standardFields = {
        birthDate: contact.birthDate,
        birthday: contact.birthDate,
        anniversary: contact.anniversary,
        email: contact.email,
        'email address': contact.email,
        phone: contact.phone,
        'phone number': contact.phone,
        mobile: contact.mobile,
        'mobile phone': contact.mobile,
        fax: contact.fax,
        company: contact.company,
        title: contact.title,
        'job title': contact.title,
        department: contact.department,
        address: contact.address,
        city: contact.city,
        state: contact.state,
        'postal code': contact.postalCode,
        'zip code': contact.postalCode,
        country: contact.country,
        notes: contact.notes,
        maritalStatus: contact.maritalStatus,
        'marital status': contact.maritalStatus,
        nickName: contact.nickName,
        nickname: contact.nickName,
        clientSince: contact.clientSince,
        'client since': contact.clientSince
      };

      // Extract custom fields from CustomProps
      const customFields = {};
      if (contact._raw?.CustomProps?.props) {
        contact._raw.CustomProps.props.forEach(prop => {
          if (prop.name) {
            customFields[prop.name] = prop.value;
            // Also add with spaces replaced by underscores
            customFields[prop.name.replace(/_/g, ' ')] = prop.value;
          }
        });
      }

      // Use LLM to match query to field
      const prompt = `
        User query: "${query}"
        Hint about requested field: "${requestedField || 'unknown'}"
        Contact name: "${contact.name}"

        Available standard fields:
        ${JSON.stringify(standardFields, null, 2)}

        Available custom fields:
        ${JSON.stringify(customFields, null, 2)}

        Which field is the user asking about?
        Return ONLY JSON (no markdown):
        {
          "fieldType": "standard|custom|unknown",
          "fieldName": "exact_field_name",
          "value": <the actual value from the fields above>
        }

        If the field doesn't exist or is null, return:
        {
          "fieldType": "unknown",
          "fieldName": "${requestedField || 'unknown'}",
          "value": null
        }
      `;

      const response = await this.llm.invoke(prompt);
      let content = response.content;

      // Strip markdown formatting
      if (content.includes('```json')) {
        content = content.split('```json')[1].split('```')[0].trim();
      } else if (content.includes('```')) {
        content = content.split('```')[1].split('```')[0].trim();
      }

      const extraction = JSON.parse(content);

      console.log("[CONTACT:EXTRACT_FIELD] Extraction result:", {
        fieldType: extraction.fieldType,
        fieldName: extraction.fieldName,
        hasValue: extraction.value !== null && extraction.value !== undefined
      });

      this.metrics.endTimer("contact_extract_field", true, {
        fieldType: extraction.fieldType,
        fieldFound: extraction.value !== null
      });

      return {
        ...state,
        isCustomField: extraction.fieldType === 'custom',
        requestedField: extraction.fieldName,
        fieldValue: extraction.value
      };

    } catch (error) {
      console.error("[CONTACT:EXTRACT_FIELD] Error extracting field:", error);
      this.metrics.endTimer("contact_extract_field", false, { error: error.message });
      return {
        ...state,
        error: `Failed to extract field: ${error.message}`
      };
    }
  }

  /**
   * Generate natural language answer for the field query
   */
  async answerQuery(state) {
    console.log("[CONTACT:ANSWER] Generating answer for field query");
    this.metrics.startTimer("contact_answer");

    try {
      const contact = state.selectedContact || state.contactDetails;
      const fieldName = state.requestedField;
      const fieldValue = state.fieldValue;
      const isCustomField = state.isCustomField;

      if (!contact) {
        return {
          ...state,
          response: "Could not find contact information"
        };
      }

      // Handle null/missing fields
      if (fieldValue === null || fieldValue === undefined || fieldValue === '') {
        const friendlyFieldName = fieldName || 'that information';
        this.metrics.endTimer("contact_answer", true, { hasValue: false });
        return {
          ...state,
          response: `${contact.name}'s ${friendlyFieldName} is not recorded in the system.`
        };
      }

      // Format based on field type
      let formattedResponse;
      const { formatHumanReadableDate, formatCustomFieldValue, getFriendlyFieldName } = require('../../../utils/contactFieldFormatter');

      // Date fields
      if (fieldName === 'birthDate' || fieldName === 'birthday') {
        const formattedDate = formatHumanReadableDate(fieldValue);
        formattedResponse = `${contact.name}'s birthday is ${formattedDate}.`;
      }
      else if (fieldName === 'anniversary') {
        const formattedDate = formatHumanReadableDate(fieldValue);
        formattedResponse = `${contact.name}'s anniversary is ${formattedDate}.`;
      }
      // Contact info fields
      else if (fieldName === 'email' || fieldName === 'email address') {
        formattedResponse = `${contact.name}'s email is ${fieldValue}.`;
      }
      else if (fieldName === 'phone' || fieldName === 'phone number') {
        formattedResponse = `${contact.name}'s phone number is ${fieldValue}.`;
      }
      else if (fieldName === 'mobile' || fieldName === 'mobile phone') {
        formattedResponse = `${contact.name}'s mobile phone is ${fieldValue}.`;
      }
      // Address fields
      else if (fieldName === 'address') {
        formattedResponse = `${contact.name}'s address is ${fieldValue}.`;
      }
      else if (fieldName === 'city') {
        formattedResponse = `${contact.name} is located in ${fieldValue}.`;
      }
      // Custom fields
      else if (isCustomField) {
        const formattedValue = formatCustomFieldValue(fieldValue);
        const friendlyName = getFriendlyFieldName(fieldName);
        formattedResponse = `${contact.name}'s ${friendlyName}: ${formattedValue}`;
      }
      // Generic formatting for other standard fields
      else {
        const friendlyName = getFriendlyFieldName(fieldName);
        formattedResponse = `${contact.name}'s ${friendlyName}: ${fieldValue}`;
      }

      console.log("[CONTACT:ANSWER] Generated answer");
      this.metrics.endTimer("contact_answer", true, { hasValue: true });

      return {
        ...state,
        response: formattedResponse
      };

    } catch (error) {
      console.error("[CONTACT:ANSWER] Error generating answer:", error);
      this.metrics.endTimer("contact_answer", false, { error: error.message });

      // Fallback to simple response
      const contact = state.selectedContact || state.contactDetails;
      const fieldValue = state.fieldValue;
      return {
        ...state,
        response: `${contact?.name}: ${fieldValue}`
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
      // Use contactDetails if available (from info query), otherwise selectedContact
      const contact = state.contactDetails || state.selectedContact;
      const hasExtendedProps = !!state.contactDetails;

      // Create entity with multiple references and FULL contact data
      const entity = {
        id: `contact_${contact.id}`,
        type: "contact",
        name: contact.name,
        data: {
          // Basic info
          id: contact.id,
          name: contact.name,
          firstName: contact.firstName,
          lastName: contact.lastName,

          // Contact info
          email: contact.email,
          phone: contact.phone,
          mobile: contact.mobile,
          fax: contact.fax,

          // Professional info
          company: contact.company,
          title: contact.title,
          department: contact.department,

          // Address
          address: contact.address,
          city: contact.city,
          state: contact.state,
          postalCode: contact.postalCode,
          country: contact.country,

          // Personal info
          birthDate: contact.birthDate,
          anniversary: contact.anniversary,
          maritalStatus: contact.maritalStatus,
          nickName: contact.nickName,
          clientSince: contact.clientSince,

          // Additional info
          notes: contact.notes,
          lastModified: contact.lastModified,
          createdDate: contact.createdDate,
          ownerId: contact.ownerId,

          // Raw BSA response (includes CustomProps for custom fields)
          _raw: contact._raw || null,
          _hasExtendedProps: hasExtendedProps,
          _fetchedAt: Date.now()
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
/**
 * Factory function to create contact subgraph
 * @param {Object} checkpointer - The checkpointer (propagated from parent)
 */
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

// Export graph for LangGraph Studio (async initialization)
module.exports.graph = (async () => {
  const { getCheckpointer } = require('../../../core/state');
  const checkpointer = await getCheckpointer();
  const subgraph = new ContactSubgraph(checkpointer);
  return subgraph.graph;
})();