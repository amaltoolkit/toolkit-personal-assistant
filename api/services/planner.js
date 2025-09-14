/**
 * Lightweight Planner for V2 Architecture
 *
 * Analyzes user queries to determine:
 * 1. Which domains are involved
 * 2. Dependencies between domains
 * 3. Execution order (parallel vs sequential)
 * 4. Entity resolution requirements
 */

const dayjs = require('dayjs');

/**
 * Domain dependency rules
 * Maps patterns in queries to required domain sequences
 */
const DEPENDENCY_RULES = {
  // Contact resolution must happen before calendar operations if names are mentioned
  contactBeforeCalendar: {
    pattern: /(?:with|meet|call|schedule.*(?:with)?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    requires: ['contact', 'calendar'],
    order: 'sequential',
    reason: 'Need to resolve contact before creating appointment'
  },

  // Task creation from calendar events
  taskFromCalendar: {
    pattern: /(?:create|add|make).*task.*(?:for|from|after).*(?:meeting|appointment|event)/i,
    requires: ['calendar', 'task'],
    order: 'sequential',
    reason: 'Need calendar event details to create related task'
  },

  // Workflow that involves multiple domains
  workflowMultiDomain: {
    pattern: /workflow.*(?:meetings?|tasks?|contacts?)/i,
    requires: ['workflow'],
    order: 'parallel',
    reason: 'Workflow can coordinate other domains internally'
  }
};

/**
 * Entity extraction patterns
 */
const ENTITY_PATTERNS = {
  person: {
    pattern: /(?:with|meet|call|email|contact)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
    type: 'contact'
  },
  time: {
    pattern: /(?:at|by|before|after|around)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))/g,
    type: 'temporal'
  },
  date: {
    pattern: /(?:tomorrow|today|yesterday|next\s+\w+|this\s+\w+|\d{1,2}\/\d{1,2})/gi,
    type: 'temporal'
  },
  duration: {
    pattern: /(?:for\s+)?(\d+)\s*(?:hours?|mins?|minutes?)/gi,
    type: 'temporal'
  }
};

/**
 * Analyze query to determine domains and dependencies
 */
function analyzeQuery(query, memoryContext = null) {
  const analysis = {
    query,
    domains: new Set(),
    entities: [],
    dependencies: [],
    executionPlan: null
  };

  // Extract entities first
  for (const [entityType, config] of Object.entries(ENTITY_PATTERNS)) {
    const matches = query.matchAll(config.pattern);
    for (const match of matches) {
      analysis.entities.push({
        type: entityType,
        value: match[1] || match[0],
        category: config.type,
        position: match.index
      });
    }
  }

  // Check for calendar indicators
  if (/(?:calendar|schedule|appointment|meeting|event)/i.test(query) ||
      /(?:create|book|set up|arrange).*(?:at|on|for)\s+\d/i.test(query)) {
    analysis.domains.add('calendar');
  }

  // Check for task indicators
  if (/(?:task|todo|to-do|reminder|action item)/i.test(query)) {
    analysis.domains.add('task');
  }

  // Check for workflow indicators
  if (/(?:workflow|process|automation|sequence)/i.test(query)) {
    analysis.domains.add('workflow');
  }

  // Check for contact indicators
  const hasPersonEntity = analysis.entities.some(e => e.type === 'person');
  if (hasPersonEntity || /(?:contact|person|client|prospect)/i.test(query)) {
    analysis.domains.add('contact');
  }

  // Apply dependency rules
  for (const [ruleName, rule] of Object.entries(DEPENDENCY_RULES)) {
    if (rule.pattern.test(query)) {
      console.log(`[PLANNER:ANALYZER] Matched rule: ${ruleName}`);

      // Add required domains
      rule.requires.forEach(domain => analysis.domains.add(domain));

      // Add dependency relationship
      if (rule.order === 'sequential' && rule.requires.length > 1) {
        for (let i = 1; i < rule.requires.length; i++) {
          analysis.dependencies.push({
            domain: rule.requires[i],
            depends_on: rule.requires[i - 1],
            reason: rule.reason
          });
        }
      }
    }
  }

  // Check memory context for additional hints
  if (memoryContext?.recalled_memories) {
    const memories = memoryContext.recalled_memories;
    for (const memory of memories) {
      // Look for domain hints in memory
      if (memory.content?.includes('calendar') || memory.content?.includes('appointment')) {
        analysis.domains.add('calendar');
      }
      if (memory.content?.includes('task') || memory.content?.includes('todo')) {
        analysis.domains.add('task');
      }
    }
  }

  return analysis;
}

