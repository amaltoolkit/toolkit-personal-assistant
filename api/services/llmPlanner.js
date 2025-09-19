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

  async createExecutionPlan(query, memoryContext = null) {
    console.log("[LLM-PLANNER:MAIN] Creating execution plan for query:", query);

    // Check cache first
    const cacheKey = query.toLowerCase().trim();
    if (this.cache.has(cacheKey)) {
      console.log("[LLM-PLANNER:CACHE] Cache hit");
      return this.cache.get(cacheKey);
    }

    try {
      const prompt = `
        You are a routing assistant for a business automation system.

        Available domains and their purposes:
        - calendar: Creating/viewing appointments, meetings, scheduling events with specific times/dates
        - task: Creating/managing tasks, todos, action items, reminders
        - workflow: Creating multi-step processes, automation sequences, business workflows, procedures
        - contact: Finding/searching for SPECIFIC people by name in the contact database

        Analyze this query and determine which domain(s) to route to:
        "${query}"

        ${memoryContext?.recalled_memories?.length > 0 ? `
        Previous context from memory:
        ${memoryContext.recalled_memories.map(m => m.content).join('\n')}
        ` : ''}

        CRITICAL RULES:
        1. Only route to 'contact' if searching for a SPECIFIC person by name (e.g., "find John Smith", "look up Sarah")
        2. Generic terms like "client", "customer", "prospect" in workflow/process contexts should NOT trigger contact
        3. Examples:
           - "Create a client outreach process" = workflow only (NOT contact)
           - "Create a two-step process for client onboarding" = workflow only (NOT contact)
           - "Find client John" = contact only
           - "Schedule meeting with Sarah" = calendar + contact
        4. Prefer single domain unless multiple are explicitly needed
        5. Consider dependencies (e.g., task after calendar event needs sequential execution)

        Extract any person names (capitalized names), dates, times mentioned.

        Return JSON only, no other text:
        {
          "parallel": ["domain1"],
          "sequential": [],
          "metadata": {
            "total_domains": 1,
            "has_dependencies": false,
            "entities_found": 0,
            "requires_entity_resolution": false
          },
          "analysis": {
            "domains": ["domain1"],
            "entities": [],
            "dependencies": [],
            "reasoning": "Brief explanation of routing decision"
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
      plan.metadata = plan.metadata || {
        total_domains: 0,
        has_dependencies: false,
        entities_found: 0
      };
      plan.analysis = plan.analysis || {
        domains: [],
        entities: [],
        dependencies: []
      };

      // Validate that we have at least one domain
      if (plan.parallel.length === 0 && plan.sequential.length === 0) {
        console.log("[LLM-PLANNER:VALIDATION] No domains in plan, using fallback");
        return this.fallbackPlan(query);
      }

      console.log("[LLM-PLANNER:MAIN] Analysis complete:", {
        domains: plan.analysis.domains,
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

    // More conservative keyword matching
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
    // Very conservative contact matching - only explicit searches
    if (/(?:find|search|look up|lookup|get)\s+(?:contact|person).*(?:named|called)/i.test(query) ||
        /(?:find|search for|look up)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/i.test(query)) {
      console.log("[LLM-PLANNER:FALLBACK] Matched contact keywords");
      domains.push('contact');
    }

    // If no domains matched, default to workflow for process-related queries
    if (domains.length === 0) {
      console.log("[LLM-PLANNER:FALLBACK] No keywords matched, checking for generic process indicators");
      if (/create|build|make|design|implement/i.test(query)) {
        console.log("[LLM-PLANNER:FALLBACK] Defaulting to workflow for creation query");
        domains.push('workflow');
      }
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
  const validDomains = ['calendar', 'task', 'workflow', 'contact'];
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