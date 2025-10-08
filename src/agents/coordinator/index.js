/**
 * Coordinator - Lightweight Orchestrator for V2 Architecture
 * 
 * Replaces the complex monolithic orchestrator with a streamlined coordinator
 * that routes queries to specialized domain subgraphs.
 */

const { StateGraph, END, interrupt } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { getMem0Service } = require("../../services/memory/mem0Service");
const { getPassKeyManager } = require("../../core/auth/passkey");
const { getErrorHandler } = require("../../services/errors/errorHandler");
const { getPerformanceMetrics } = require("./metrics");
const { createExecutionPlan, validateExecutionPlan } = require("../../services/planning/llmPlanner");
const { getEntityManager } = require("../../services/entities/entityManager");

const langSmithEnabled = process.env.LANGCHAIN_TRACING_V2 === 'true' && !!process.env.LANGCHAIN_API_KEY;
if (langSmithEnabled) {
  console.log('[COORDINATOR:TRACING] LangSmith tracing enabled for V2 architecture:', process.env.LANGCHAIN_PROJECT || 'default');
}

// State definition for the coordinator
// Using plain object definition for LangGraph compatibility
const CoordinatorStateChannels = {
  messages: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  memory_context: {
    value: (x, y) => y ? y : x,
    default: () => ({})
  },
  domains: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  execution_plan: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  subgraph_results: {
    // Allow explicit clearing with {}
    value: (x, y) => (y !== undefined ? y : x),
    default: () => ({})
  },
  entities: {
    value: (x, y) => {
      // Use EntityManager for smart merging
      if (!y) return x;
      const entityManager = getEntityManager();
      return entityManager.merge(x, y);
    },
    default: () => {
      // Initialize with EntityManager structure
      const entityManager = getEntityManager();
      return entityManager.initialize({});
    }
  },
  final_response: {
    value: (x, y) => y ? y : x,
    default: () => ""
  },
  error: {
    value: (x, y) => (y !== undefined ? y : x),
    default: () => null
  },
  // Context fields that need to be preserved through the coordinator flow
  session_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  org_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  user_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  thread_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  timezone: {
    value: (x, y) => y ? y : x,
    default: () => 'UTC'
  },
  // Approval-related fields
  // Use explicit undefined check so we can clear by setting null/false
  approval_decision: {
    value: (x, y) => (y !== undefined ? y : x),
    default: () => null
  },
  pendingApproval: {
    value: (x, y) => (y !== undefined ? y : x),
    default: () => null
  },
  // Clarification-related fields
  pendingClarification: {
    value: (x, y) => (y !== undefined ? y : x),
    default: () => null
  },
  contact_clarification_response: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  user_clarification_response: {
    value: (x, y) => y ? y : x,
    default: () => null
  }
};