/**
 * Build execution plan from analysis
 */
function buildExecutionPlan(analysis) {
  const plan = {
    parallel: [],
    sequential: [],
    metadata: {
      total_domains: analysis.domains.size,
      has_dependencies: analysis.dependencies.length > 0,
      entities_found: analysis.entities.length
    }
  };

  if (analysis.dependencies.length === 0) {
    // No dependencies, all domains can run in parallel
    plan.parallel = Array.from(analysis.domains);
    console.log("[PLANNER:BUILDER] No dependencies, running domains in parallel:", plan.parallel);
  } else {
    // Build dependency graph
    const graph = new Map();
    const inDegree = new Map();

    // Initialize all domains
    for (const domain of analysis.domains) {
      graph.set(domain, []);
      inDegree.set(domain, 0);
    }

    // Build edges from dependencies
    for (const dep of analysis.dependencies) {
      if (!graph.has(dep.depends_on)) {
        graph.set(dep.depends_on, []);
        inDegree.set(dep.depends_on, 0);
      }
      graph.get(dep.depends_on).push(dep.domain);
      inDegree.set(dep.domain, (inDegree.get(dep.domain) || 0) + 1);
    }

    // Topological sort for execution order
    const queue = [];
    const executionOrder = [];

    // Find nodes with no dependencies
    for (const [domain, degree] of inDegree) {
      if (degree === 0) {
        queue.push(domain);
      }
    }

    // Process queue
    while (queue.length > 0) {
      // All nodes in current queue can run in parallel
      const parallelBatch = [...queue];
      queue.length = 0;

      if (parallelBatch.length > 1) {
        // Multiple domains with no deps can run in parallel
        plan.parallel.push(...parallelBatch);
      } else {
        // Single domain or dependent domains run sequentially
        for (const domain of parallelBatch) {
          const depends = [];
          // Find what this domain depends on
          for (const dep of analysis.dependencies) {
            if (dep.domain === domain) {
              depends.push(dep.depends_on);
            }
          }

          plan.sequential.push({
            domain,
            depends_on: depends,
            reason: analysis.dependencies.find(d => d.domain === domain)?.reason
          });
        }
      }

      // Update graph
      for (const domain of parallelBatch) {
        executionOrder.push(domain);
        const neighbors = graph.get(domain) || [];
        for (const neighbor of neighbors) {
          inDegree.set(neighbor, inDegree.get(neighbor) - 1);
          if (inDegree.get(neighbor) === 0) {
            queue.push(neighbor);
          }
        }
      }
    }

    console.log("[PLANNER:BUILDER] Built execution plan with dependencies");
    console.log("[PLANNER:BUILDER] Sequential steps:", plan.sequential);
  }

  // Add entity resolution requirements
  if (analysis.entities.some(e => e.category === 'contact')) {
    plan.metadata.requires_entity_resolution = true;
    plan.metadata.entity_types = ['contact'];
  }

  return plan;
}

/**
 * Main planning function
 */
function createExecutionPlan(query, memoryContext = null) {
  console.log("[PLANNER:MAIN] Creating execution plan for query:", query);

  // Analyze the query
  const analysis = analyzeQuery(query, memoryContext);
  console.log("[PLANNER:MAIN] Analysis complete:", {
    domains: Array.from(analysis.domains),
    entities: analysis.entities.length,
    dependencies: analysis.dependencies.length
  });

  // Build execution plan
  const plan = buildExecutionPlan(analysis);

  // Add analysis details to plan
  plan.analysis = {
    domains: Array.from(analysis.domains),
    entities: analysis.entities,
    dependencies: analysis.dependencies
  };

  return plan;
}

/**
 * Validate an execution plan
 */
function validateExecutionPlan(plan) {
  const errors = [];
  const warnings = [];

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

module.exports = {
  analyzeQuery,
  buildExecutionPlan,
  createExecutionPlan,
  validateExecutionPlan,
  DEPENDENCY_RULES,
  ENTITY_PATTERNS
};