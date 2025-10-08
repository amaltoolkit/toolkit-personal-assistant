/**
 * LLM-Based Planner for Intelligent Domain Routing
 * Replaces keyword-based planner with context-aware routing
 */

const { ChatOpenAI } = require("@langchain/openai");

class LLMPlanner {
  constructor() {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0,
      timeout: 10000  // 10 second timeout for better reliability
    });

    // Cache for common queries
    this.cache = new Map();
    this.cacheMaxSize = 100;
  }

  /**
   * Clean JSON response from LLM by removing markdown code blocks
   */
  cleanJsonResponse(content) {
    if (!content) return '';

    // Remove markdown code blocks
    let cleaned = content.trim();

    // Remove ```json or ``` from the start
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.substring(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.substring(3);
    }

    // Remove ``` from the end
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }

    // Final trim to remove any whitespace
    return cleaned.trim();
  }

  async createExecutionPlan(query, memoryContext = null, entityStats = null, recentMessages = []) {
    console.log("[LLM-PLANNER:MAIN] Creating execution plan for query:", query);

    // Check cache first (include entity stats in cache key for context-aware caching)
    const cacheKey = `${query.toLowerCase().trim()}_${JSON.stringify(entityStats?.byType || {})}`;
    if (this.cache.has(cacheKey)) {
      console.log("[LLM-PLANNER:CACHE] Cache hit");
      return this.cache.get(cacheKey);
    }

    try {
      const prompt = `
        You are a routing assistant for a business automation system.

        Available domains and their purposes:
        - calendar: Creating appointments, meetings, scheduling events with specific times/dates [ACTION]
        - task: Creating/managing tasks, todos, action items, reminders [ACTION]
        - workflow: Creating multi-step processes, automation sequences, business workflows, procedures [ACTION]
        - contact: ALL contact operations - search, information queries, updates [ACTION + READ]
        - general: Answering questions, viewing/reading existing entities, conversations, greetings, system queries [INFORMATIONAL]

        ${entityStats && entityStats.totalEntities > 0 ? `
        Current session state (entities created so far):
        - Workflows: ${entityStats.byType?.workflow || 0} created
        - Appointments: ${entityStats.byType?.appointment || 0} created
        - Tasks: ${entityStats.byType?.task || 0} created

        IMPORTANT: If user asks about entities that don't exist yet (count = 0), route to general for helpful response.
        ` : `
        Current session state: No entities created yet in this session.
        `}

        ${recentMessages && recentMessages.length > 0 ? `
        Recent conversation (for context):
        ${recentMessages.slice(-6).map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant';
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return `${role}: ${content.substring(0, 150)}${content.length > 150 ? '...' : ''}`;
        }).join('\n')}

        Use this conversation history to resolve pronouns ("it", "that", "the workflow") and implicit references.
        ` : ''}

        ${memoryContext?.recalled_memories?.length > 0 ? `
        Long-term memory context:
        ${memoryContext.recalled_memories.map(m => m.content).join('\n')}
        ` : ''}

        User query to route:
        "${query}"

        CRITICAL ROUTING RULES:
        1. ACTION DOMAINS (calendar, task, workflow, contact):
           - Use when creating, modifying, or deleting BSA entities
           - Use contact for BOTH searching AND asking about contact information
           - Generic terms like "client", "customer", "prospect" in process contexts = workflow only (NOT contact)

        2. CONTACT DOMAIN (search + read):
           - Searching for specific people by name ("Find Norman", "Who is Sarah")
           - Asking about contact information ("When is Norman's birthday?", "What's his email?")
           - Asking about custom contact fields ("What's Norman's coffee preference?")
           - INCLUDE pronoun references if context is about a contact ("What's his email?" after finding Norman)

        3. GENERAL DOMAIN (informational, read-only):
           - Questions about existing entities ("What was step 2?", "Show all workflows")
           - Greetings/farewells ("Hey, what's up?", "Thanks, bye")
           - System state queries ("How many workflows did I create?")
           - Acknowledgments ("ok", "got it", "yes")
           - List operations ("Show all contacts", "How many contacts do I have")

        4. ROUTING EXAMPLES:
           - "Create a client outreach process" = workflow only (NOT contact, NOT general)
           - "What was the second step?" = general only (NOT workflow)
           - "Show all my workflows" = general only (NOT workflow)
           - "Find contact John Smith" = contact only
           - "When is Norman's birthday?" = contact only
           - "What's his email?" = contact only (if context available)
           - "What's Norman's coffee preference?" = contact only
           - "Show all contacts" = general only (list operation)
           - "Schedule meeting with Sarah" = calendar + contact (sequential)
           - "Hey, what's up?" = general only
           - "Create appointment then add task" = calendar, task (sequential)

        4. DEFAULT BEHAVIOR:
           - If query is purely conversational/informational → general
           - If uncertain → default to general
           - Prefer single domain unless multiple explicitly needed
        5. Consider dependencies (e.g., task after calendar event needs sequential execution)

        Extract any person names (capitalized names), dates, times mentioned.

        Return JSON only, no other text:
        {
          "parallel": ["domain1"],
          "sequential": [],
          "confidence": "high|medium|low",
          "metadata": {
            "total_domains": 1,
            "has_dependencies": false,
            "entities_found": 0,
            "requires_entity_resolution": false
          },
          "analysis": {
            "domains": ["domain1"],
            "intent": "create|read|converse",
            "entities_referenced": ["workflow", "appointment"],
            "requires_context": false,
            "entities": [],
            "dependencies": [],
            "reasoning": "Step-by-step: 1. Detected intent X, 2. User has Y entities in session, 3. Therefore route to Z domain"
          }
        }
      `;

      const response = await this.llm.invoke(prompt);
      console.log("[LLM-PLANNER:DEBUG] Raw LLM response:", response.content);

      const cleanedContent = this.cleanJsonResponse(response.content);
      console.log("[LLM-PLANNER:DEBUG] Cleaned content:", cleanedContent);

      const plan = JSON.parse(cleanedContent);
      console.log("[LLM-PLANNER:DEBUG] Parsed plan:", JSON.stringify(plan, null, 2));

      // Ensure the structure is complete
      plan.parallel = plan.parallel || [];
      plan.sequential = plan.sequential || [];
      plan.confidence = plan.confidence || 'medium';
      plan.metadata = plan.metadata || {
        total_domains: 0,
        has_dependencies: false,
        entities_found: 0
      };
      plan.analysis = plan.analysis || {
        domains: [],
        intent: 'unknown',
        entities_referenced: [],
        requires_context: false,
        entities: [],
        dependencies: [],
        reasoning: ''
      };

      // Validate that we have at least one domain
      if (plan.parallel.length === 0 && plan.sequential.length === 0) {
        console.log("[LLM-PLANNER:VALIDATION] No domains in plan, defaulting to general agent");
        plan.parallel = ['general'];
        plan.metadata = {
          total_domains: 1,
          has_dependencies: false,
          entities_found: 0,
          default_to_general: true
        };
        plan.analysis = {
          domains: ['general'],
          entities: [],
          dependencies: [],
          reasoning: "No specific action domains matched - defaulting to general conversational agent"
        };
      }

      console.log("[LLM-PLANNER:MAIN] Analysis complete:", {
        domains: plan.analysis.domains,
        intent: plan.analysis.intent,
        confidence: plan.confidence,
        entities_referenced: plan.analysis.entities_referenced,
        entities: plan.analysis.entities?.length || 0,
        dependencies: plan.analysis.dependencies?.length || 0,
        reasoning: plan.analysis.reasoning
      });

      // Cache the result
      this.addToCache(cacheKey, plan);

      return plan;

    } catch (error) {
      console.error("[LLM-PLANNER:ERROR] Failed to create plan:", error.message);
      // Fallback to simple keyword-based routing
      return this.fallbackPlan(query);
    }
  }

  fallbackPlan(query) {
    console.log("[LLM-PLANNER:FALLBACK] Using fallback keyword routing for:", query);
    const domains = [];

    // Check for action keywords first - but exclude questions
    const isQuestion = /^(what|how many|show|list|who|when|where|which|tell me)/i.test(query);
    const isCreationQuery = !isQuestion && /create|build|make|design|implement|add|schedule|book|find|search/i.test(query);

    // Action domain matching (only for creation/modification queries)
    if (isCreationQuery) {
      if (/workflow|process|procedure|automation|sequence|steps/i.test(query)) {
        console.log("[LLM-PLANNER:FALLBACK] Matched workflow keywords");
        domains.push('workflow');
      }
      if (/calendar|appointment|meeting|schedule|book/i.test(query)) {
        console.log("[LLM-PLANNER:FALLBACK] Matched calendar keywords");
        domains.push('calendar');
      }
      if (/task|todo|to-do|reminder|action item/i.test(query)) {
        console.log("[LLM-PLANNER:FALLBACK] Matched task keywords");
        domains.push('task');
      }
      // Conservative contact matching - explicit searches
      if (/(?:find|search|look up|lookup|get|search for)\s+(?:contact|person)/i.test(query)) {
        console.log("[LLM-PLANNER:FALLBACK] Matched contact keywords");
        domains.push('contact');
      }
    }

    // Contact info queries (questions about contact fields)
    if (isQuestion) {
      // Check for contact-related questions (birthday, email, phone, etc.)
      const contactInfoPattern = /(?:birthday|email|phone|address|city|anniversary|company|job|title|mobile|when is|what'?s)\s+.+\s+(?:birthday|email|phone|address|city)/i;
      const pronounPattern = /(?:his|her|their)\s+(?:birthday|email|phone|address|city|anniversary|company|job|title|mobile)/i;

      if (contactInfoPattern.test(query) || pronounPattern.test(query)) {
        console.log("[LLM-PLANNER:FALLBACK] Matched contact info query keywords");
        domains.push('contact');
      }
    }

    // If no action domains matched, default to general
    if (domains.length === 0) {
      console.log("[LLM-PLANNER:FALLBACK] No action keywords matched, defaulting to general agent");
      domains.push('general');
    }

    console.log("[LLM-PLANNER:FALLBACK] Final domains:", domains);

    return {
      parallel: domains,
      sequential: [],
      metadata: {
        total_domains: domains.length,
        has_dependencies: false,
        entities_found: 0,
        fallback_used: true
      },
      analysis: {
        domains: domains,
        entities: [],
        dependencies: [],
        reasoning: "Fallback keyword-based routing (LLM unavailable)"
      }
    };
  }

  addToCache(key, value) {
    if (this.cache.size >= this.cacheMaxSize) {
      // Remove oldest entry (FIFO)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

// Create singleton instance
const plannerInstance = new LLMPlanner();

/**
 * Main planning function - matches existing interface
 */
async function createExecutionPlan(query, memoryContext = null) {
  return await plannerInstance.createExecutionPlan(query, memoryContext);
}

/**
 * Validate an execution plan - matches existing interface
 */
function validateExecutionPlan(plan) {
  const errors = [];
  const warnings = [];

  // Check structure - ensure at least one domain exists
  if ((!plan.parallel || plan.parallel.length === 0) &&
      (!plan.sequential || plan.sequential.length === 0)) {
    errors.push("Plan must have either parallel or sequential domains");
  }

  // Check for circular dependencies
  if (plan.sequential?.length > 0) {
    const visited = new Set();
    const recursionStack = new Set();

    function hasCycle(domain, deps) {
      if (recursionStack.has(domain)) {
        return true;
      }
      if (visited.has(domain)) {
        return false;
      }

      visited.add(domain);
      recursionStack.add(domain);

      for (const dep of deps[domain] || []) {
        if (hasCycle(dep, deps)) {
          return true;
        }
      }

      recursionStack.delete(domain);
      return false;
    }

    const depMap = {};
    for (const step of plan.sequential) {
      depMap[step.domain] = step.depends_on || [];
    }

    for (const step of plan.sequential) {
      if (hasCycle(step.domain, depMap)) {
        errors.push(`Circular dependency detected involving ${step.domain}`);
      }
    }
  }

  // Check for unknown domains
  const validDomains = ['calendar', 'task', 'workflow', 'contact', 'general'];
  const allDomains = [
    ...plan.parallel || [],
    ...(plan.sequential?.map(s => s.domain) || [])
  ];

  for (const domain of allDomains) {
    if (!validDomains.includes(domain)) {
      warnings.push(`Unknown domain: ${domain}`);
    }
  }

  // Check for missing entity resolution
  if (plan.metadata?.requires_entity_resolution &&
      !allDomains.includes('contact')) {
    warnings.push('Entity resolution required but contact domain not included');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// Export matching the existing planner interface
module.exports = {
  createExecutionPlan,
  validateExecutionPlan,
  LLMPlanner
};