class Coordinator {
  constructor(checkpointer = null) {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.3
    });

    this.mem0 = getMem0Service();
    this.passKeyManager = getPassKeyManager();
    this.errorHandler = getErrorHandler();
    this.metrics = getPerformanceMetrics();
    this.entityManager = getEntityManager({ maxHistoryPerType: 10 });
    this.checkpointer = checkpointer;
    this.tracingEnabled = langSmithEnabled;

    // Initialize domain subgraphs (will be loaded dynamically)
    this.subgraphs = new Map();
    
    // Build the coordinator graph
    this.graph = this.buildGraph();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: CoordinatorStateChannels
    });

    // Add nodes
    workflow.addNode("recall_memory", this.recallMemory.bind(this));
    workflow.addNode("route_domains", this.routeDomains.bind(this));
    workflow.addNode("execute_subgraphs", this.executeSubgraphs.bind(this));
    workflow.addNode("clarification_handler", this.handleClarification.bind(this));
    workflow.addNode("approval_handler", this.handleApproval.bind(this));
    workflow.addNode("finalize_response", this.finalizeResponse.bind(this));
    workflow.addNode("handle_error", this.handleError.bind(this));

    // Define edges
    workflow.setEntryPoint("recall_memory");
    
    workflow.addEdge("recall_memory", "route_domains");
    
    workflow.addConditionalEdges(
      "route_domains",
      (state) => {
        if (state.error) return "handle_error";
        // With the updated planner, we should always have at least 'general' domain
        // This fallback is for safety in case of unexpected planner behavior
        if (!state.domains || state.domains.length === 0) return "finalize_response";
        return "execute_subgraphs";
      },
      {
        "handle_error": "handle_error",
        "finalize_response": "finalize_response",
        "execute_subgraphs": "execute_subgraphs"
      }
    );

    // Add conditional edge from execute_subgraphs to check for clarifications or approvals
    workflow.addConditionalEdges(
      "execute_subgraphs",
      (state) => {
        // Check for clarifications first (they take priority) - only process fresh ones
        if (state.pendingClarification?.fresh &&
            state.pendingClarification?.requests?.length > 0 &&
            !state.pendingClarification?.processed) {
          console.log("[COORDINATOR:ROUTER] Routing to clarification_handler for pending clarifications");
          return "clarification_handler";
        }
        // Then check if any subgraph requested approval AND we don't already have a decision
        if (state.pendingApproval &&
            state.pendingApproval.requests &&
            state.pendingApproval.requests.length > 0 &&
            !state.pendingApproval.processed) {
          console.log("[COORDINATOR:ROUTER] Routing to approval_handler for pending approvals");
          return "approval_handler";
        }
        console.log("[COORDINATOR:ROUTER] No clarifications or approvals needed, routing to finalize_response");
        return "finalize_response";
      },
      {
        "clarification_handler": "clarification_handler",
        "approval_handler": "approval_handler",
        "finalize_response": "finalize_response"
      }
    );

    // After clarification_handler, re-execute subgraphs with the clarified information
    workflow.addConditionalEdges(
      "clarification_handler",
      (state) => {
        // If we have a clarification response, re-execute subgraphs
        if ((state.contact_clarification_response || state.user_clarification_response) &&
            state.pendingClarification) {
          console.log("[COORDINATOR:ROUTER] Clarification response received, re-executing subgraphs");
          // Mark clarification as processed before re-executing
          state.pendingClarification.processed = true;
          return "execute_subgraphs";
        }
        // Otherwise this is an interrupt waiting for user response
        return "finalize_response";
      },
      {
        "execute_subgraphs": "execute_subgraphs",
        "finalize_response": "finalize_response"
      }
    );

    // After approval_handler, check if we need to re-execute subgraphs with the decision
    workflow.addConditionalEdges(
      "approval_handler",
      (state) => {
        // If we have an approval decision, we need to re-execute subgraphs
        // so they can process the approved action
        if (state.approval_decision && state.pendingApproval) {
          console.log("[COORDINATOR:ROUTER] Approval decision received, re-executing subgraphs");
          return "execute_subgraphs";
        }
        // Otherwise go to finalize (shouldn't normally happen)
        return "finalize_response";
      },
      {
        "execute_subgraphs": "execute_subgraphs",
        "finalize_response": "finalize_response"
      }
    );
    workflow.addEdge("finalize_response", END);
    workflow.addEdge("handle_error", END);

    // Compile with checkpointer if available
    const compileOptions = {};
    if (this.checkpointer) {
      compileOptions.checkpointer = this.checkpointer;

      // DEBUGGING: Checkpointer configuration
      console.log("[COORDINATOR:DEBUG] Checkpointer configuration:", {
        checkpointerType: this.checkpointer.constructor.name,
        hasGet: typeof this.checkpointer.get === 'function',
        hasPut: typeof this.checkpointer.put === 'function',
        hasGetTuple: typeof this.checkpointer.getTuple === 'function',
        hasList: typeof this.checkpointer.list === 'function'
      });

      console.log("[COORDINATOR] Compiling graph with checkpointer");
    }

    if (this.tracingEnabled) {
      const tags = ['architecture:v2'];
      if (process.env.LANGCHAIN_PROJECT) {
        tags.push(`project:${process.env.LANGCHAIN_PROJECT}`);
      }

      compileOptions.tags = tags;
      compileOptions.metadata = {
        architecture: 'v2',
        project: process.env.LANGCHAIN_PROJECT || 'default'
      };
    }

    return workflow.compile(compileOptions);
  }

  buildRunConfig(baseConfig, context = {}, options = {}) {
    if (!this.tracingEnabled) {
      return baseConfig;
    }

    const config = {
      ...baseConfig,
      configurable: { ...(baseConfig.configurable || {}) }
    };

    const tags = ['architecture:v2'];
    const metadata = {
      architecture: 'v2'
    };

    if (process.env.LANGCHAIN_PROJECT) {
      const projectTag = `project:${process.env.LANGCHAIN_PROJECT}`;
      tags.push(projectTag);
      metadata.project = process.env.LANGCHAIN_PROJECT;
    }

    if (context.org_id) {
      tags.push(`org:${context.org_id}`);
      metadata.orgId = context.org_id;
    }

    if (context.user_id) {
      metadata.userId = context.user_id;
    }

    if (context.session_id) {
      tags.push(`session:${context.session_id}`);
      metadata.sessionId = context.session_id;
    }

    if (context.timezone) {
      tags.push(`timezone:${context.timezone}`);
      metadata.timezone = context.timezone;
    }

    if (options.domain) {
      tags.push(`domain:${options.domain}`);
      metadata.domain = options.domain;
    }

    if (options.runType) {
      tags.push(`run:${options.runType}`);
      metadata.runType = options.runType;
    }

    if (typeof options.stepIndex === 'number') {
      metadata.stepIndex = options.stepIndex;
    }

    if (options.query) {
      metadata.query = options.query.slice(0, 200);
    }

    if (options.approvalDecision) {
      metadata.approvalDecision = options.approvalDecision;
    }

    if (options.resume) {
      metadata.resume = true;
    }

    const runNamePrefix = options.runNamePrefix || (options.domain ? `subgraph_${options.domain}` : 'coordinator');
    config.runName = `${runNamePrefix}_${Date.now()}`;
    config.tags = Array.from(new Set(tags));
    config.metadata = metadata;

    return config;
  }

  /**
   * Recall relevant memories from previous interactions
   */
  async recallMemory(state) {
    console.log("[COORDINATOR:MEMORY] Recalling memories");
    
    // Start performance timer
    this.metrics.startTimer('memory_recall');
    
    if (!state.messages || state.messages.length === 0) {
      this.metrics.endTimer('memory_recall', true, { skipped: 'no_messages' });
      return state;
    }
    
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      this.metrics.endTimer('memory_recall', true, { skipped: 'no_user_message' });
      return state;
    }

    try {
      // Extract org and user from context (would come from session)
      const orgId = state.org_id || "default-org";
      const userId = state.user_id || "default-user";
      
      // Skip memory recall if Mem0 is not configured
      if (!this.mem0.client) {
        console.log("[COORDINATOR:MEMORY] Mem0 not configured, skipping recall");
        this.metrics.endTimer('memory_recall', true, { skipped: 'no_mem0' });
        this.metrics.recordCacheMiss('memory');
        return state;
      }
      
      // Recall memories based on user query with retry
      const memories = await this.errorHandler.executeWithRetry(
        async () => await this.mem0.recall(
          lastMessage.content,
          orgId,
          userId,
          { limit: 5, threshold: 0.7 }
        ),
        {
          operation: 'mem0_recall',
          maxRetries: 2,
          circuitBreakerKey: 'mem0'
        }
      );
      
      // Format memories into context
      const memoryContext = {};
      if (memories && memories.length > 0) {
        memoryContext.recalled_memories = memories.map(m => ({
          content: m.memory,
          relevance: m.score,
          metadata: m.metadata
        }));
        
        console.log(`[COORDINATOR:MEMORY] Recalled ${memories.length} relevant memories`);
        this.metrics.recordCacheHit('memory');
      } else {
        this.metrics.recordCacheMiss('memory');
      }
      
      this.metrics.endTimer('memory_recall', true, { count: memories.length });
      
      return {
        ...state,
        memory_context: memoryContext,
        // Clear stale state from previous queries
        pendingClarification: null,
        pendingApproval: null,
        contact_clarification_response: null,
        user_clarification_response: null
      };
      
    } catch (error) {
      console.error("[COORDINATOR:MEMORY] Error recalling memories:", error);
      this.metrics.endTimer('memory_recall', false, { error: error.message });
      // Continue without memories rather than failing
      return state;
    }
  }

  /**
   * Route query to appropriate domain subgraphs
   */
  async routeDomains(state) {
    console.log("[COORDINATOR:ROUTER] Analyzing query for domain routing");
    
    // Start performance timer
    this.metrics.startTimer('router');
    
    if (!state.messages || state.messages.length === 0) {
      this.metrics.endTimer('router', true, { skipped: 'no_messages' });
      return state;
    }
    
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      return state;
    }

    try {
      // Get entity statistics for context-aware routing
      const entityStats = state.entities ? this.entityManager.getStats(state.entities) : null;

      // Get recent messages (last 6 messages = 3 turns) for conversation context
      const recentMessages = state.messages ? state.messages.slice(-6) : [];

      console.log("[COORDINATOR:ROUTER] Context for planner:", {
        entityStats: entityStats ? {
          total: entityStats.totalEntities,
          byType: entityStats.byType
        } : 'none',
        recentMessageCount: recentMessages.length
      });

      // Use the lightweight planner to analyze and create execution plan
      const executionPlan = await createExecutionPlan(
        lastMessage.content,
        state.memory_context,
        entityStats,
        recentMessages
      );

      // Validate the execution plan
      const validation = validateExecutionPlan(executionPlan);
      if (!validation.valid) {
        console.error("[COORDINATOR:ROUTER] Invalid execution plan:", validation.errors);
        throw new Error(`Invalid execution plan: ${validation.errors.join(', ')}`);
      }

      if (validation.warnings.length > 0) {
        console.warn("[COORDINATOR:ROUTER] Plan warnings:", validation.warnings);
      }

      // Extract domains from plan
      const domains = [
        ...executionPlan.parallel || [],
        ...(executionPlan.sequential?.map(s => s.domain) || [])
      ];

      console.log("[COORDINATOR:ROUTER] Execution plan created:", {
        domains,
        parallel: executionPlan.parallel,
        sequential: executionPlan.sequential?.length || 0,
        hasEntities: executionPlan.metadata?.entities_found || 0
      });

      // Store entity information if present
      if (executionPlan.analysis?.entities) {
        state.entities = state.entities || {};
        state.entities.extracted = executionPlan.analysis.entities;
      }

      this.metrics.endTimer('router', true, { domains: domains.length });

      return {
        ...state,
        domains,
        execution_plan: executionPlan,
        error: null
      };
      
    } catch (error) {
      console.error("[COORDINATOR:ROUTER] Error routing domains:", error);
      return {
        ...state,
        error: `Failed to route query: ${error.message}`
      };
    }
  }


  /**
   * Execute domain subgraphs according to plan
   */
  async executeSubgraphs(state) {
    console.log("[COORDINATOR:EXECUTOR] Executing subgraphs");

    // Debug state to understand what's available
    console.log("[COORDINATOR:EXECUTOR] State debug:", {
      has_session_id: !!state.session_id,
      has_org_id: !!state.org_id,
      session_id_value: state.session_id,
      org_id_value: state.org_id,
      state_keys: Object.keys(state),
      has_approval_decision: !!state.approval_decision,
      has_pending_approval: !!state.pendingApproval
    });

    let results = {};
    const { execution_plan, session_id, org_id } = state;

    try {
      // Validate required fields
      if (!session_id) {
        console.error("[COORDINATOR:EXECUTOR] Missing session_id in state");
        return {
          ...state,
          error: "Missing session ID",
          requiresReauth: true,
          subgraph_results: {}
        };
      }

      if (!org_id) {
        console.error("[COORDINATOR:EXECUTOR] Missing org_id in state");
        return {
          ...state,
          error: "Missing organization ID",
          subgraph_results: {}
        };
      }

      // Check if we're resuming from an approval decision
      if (state.approval_decision && state.pendingApproval && state.pendingApproval.processed) {
        console.log("[COORDINATOR:EXECUTOR] Resuming with approval decision:", state.approval_decision);

        const { domains, results: previousResults, requests } = state.pendingApproval;

        // Restore previous results from non-approval domains
        results = previousResults || {};

        // Only re-execute the domains that requested approval
        // Override the execution plan to only run approval domains
        console.log(`[COORDINATOR:EXECUTOR] Re-executing only approval domains: ${domains?.join(', ')}`);

        // Temporarily override execution plan to only re-run approval domains
        if (domains && domains.length > 0) {
          execution_plan.parallel = domains;
          execution_plan.sequential = []; // Clear sequential for now
        }

        // The approval_decision will be passed to the subgraphs that need it
        // through the state when they are re-executed below
      }

      // Get PassKey for BSA operations with error recovery
      let passKey;
      try {
        passKey = await this.passKeyManager.getPassKey(session_id);
      } catch (passKeyError) {
        console.error("[COORDINATOR:EXECUTOR] Failed to get PassKey:", passKeyError);
        // Return authentication error that frontend can handle
        return {
          ...state,
          error: "Authentication failed",
          requiresReauth: true,
          subgraph_results: {}
        };
      }

      if (!passKey) {
        console.error("[COORDINATOR:EXECUTOR] No valid PassKey available");
        return {
          ...state,
          error: "Not authenticated. Please log in again.",
          requiresReauth: true,
          subgraph_results: {}
        };
      }
      
      // Create config for subgraphs (no checkpointer to prevent deadlocks)
      const config = {
        configurable: {
          thread_id: state.thread_id || `${session_id}:${org_id}`, // Still needed for context
          checkpoint_id: state.checkpoint_id,
          checkpoint_ns: "", // Default namespace
          // DO NOT propagate checkpointer to subgraphs - they are stateless
          // PassKey getter for thread-safe access
          getPassKey: async () => await this.passKeyManager.getPassKey(session_id),
          org_id,
          session_id
        }
      };
      
      // Execute parallel subgraphs
      if (execution_plan?.parallel?.length > 0) {
        console.log("[COORDINATOR:EXECUTOR] Running parallel subgraphs:", execution_plan.parallel);
        
        // Use Promise.allSettled to handle interrupts properly
        // Promise.all would reject immediately on first error, losing other results
        const parallelPromises = execution_plan.parallel.map(async (domain) => {
          const subgraph = await this.loadSubgraph(domain, config);
          if (!subgraph) {
            console.warn(`[COORDINATOR:EXECUTOR] Subgraph not found: ${domain}`);
            return {
              domain,
              error: "Subgraph not implemented",
              fallback_message: `The ${domain} feature is currently unavailable. Please try again later.`
            };
          }
          
          // Prepare subgraph state with all context fields
          const subgraphState = {
            messages: state.messages,
            memory_context: state.memory_context,
            entities: state.entities || {},
            timezone: state.timezone,
            // Pass through context fields for authentication
            session_id: state.session_id,
            org_id: state.org_id,
            user_id: state.user_id,
            thread_id: state.thread_id,
            // Pass clarification responses if resuming from clarification
            ...(state.contact_clarification_response && state.pendingClarification?.domains?.includes(domain) ? {
              contact_clarification_response: state.contact_clarification_response
            } : {}),
            ...(state.user_clarification_response && state.pendingClarification?.domains?.includes(domain) ? {
              user_clarification_response: state.user_clarification_response
            } : {}),
            // Pass approval decision if resuming and this domain requested approval
            ...(state.approval_decision && state.pendingApproval?.domains?.includes(domain) ? {
              approval_decision: state.approval_decision
            } : {})
          };

          // Create config for subgraph with unique namespace
          // Use same thread_id as parent for interrupt propagation
          // Namespace provides isolation to prevent checkpoint conflicts
          const subgraphConfigBase = {
            configurable: {
              ...config.configurable,
              // Unique namespace for this subgraph's checkpoints
              checkpoint_ns: `${domain}_subgraph`
            }
          };

          const userMessage = Array.isArray(subgraphState.messages)
            ? [...subgraphState.messages].reverse().find(m => m?.role === 'user')
            : null;

          const subgraphConfig = this.buildRunConfig(
            subgraphConfigBase,
            subgraphState,
            {
              runNamePrefix: `subgraph_${domain}`,
              runType: 'parallel',
              domain,
              query: userMessage?.content
            }
          );

          // Execute subgraph and handle interrupts
          try {
            const result = await subgraph.invoke(subgraphState, subgraphConfig);

            // Enhanced debug logging to understand result structure
            console.log(`[COORDINATOR:EXECUTOR] ${domain} subgraph returned:`, {
              hasResult: !!result,
              resultType: typeof result,
              resultKeys: result ? Object.keys(result).slice(0, 10) : [], // First 10 keys to avoid log overflow
              requiresApproval: result?.requiresApproval,
              hasApprovalRequest: !!result?.approvalRequest,
              // Check if result might be wrapped
              hasValue: !!result?.value,
              valueRequiresApproval: result?.value?.requiresApproval
            });

            // Ensure result is not undefined
            return {
              domain,
              result: result || { error: `${domain} subgraph returned no result` }
            };
          } catch (error) {
            // Handle interrupts from subgraphs
            if (error && error.name === 'GraphInterrupt') {
              const interruptValue = error.value?.value || error.value;

              // Check if it's a clarification interrupt (contact disambiguation, contact clarification, or user clarification)
              if (interruptValue?.type === 'contact_clarification' ||
                  interruptValue?.type === 'user_clarification' ||
                  interruptValue?.type === 'contact_disambiguation') {
                console.log(`[COORDINATOR:EXECUTOR] ${domain} subgraph needs clarification:`, interruptValue.type);

                // Return special result indicating clarification needed
                // This will be handled by the coordinator's clarification_handler node
                return {
                  domain,
                  result: {
                    needsClarification: true,
                    clarificationType: interruptValue.type,
                    clarificationData: interruptValue,
                    // Preserve other state from the subgraph
                    ...subgraphState
                  }
                };
              }

              // For other interrupts, propagate as before
              console.log(`[COORDINATOR:EXECUTOR] Interrupt exception from ${domain} subgraph - propagating to parent`);
              error.domain = domain;
              throw error;  // Propagate interrupt to parent graph
            }
            console.error(`[COORDINATOR:EXECUTOR] Error in ${domain} subgraph:`, error);
            // Return proper error object for non-interrupt errors
            return {
              domain,
              result: { error: error.message || "Unknown error occurred" }
            };
          }
        });
        
        // Execute all parallel subgraphs
        const parallelResults = await Promise.allSettled(parallelPromises);

        // Check for interrupts first (they take priority)
        // Interrupts will be in rejected promises with GraphInterrupt name
        for (const settledResult of parallelResults) {
          if (settledResult.status === 'rejected') {
            const error = settledResult.reason;
            // If any subgraph threw an interrupt, propagate it immediately
            if (error && error.name === 'GraphInterrupt') {
              console.log(`[COORDINATOR:EXECUTOR] Propagating interrupt from parallel execution`);
              throw error;
            }
          }
        }

        // Process successful results
        parallelResults.forEach((settledResult) => {
          if (settledResult.status === 'fulfilled') {
            const { domain, result } = settledResult.value;
            // Ensure result exists before storing
            results[domain] = result || { error: `No result returned from ${domain} subgraph` };

            // Merge entities from subgraph safely
            if (result && result.entities) {
              state.entities = { ...state.entities, ...result.entities };
            }
          } else {
            // Handle rejected promises that aren't interrupts
            const error = settledResult.reason;
            console.error(`[COORDINATOR:EXECUTOR] Parallel subgraph failed:`, error);
            // Try to extract domain from error if available
            const domain = error.domain || 'unknown';
            results[domain] = { error: error.message || 'Unknown error occurred' };
          }
        });
      }
      
      // Execute sequential subgraphs
      if (execution_plan?.sequential?.length > 0) {
        console.log("[COORDINATOR:EXECUTOR] Running sequential subgraphs");
        
        for (let idx = 0; idx < execution_plan.sequential.length; idx++) {
          const step = execution_plan.sequential[idx];
          const subgraph = await this.loadSubgraph(step.domain, config);
          if (!subgraph) {
            console.warn(`[COORDINATOR:EXECUTOR] Subgraph not found: ${step.domain}`);
            results[step.domain] = { error: "Subgraph not implemented" };
            continue;
          }
          
          // Prepare subgraph state with results from dependencies
          const subgraphState = {
            messages: state.messages,
            memory_context: state.memory_context,
            entities: state.entities || {},
            timezone: state.timezone,
            // Pass through context fields for authentication
            session_id: state.session_id,
            org_id: state.org_id,
            user_id: state.user_id,
            thread_id: state.thread_id,
            dependencies: step.depends_on?.reduce((acc, dep) => {
              acc[dep] = results[dep];
              return acc;
            }, {}),
            // Pass approval decision if resuming and this domain requested approval
            ...(state.approval_decision && state.pendingApproval?.domains?.includes(step.domain) ? {
              approval_decision: state.approval_decision
            } : {})
          };

          // Create unique config for subgraph to avoid checkpoint conflicts
          // Each subgraph gets its own namespace to prevent deadlocks
          // Use same thread_id as parent for interrupt propagation
          const subgraphConfigBase = {
            configurable: {
              ...config.configurable,
              // Unique namespace for this subgraph's checkpoints
              checkpoint_ns: `${step.domain}_subgraph`
            }
          };

          const userMessage = Array.isArray(subgraphState.messages)
            ? [...subgraphState.messages].reverse().find(m => m?.role === 'user')
            : null;

          const subgraphConfig = this.buildRunConfig(
            subgraphConfigBase,
            subgraphState,
            {
              runNamePrefix: `subgraph_${step.domain}`,
              runType: 'sequential',
              domain: step.domain,
              query: step.extractQuery || userMessage?.content,
              stepIndex: idx
            }
          );

          // Execute subgraph and handle interrupts
          try {
            const result = await subgraph.invoke(subgraphState, subgraphConfig);

            // Debug logging for sequential execution
            console.log(`[COORDINATOR:EXECUTOR] ${step.domain} subgraph returned:`, {
              hasResult: !!result,
              requiresApproval: result?.requiresApproval,
              valueRequiresApproval: result?.value?.requiresApproval
            });

            // Ensure result is not undefined before storing
            results[step.domain] = result || { error: `${step.domain} subgraph returned no result` };

            // Merge entities from subgraph safely
            if (result && result.entities) {
              state.entities = { ...state.entities, ...result.entities };
            }
          } catch (error) {
            // Re-throw interrupts to propagate to parent graph
            if (error && error.name === 'GraphInterrupt') {
              console.log(`[COORDINATOR:EXECUTOR] Interrupt exception from ${step.domain} subgraph - propagating to parent`);
              // Add domain info to interrupt for context
              error.domain = step.domain;
              throw error;  // Propagate interrupt to parent graph
            }
            console.error(`[COORDINATOR:EXECUTOR] Error in ${step.domain} subgraph:`, error);
            this.metrics.endTimer(step.domain, false, { error: error.message });
            results[step.domain] = { error: error.message || "Unknown error occurred" };
          }
        }
      }
      
      // Check if any subgraph is requesting approval
      // Check for clarification needs BEFORE checking for approvals
      // Clarifications take priority as they need to be resolved first
      const clarificationRequests = [];
      for (const [domain, result] of Object.entries(results)) {
        if (result && result.needsClarification) {
          console.log(`[COORDINATOR:EXECUTOR] Clarification needed from ${domain} subgraph:`, result.clarificationType);
          clarificationRequests.push({
            domain,
            type: result.clarificationType,
            data: result.clarificationData
          });
          // Store the partial state from the subgraph
          results[`${domain}_partial`] = result;
        }
      }

      // If we have clarification requests, store them and skip approval check
      if (clarificationRequests.length > 0) {
        console.log(`[COORDINATOR:EXECUTOR] Found ${clarificationRequests.length} clarification request(s) - storing in state`);

        // Store clarification context for the clarification_handler node
        state.pendingClarification = {
          requests: clarificationRequests,
          domains: clarificationRequests.map(req => req.domain),
          results: results,
          fresh: true  // Mark as fresh to distinguish from stale checkpoint data
        };

        console.log("[COORDINATOR:EXECUTOR] Clarification requests stored - will route to clarification_handler");
      }

      // ONLY check for new approvals if we're not already processing an approval decision
      // AND if we don't have pending clarifications
      if (!state.approval_decision && !state.pendingClarification) {
        const approvalRequests = [];
        for (const [domain, result] of Object.entries(results)) {
          if (result && result.requiresApproval && result.approvalRequest) {
            console.log(`[COORDINATOR:EXECUTOR] Approval request detected from ${domain} subgraph`);
            approvalRequests.push(result.approvalRequest);
          }
        }

        // If we have approval requests, store them in state for the approval_handler node
        if (approvalRequests.length > 0) {
          console.log(`[COORDINATOR:EXECUTOR] Found ${approvalRequests.length} approval request(s) - storing in state`);

          // Store approval context for the approval_handler node
          state.pendingApproval = {
            domains: approvalRequests.map(req => req.domain),
            results: results,
            requests: approvalRequests,
            // For sequential execution tracking (if needed)
            stepIndex: state.execution_plan?.sequential?.findIndex(
              step => approvalRequests.some(req => req.domain === step.domain)
            ) ?? -1
          };

          console.log("[COORDINATOR:EXECUTOR] Approval requests stored - will route to approval_handler");
        }
      } else {
        console.log("[COORDINATOR:EXECUTOR] Skipping approval check - processing approval decision");
        // Clear the requiresApproval flag from results since we're processing the decision
        for (const [domain, result] of Object.entries(results)) {
          if (result && result.requiresApproval) {
            result.requiresApproval = false;
          }
        }
      }

      console.log("[COORDINATOR:EXECUTOR] Subgraph execution complete");

      return {
        ...state,
        subgraph_results: results,
        // Preserve pendingClarification if it was set
        ...(state.pendingClarification ? { pendingClarification: state.pendingClarification } : {}),
        // Also preserve pendingApproval if it was set
        ...(state.pendingApproval ? { pendingApproval: state.pendingApproval } : {})
      };
      
    } catch (error) {
      // Handle actual errors
      console.error("[COORDINATOR:EXECUTOR] Error executing subgraphs:", error);
      return {
        ...state,
        error: `Failed to execute subgraphs: ${error.message}`
      };
    }
  }

  /**
   * Handle approval requests from subgraphs
   * This is a dedicated node that throws interrupts for approvals
   */
  /**
   * Handle clarification interrupts for contacts/users
   * This is a dedicated node that throws interrupts when names need clarification
   */
  async handleClarification(state) {
    console.log("[COORDINATOR:CLARIFICATION] Processing clarification requests");

    // Check if we're resuming with a clarification response
    if (state.contact_clarification_response || state.user_clarification_response) {
      console.log("[COORDINATOR:CLARIFICATION] Resuming with clarification response");

      // Pass the clarification response to the appropriate subgraph
      const clarificationType = state.contact_clarification_response ? 'contact' : 'user';
      console.log(`[COORDINATOR:CLARIFICATION] Processing ${clarificationType} clarification`);

      // Clear clarification after processing (will re-execute subgraphs)
      return {
        ...state,
        pendingClarification: null
      };
    }

    // Check if we have pending clarifications
    if (!state.pendingClarification || !state.pendingClarification.requests ||
        state.pendingClarification.requests.length === 0) {
      console.log("[COORDINATOR:CLARIFICATION] No pending clarifications found");
      return state;
    }

    const clarificationRequest = state.pendingClarification.requests[0]; // Handle one at a time
    console.log(`[COORDINATOR:CLARIFICATION] Found clarification request: ${clarificationRequest.type}`);

    // Throw interrupt for clarification UI
    const interruptData = {
      ...clarificationRequest.data,
      domain: clarificationRequest.domain,
      thread_id: state.thread_id || null
    };

    console.log("[COORDINATOR:CLARIFICATION] Throwing interrupt for clarification UI");
    console.log("[COORDINATOR:CLARIFICATION] Interrupt type:", clarificationRequest.type);

    // Throw the interrupt with checkpoint
    console.log("[COORDINATOR:CLARIFICATION] 🔴 THROWING INTERRUPT - Checkpoint should be saved by LangGraph");

    throw interrupt({
      value: interruptData
    });
  }

  async handleApproval(state) {
    console.log("[COORDINATOR:APPROVAL] Processing approval requests");

    // CRITICAL FIX: Check if we're resuming with an approval decision
    // If so, we should NOT throw another interrupt - just pass through
    if (state.approval_decision) {
      console.log(`[COORDINATOR:APPROVAL] Resuming with approval decision: ${state.approval_decision}`);
      console.log("[COORDINATOR:APPROVAL] Skipping interrupt - decision already provided");

      // Clear the pendingApproval flag since we have a decision
      // But keep the data for subgraphs to process
      return {
        ...state,
        // Keep pendingApproval data for subgraphs but mark as processed
        pendingApproval: {
          ...state.pendingApproval,
          processed: true
        }
      };
    }

    // Check if we have pending approvals
    if (!state.pendingApproval || !state.pendingApproval.requests || state.pendingApproval.requests.length === 0) {
      console.log("[COORDINATOR:APPROVAL] No pending approvals found - this shouldn't happen");
      return state;
    }

    const approvalRequests = state.pendingApproval.requests;
    console.log(`[COORDINATOR:APPROVAL] Found ${approvalRequests.length} approval request(s)`);

    // Consolidate approval requests into a single interrupt
    const consolidatedRequest = {
      type: "approval_required",
      previews: approvalRequests.map(req => ({
        actionId: req.actionId,
        action: req.action,
        preview: req.preview,
        data: req.data,
        domain: req.domain
      })),
      message: approvalRequests.length > 1
        ? "Multiple actions require your approval:"
        : approvalRequests[0].message,
      thread_id: state.thread_id || null,
      domains: approvalRequests.map(req => req.domain)
    };

    console.log("[COORDINATOR:APPROVAL] Throwing interrupt for approval UI");
    console.log("[COORDINATOR:APPROVAL] Interrupt details:", {
      type: consolidatedRequest.type,
      previewCount: consolidatedRequest.previews?.length,
      thread_id: consolidatedRequest.thread_id,
      domains: consolidatedRequest.domains
    });

    // Throw the interrupt - this is at the proper graph boundary
    // LangGraph will catch this, save checkpoint, and return with __interrupt__
    console.log("[COORDINATOR:APPROVAL] 🔴 THROWING INTERRUPT - Checkpoint should be saved by LangGraph");
    throw interrupt({
      value: consolidatedRequest
    });
  }

  /**
   * Load a domain subgraph dynamically
   * @param {string} domain - The domain name
   * @param {Object} config - The config containing checkpointer
   */
  async loadSubgraph(domain, config) {
    // Create cache key based on domain
    // Subgraphs are now stateless, so we can use simple domain-based caching
    const cacheKey = domain;

    // Check cache
    if (this.subgraphs.has(cacheKey)) {
      return this.subgraphs.get(cacheKey);
    }

    try {
      // Dynamically import subgraph from domains
      const subgraphModule = require(`../domains/${domain}/graph`);

      // DO NOT pass checkpointer to subgraphs - they should be stateless
      // This prevents deadlocks from concurrent checkpoint writes
      const subgraph = subgraphModule.createSubgraph ?
        await subgraphModule.createSubgraph(null) :  // Always pass null for stateless operation
        subgraphModule.default;

      // Cache for future use
      this.subgraphs.set(cacheKey, subgraph);

      console.log(`[COORDINATOR:LOADER] Loaded ${domain} subgraph in STATELESS mode (no checkpointer)`);

      return subgraph;

    } catch (error) {
      console.error(`[COORDINATOR:LOADER] Failed to load ${domain} subgraph:`, error.message);
      return null;
    }
  }

  /**
   * Finalize response from subgraph results
   */
  async finalizeResponse(state) {
    console.log("[COORDINATOR:FINALIZER] Generating final response");

    try {
      // Quick Q&A over recent entities for follow-ups like
      // "Who was it with?" or "Who was the appointment with?"
      const lastMessage = state.messages[state.messages.length - 1];
      const lastText = String(lastMessage?.content || '').toLowerCase();
      const apptEntity = state.entities?.appointment;
      if (apptEntity && typeof lastText === 'string') {
        const asksWho = /\bwho\b/.test(lastText) && /(with|attendee|attendees|appointment)/.test(lastText);
        if (asksWho) {
          const names = Array.isArray(apptEntity.participants) ? apptEntity.participants.filter(Boolean) : [];
          if (names.length > 0) {
            const quickResponse = names.join(', ');
            return {
              ...state,
              messages: [
                ...state.messages,
                { role: "assistant", content: quickResponse }
              ],
              // Clear approval markers and results as part of end-of-turn hygiene
              approval_decision: null,
              pendingApproval: null,
              subgraph_results: {},
              final_response: quickResponse
            };
          }
        }
      }

      // If no subgraphs were executed, provide a context-aware response
      if (!state.subgraph_results || Object.keys(state.subgraph_results).length === 0) {
        const lastMessage = state.messages[state.messages.length - 1];
        // Build lightweight context from entities to help resolve pronouns like "it"
        const entityContext = (() => {
          const appt = state.entities?.appointment;
          const wf = state.entities?.workflow;
          const parts = [];

          if (appt) {
            parts.push(`Last appointment: ${appt.name || 'Untitled'}`);
            if (appt.time) parts.push(`at ${new Date(appt.time).toLocaleString()}`);
            if (Array.isArray(appt.participants) && appt.participants.length > 0) {
              parts.push(`with ${appt.participants.join(', ')}`);
            }
          }

          if (wf) {
            parts.push(`Last workflow: ${wf.name || 'Untitled'} (${wf.stepCount || 0} steps)`);
          }

          return parts.length > 0 ? `Context: ${parts.join('; ')}` : '';
        })();

        // Use LLM to generate a response with entity context
        const response = await this.llm.invoke(`
          User query: "${lastMessage.content}"
          ${entityContext ? `\n${entityContext}` : ''}
          ${state.memory_context?.recalled_memories ?
            `\nMemory hint: ${JSON.stringify(state.memory_context.recalled_memories[0]?.content || '')}` : ''}
          \nProvide a concise, direct answer using the context above when relevant.
        `);

        const contextualResponse = response.content;

        return {
          ...state,
          messages: [
            ...state.messages,
            { role: "assistant", content: contextualResponse }
          ],
          // Clear approval markers and results so future turns don't auto-approve or re-aggregate
          approval_decision: null,
          pendingApproval: null,
          subgraph_results: {},
          final_response: contextualResponse
        };
      }
      
      // Aggregate results from subgraphs
      const aggregatedResults = [];

      for (const [domain, result] of Object.entries(state.subgraph_results)) {
        // Add null/undefined check to prevent crashes
        if (!result) {
          console.warn(`[COORDINATOR:FINALIZER] No result for domain: ${domain}`);
          aggregatedResults.push(`${domain}: No response received`);
          continue;
        }

        if (result.error) {
          aggregatedResults.push(`${domain}: Error - ${result.error}`);
        } else if (result.response) {
          aggregatedResults.push(result.response);
        } else if (result.data) {
          aggregatedResults.push(`${domain}: ${JSON.stringify(result.data)}`);
        } else {
          // Handle case where result exists but has no recognized properties
          console.warn(`[COORDINATOR:FINALIZER] Unexpected result structure for ${domain}:`, result);
          aggregatedResults.push(`${domain}: Processing incomplete`);
        }
      }
      
      // If we have results, format them nicely
      if (aggregatedResults.length > 0) {
        const finalResponse = aggregatedResults.join("\n\n");

        // Append assistant response to messages for conversation history
        const updatedMessages = [
          ...state.messages,
          { role: "assistant", content: finalResponse }
        ];

        // Store the interaction in memory
        if (this.mem0.client && state.org_id && state.user_id) {
          await this.mem0.synthesize(
            updatedMessages,
            state.org_id,
            state.user_id,
            {
              domains: state.domains,
              timestamp: new Date().toISOString()
            }
          );
        }

        return {
          ...state,
          messages: updatedMessages,
          // Clear approval markers and results so future turns don't auto-approve or re-aggregate
          approval_decision: null,
          pendingApproval: null,
          subgraph_results: {},
          final_response: finalResponse
        };
      }

      const fallbackResponse = "I couldn't process your request. Please try again.";

      return {
        ...state,
        messages: [
          ...state.messages,
          { role: "assistant", content: fallbackResponse }
        ],
        // Clear approval markers and results so future turns don't auto-approve or re-aggregate
        approval_decision: null,
        pendingApproval: null,
        subgraph_results: {},
        final_response: fallbackResponse
      };
      
    } catch (error) {
      console.error("[COORDINATOR:FINALIZER] Error finalizing response:", error);
      const errorResponse = `I encountered an error: ${error.message}. Please try again.`;
      return {
        ...state,
        messages: [
          ...state.messages,
          { role: "assistant", content: errorResponse }
        ],
        // Clear approval markers and results so future turns don't auto-approve or re-aggregate
        approval_decision: null,
        pendingApproval: null,
        subgraph_results: {},
        error: `Failed to generate response: ${error.message}`,
        final_response: errorResponse
      };
    }
  }

  /**
   * Handle errors gracefully
   */
  async handleError(state) {
    console.error("[COORDINATOR:ERROR] Handling error:", state.error);
    
    return {
      ...state,
      final_response: `I encountered an error: ${state.error}. Please try again or rephrase your request.`
    };
  }

  /**
   * Get performance metrics report
   */
  getPerformanceReport() {
    return this.metrics.getReport();
  }

  /**
   * Get error handler report
   */
  getErrorReport() {
    return this.errorHandler.getErrorReport();
  }

  /**
   * Reset performance metrics
   */
  resetMetrics() {
    this.metrics.reset();
  }

  /**
   * Reset error handler circuit breakers
   */
  resetCircuitBreakers() {
    this.errorHandler.resetAllCircuitBreakers();
  }

  /**
   * Main entry point for processing queries
   */
  async processQuery(query, context = {}) {
    // Check if this is a resume from approval (has approval_decision)
    if (context.approval_decision) {
      console.log("[COORDINATOR] 🔄 Resuming from approval with decision:", context.approval_decision);
      console.log("[COORDINATOR:RESUME] Full context:", {
        hasApprovalDecision: !!context.approval_decision,
        decision: context.approval_decision,
        hasPendingApproval: !!context.pendingApproval,
        pendingApprovalDomains: context.pendingApproval?.domains,
        hasMessages: !!context.messages,
        messageCount: context.messages?.length,
        thread_id: context.thread_id,
        contextKeys: Object.keys(context).slice(0, 15)
      });

      // Start total execution timer
      this.metrics.startTimer('total');

      // Use the full context as state (includes checkpoint state + approval_decision)
      const resumeState = {
        ...context,  // This includes all checkpoint state and approval_decision
        // Ensure required fields are present
        messages: context.messages || [],
        org_id: context.org_id,
        user_id: context.user_id,
        session_id: context.session_id,
        thread_id: context.thread_id,
        timezone: context.timezone || 'UTC'
      };

      // Create config for checkpointer
      const config = {
        configurable: {
          thread_id: context.thread_id || `${context.session_id}:${context.org_id}`,
          checkpoint_ns: "" // Default namespace
        }
      };

      // Resume the graph with approval decision
      console.log("[COORDINATOR:RESUME] 🚀 Invoking graph with resume state...");
      const resumeStart = Date.now();
      const resumeConfig = this.buildRunConfig(
        config,
        {
          org_id: context.org_id,
          user_id: context.user_id,
          session_id: context.session_id,
          timezone: context.timezone || 'UTC'
        },
        {
          runNamePrefix: 'coordinator_resume',
          runType: 'resume',
          query: resumeState.messages?.find(m => m.role === 'user')?.content,
          approvalDecision: context.approval_decision,
          resume: true
        }
      );
      const result = await this.graph.invoke(resumeState, resumeConfig);
      console.log(`[COORDINATOR:RESUME] ⏱️ Graph invoke completed in ${Date.now() - resumeStart}ms`);

      // Handle any new interrupts
      if (result && result['__interrupt__']) {
        const interrupts = result['__interrupt__'];
        console.log("[COORDINATOR:RESUME] 🆕 New interrupt detected after resume:", {
          interruptCount: interrupts?.length,
          firstInterruptType: interrupts?.[0]?.value?.type
        });
        if (interrupts && interrupts.length > 0) {
          const interruptData = interrupts[0];
          const error = new Error('GraphInterrupt');
          error.name = 'GraphInterrupt';
          error.value = interruptData.value || interruptData;
          error.interrupts = [{ value: interruptData.value || interruptData }];
          this.metrics.endTimer('total', true, { interrupt: true });
          throw error;
        }
      }

      console.log("[COORDINATOR:RESUME] ✅ Resume completed successfully:", {
        hasFinalResponse: !!result?.final_response,
        hasError: !!result?.error,
        resultKeys: result ? Object.keys(result).slice(0, 10) : null
      });

      this.metrics.endTimer('total', true);
      return result;
    }

    // Normal query processing (not a resume)
    console.log("[COORDINATOR] Processing query:", query);

    // Debug context to ensure it's being passed correctly
    console.log("[COORDINATOR] Context debug:", {
      has_session_id: !!context.session_id,
      has_org_id: !!context.org_id,
      session_id: context.session_id,
      org_id: context.org_id,
      user_id: context.user_id
    });

    // Start total execution timer
    this.metrics.startTimer('total');

    // Create config with thread_id for checkpointer (REQUIRED by LangGraph)
    const config = {
      configurable: {
        thread_id: context.thread_id || `${context.session_id}:${context.org_id}`,
        checkpoint_ns: "" // Default namespace
      }
    };

    // Retrieve previous conversation history and entities from checkpoint
    let previousMessages = [];
    let previousEntities = {};

    if (this.checkpointer) {
      try {
        const checkpointState = await this.graph.getState(config);

        if (checkpointState && checkpointState.values) {
          // Extract previous messages
          if (Array.isArray(checkpointState.values.messages)) {
            previousMessages = checkpointState.values.messages;
            console.log(`[COORDINATOR:HISTORY] Retrieved ${previousMessages.length} previous messages from checkpoint`);
          }

          // Extract previous entities for context continuity
          if (checkpointState.values.entities) {
            previousEntities = checkpointState.values.entities;
            const stats = this.entityManager.getStats(previousEntities);
            console.log("[COORDINATOR:HISTORY] Retrieved entities from checkpoint:", {
              types: stats.types,
              totalEntities: stats.totalEntities,
              byType: stats.byType
            });
          }
        }
      } catch (error) {
        // If checkpoint retrieval fails, continue with empty history
        console.warn("[COORDINATOR:HISTORY] Failed to retrieve checkpoint history:", error.message);
      }
    }

    // Prepare initial state with accumulated message history
    const initialState = {
      messages: [
        ...previousMessages,
        { role: "user", content: query }
      ],
      org_id: context.org_id,
      user_id: context.user_id,
      session_id: context.session_id,
      thread_id: context.thread_id,
      checkpoint_id: context.checkpoint_id,
      timezone: context.timezone || 'UTC',
      // Preserve entities from previous turn for context continuity
      entities: previousEntities,
      // Proactively clear any stale approval markers from previous turns
      approval_decision: null,
      pendingApproval: null,
      // Ensure stale results aren't re-aggregated
      subgraph_results: {}
    };

    console.log("[COORDINATOR:HISTORY] Initial state prepared with:", {
      totalMessages: initialState.messages.length,
      hasEntities: Object.keys(previousEntities).length > 0,
      entityTypes: Object.keys(previousEntities)
    });

    try {

      // DEBUGGING: Log before invoke
      console.log("[COORDINATOR:DEBUG] About to invoke graph with config:", {
        hasCheckpointer: !!this.checkpointer,
        thread_id: config.configurable.thread_id,
        checkpoint_ns: config.configurable.checkpoint_ns,
        initialStateKeys: Object.keys(initialState)
      });

      // Execute the coordinator graph WITH config (critical for checkpointer)
      const invokeConfig = this.buildRunConfig(
        config,
        {
          org_id: context.org_id,
          user_id: context.user_id,
          session_id: context.session_id,
          timezone: context.timezone || 'UTC'
        },
        {
          runNamePrefix: 'coordinator',
          runType: 'initial',
          query
        }
      );
      const result = await this.graph.invoke(initialState, invokeConfig);

      // IMPORTANT: For invoke(), we must use getState() to check for interrupts
      // This is documented behavior in LangGraph JS - interrupts are not returned in result
      console.log("[COORDINATOR:INTERRUPT] Calling getState() to check for interrupts (required for invoke)");
      const graphState = await this.graph.getState(invokeConfig);

      // DEBUGGING: Log complete state structure
      console.log("[COORDINATOR:INTERRUPT] 🔍 Graph state structure:", {
        hasState: !!graphState,
        hasValues: !!graphState?.values,
        hasTasks: !!graphState?.tasks,
        taskCount: graphState?.tasks?.length,
        hasNext: !!graphState?.next,
        nextNodes: graphState?.next,
        // Log the actual tasks array structure
        tasksStructure: graphState?.tasks?.map(t => ({
          id: t.id,
          name: t.name,
          hasInterrupts: !!t.interrupts,
          interruptCount: t.interrupts?.length || 0
        })),
        // Also check values for approval-related data
        valuesHasApprovalRequest: !!graphState?.values?.approvalRequest,
        valuesHasPendingApproval: !!graphState?.values?.pendingApproval
      });

      // If we have tasks, log more details
      if (graphState?.tasks && graphState.tasks.length > 0) {
        console.log("[COORDINATOR:INTERRUPT] Checking tasks for interrupts:", {
          totalTasks: graphState.tasks.length,
          tasksWithInterrupts: graphState.tasks.filter(t => t.interrupts && t.interrupts.length > 0).length
        });

        // Look for tasks with interrupts
        for (const task of graphState.tasks) {
          console.log(`[COORDINATOR:INTERRUPT] Task ${task.id}:`, {
            name: task.name,
            hasInterrupts: !!task.interrupts,
            interruptCount: task.interrupts?.length || 0
          });

          if (task.interrupts && task.interrupts.length > 0) {
            console.log("[COORDINATOR:INTERRUPT] ✅ INTERRUPT FOUND in task:", {
              taskId: task.id,
              taskName: task.name,
              interruptCount: task.interrupts.length,
              interruptValue: task.interrupts[0].value,
              interruptType: task.interrupts[0].value?.type,
              interruptPreviews: task.interrupts[0].value?.previews?.length || 0
            });

            // Extract the interrupt data
            const interruptData = task.interrupts[0];

            // Log the interrupt data structure
            console.log("[COORDINATOR:INTERRUPT] Interrupt data structure:", {
              hasValue: !!interruptData.value,
              valueType: typeof interruptData.value,
              valueKeys: interruptData.value ? Object.keys(interruptData.value) : null,
              rawInterrupt: JSON.stringify(interruptData, null, 2).substring(0, 500) // First 500 chars
            });

            // Create GraphInterrupt error for API layer
            const error = new Error('GraphInterrupt');
            error.name = 'GraphInterrupt';
            error.value = interruptData.value || interruptData;
            error.interrupts = [{ value: interruptData.value || interruptData }];

            console.log("[COORDINATOR:INTERRUPT] 🚀 Throwing GraphInterrupt to API layer");

            // Log checkpoint saving expectation
            console.log("[COORDINATOR:INTERRUPT] 💾 Note: LangGraph should save checkpoint automatically when interrupt is thrown");
            console.log("[COORDINATOR:INTERRUPT] Thread ID for checkpoint:", invokeConfig.configurable.thread_id);
            console.log("[COORDINATOR:INTERRUPT] Checkpointer type:", this.checkpointer?.constructor?.name);

            this.metrics.endTimer('total', true, { interrupt: true });
            throw error;
          }
        }

        console.log("[COORDINATOR:INTERRUPT] ❌ No interrupts found in any tasks");
      } else {
        console.log("[COORDINATOR:INTERRUPT] ❌ No tasks found in graph state");
      }

      // DEBUGGING: Comprehensive result inspection
      console.log("[COORDINATOR:DEBUG] Graph invoke returned:", {
        resultType: typeof result,
        resultKeys: result ? Object.keys(result) : null,
        hasInterruptField: !!result?.['__interrupt__'],
        interruptValue: result?.['__interrupt__'],
        hasPendingApproval: !!result?.pendingApproval,
        pendingApprovalData: result?.pendingApproval ? {
          domains: result.pendingApproval.domains,
          hasRequests: !!result.pendingApproval.requests,
          requestCount: result.pendingApproval.requests?.length
        } : null,
        hasSubgraphResults: !!result?.subgraph_results,
        subgraphResultKeys: result?.subgraph_results ? Object.keys(result.subgraph_results) : null,
        finalResponseLength: result?.final_response?.length,
        hasError: !!result?.error
      });

      // Check if LangGraph returned with an interrupt (keeping for backward compatibility)
      // When a node throws an interrupt, LangGraph catches it, saves checkpoint,
      // and returns with __interrupt__ field containing interrupt info
      if (result && result['__interrupt__']) {
        const interrupts = result['__interrupt__'];
        if (interrupts && interrupts.length > 0) {
          console.log("[COORDINATOR] Graph interrupted - extracting interrupt data");

          // Extract the first interrupt (typically there's only one)
          const interruptData = interrupts[0];

          // Create a proper GraphInterrupt to throw to API layer
          const error = new Error('GraphInterrupt');
          error.name = 'GraphInterrupt';
          error.value = interruptData.value || interruptData;
          error.interrupts = [{ value: interruptData.value || interruptData }];

          console.log("[COORDINATOR] Propagating interrupt to API layer");
          this.metrics.endTimer('total', true, { interrupt: true });
          throw error;
        }
      }

      // End total timer
      this.metrics.endTimer('total', true, {
        domains: result.domains?.length || 0
      });

      // Log performance summary
      const perf = this.getPerformanceReport();
      if (perf.warnings.length > 0) {
        console.warn("[COORDINATOR] Performance warnings:", perf.warnings);
      }
      
      return {
        success: true,
        response: result.final_response,
        entities: result.entities,
        domains: result.domains,
        metrics: {
          totalTime: perf.operations.total?.avg || 0,
          cacheHitRate: perf.cache.hitRate
        }
      };
      
    } catch (error) {
      // Re-throw interrupts to allow approval flow
      if (error && error.name === 'GraphInterrupt') {
        console.log("[COORDINATOR] Propagating interrupt to API layer");
        this.metrics.endTimer('total', true, { interrupt: true });
        throw error;  // Let API layer handle the interrupt
      }

      // Handle actual errors
      console.error("[COORDINATOR] Fatal error:", error);
      this.metrics.endTimer('total', false, { error: error.message });

      return {
        success: false,
        error: error.message,
        response: "I'm having trouble processing your request. Please try again."
      };
    }
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getCoordinator: (checkpointer = null) => {
    if (!instance) {
      instance = new Coordinator(checkpointer);
    }
    return instance;
  },
  // Clear instance for testing or when checkpointer changes
  clearCoordinatorInstance: () => {
    instance = null;
  },
  Coordinator
};

// Export graph for LangGraph Studio (async initialization)
// The CLI will await this Promise
module.exports.graph = (async () => {
  const { getCheckpointer } = require('../../core/state');
  const checkpointer = await getCheckpointer();
  const coordinator = new Coordinator(checkpointer);
  return coordinator.graph;
})();
