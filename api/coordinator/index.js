/**
 * Coordinator - Lightweight Orchestrator for V2 Architecture
 * 
 * Replaces the complex monolithic orchestrator with a streamlined coordinator
 * that routes queries to specialized domain subgraphs.
 */

const { StateGraph, END, interrupt } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { getMem0Service } = require("../services/mem0Service");
const { getPassKeyManager } = require("../services/passKeyManager");
const { getErrorHandler } = require("../services/errorHandler");
const { getPerformanceMetrics } = require("./metrics");
const { createExecutionPlan, validateExecutionPlan } = require("../services/planner");

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
    value: (x, y) => y ? y : x,
    default: () => ({})
  },
  entities: {
    value: (x, y) => y ? y : x,
    default: () => ({})
  },
  final_response: {
    value: (x, y) => y ? y : x,
    default: () => ""
  },
  error: {
    value: (x, y) => y ? y : x,
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
    this.checkpointer = checkpointer;
    
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
    workflow.addNode("finalize_response", this.finalizeResponse.bind(this));
    workflow.addNode("handle_error", this.handleError.bind(this));

    // Define edges
    workflow.setEntryPoint("recall_memory");
    
    workflow.addEdge("recall_memory", "route_domains");
    
    workflow.addConditionalEdges(
      "route_domains",
      (state) => {
        if (state.error) return "handle_error";
        if (!state.domains || state.domains.length === 0) return "finalize_response";
        return "execute_subgraphs";
      },
      {
        "handle_error": "handle_error",
        "finalize_response": "finalize_response",
        "execute_subgraphs": "execute_subgraphs"
      }
    );
    
    workflow.addEdge("execute_subgraphs", "finalize_response");
    workflow.addEdge("finalize_response", END);
    workflow.addEdge("handle_error", END);

    // Compile with checkpointer if available
    const compileOptions = {};
    if (this.checkpointer) {
      compileOptions.checkpointer = this.checkpointer;
      console.log("[COORDINATOR] Compiling graph with checkpointer");
    }

    return workflow.compile(compileOptions);
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
        memory_context: memoryContext
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
      // Use the lightweight planner to analyze and create execution plan
      const executionPlan = createExecutionPlan(
        lastMessage.content,
        state.memory_context
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
        execution_plan: executionPlan
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
      if (state.approval_decision && state.pendingApproval) {
        console.log("[COORDINATOR:EXECUTOR] Resuming with approval decision:", state.approval_decision);

        const { domain, results: previousResults, stepIndex } = state.pendingApproval;

        // Restore previous results
        results = previousResults || {};

        // We'll continue execution from the domain that requested approval
        // The approval_decision will be passed to the subgraph
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
            // Pass approval decision if resuming
            ...(state.approval_decision && state.pendingApproval?.domain === domain ? {
              approval_decision: state.approval_decision
            } : {})
          };

          // Create config for subgraph with unique namespace
          // Use same thread_id as parent for interrupt propagation
          // Namespace provides isolation to prevent checkpoint conflicts
          const subgraphConfig = {
            configurable: {
              ...config.configurable,
              // Unique namespace for this subgraph's checkpoints
              checkpoint_ns: `${domain}_subgraph`
              // Keep parent's thread_id for interrupt propagation
            }
          };

          // Execute subgraph and handle interrupts
          try {
            const result = await subgraph.invoke(subgraphState, subgraphConfig);

            // Enhanced debug logging to understand result structure
            console.log(`[COORDINATOR:EXECUTOR] ${domain} subgraph returned:`, {
              hasResult: !!result,
              resultType: typeof result,
              resultKeys: result ? Object.keys(result).slice(0, 10) : [], // First 10 keys to avoid log overflow
              requiresApproval: result?.requiresApproval,
              hasApprovalContext: !!result?.approvalContext,
              // Check if result might be wrapped
              hasValue: !!result?.value,
              valueRequiresApproval: result?.value?.requiresApproval
            });

            // Check if subgraph is requesting approval
            // Handle both direct state and potentially wrapped state
            const state = result?.value || result;
            if (state && state.requiresApproval) {
              console.log(`[COORDINATOR:EXECUTOR] Approval requested from ${domain} subgraph - using interrupt()`);

              // Use the proper interrupt function from LangGraph
              throw interrupt({
                value: {
                  ...state.approvalContext,
                  domain: domain
                }
              });
            }

            // Ensure result is not undefined
            return {
              domain,
              result: result || { error: `${domain} subgraph returned no result` }
            };
          } catch (error) {
            // Re-throw interrupts to propagate to parent graph
            if (error && error.name === 'GraphInterrupt') {
              console.log(`[COORDINATOR:EXECUTOR] Interrupt exception from ${domain} subgraph - propagating to parent`);
              // Add domain info to interrupt for context
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
        
        for (const step of execution_plan.sequential) {
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
            // Pass approval decision if resuming
            ...(state.approval_decision && state.pendingApproval?.domain === step.domain ? {
              approval_decision: state.approval_decision
            } : {})
          };

          // Create unique config for subgraph to avoid checkpoint conflicts
          // Each subgraph gets its own namespace to prevent deadlocks
          // Use same thread_id as parent for interrupt propagation
          const subgraphConfig = {
            configurable: {
              ...config.configurable,
              // Unique namespace for this subgraph's checkpoints
              checkpoint_ns: `${step.domain}_subgraph`
              // Keep parent's thread_id for interrupt propagation
            }
          };

          // Execute subgraph and handle interrupts
          try {
            const result = await subgraph.invoke(subgraphState, subgraphConfig);

            // Debug logging for sequential execution
            console.log(`[COORDINATOR:EXECUTOR] ${step.domain} subgraph returned:`, {
              hasResult: !!result,
              requiresApproval: result?.requiresApproval,
              valueRequiresApproval: result?.value?.requiresApproval
            });

            // Check if subgraph is requesting approval (handle both direct and wrapped state)
            const stateResult = result?.value || result;
            if (stateResult && stateResult.requiresApproval) {
              console.log(`[COORDINATOR:EXECUTOR] Approval requested from ${step.domain} subgraph - using interrupt()`);

              // Store the domain and partial results for resume
              state.pendingApproval = {
                domain: step.domain,
                results: results,
                stepIndex: execution_plan.sequential.indexOf(step)
              };

              // Use proper interrupt function
              throw interrupt({
                value: {
                  ...stateResult.approvalContext,
                  domain: step.domain
                }
              });
            }

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
      
      console.log("[COORDINATOR:EXECUTOR] Subgraph execution complete");
      
      return {
        ...state,
        subgraph_results: results
      };
      
    } catch (error) {
      console.error("[COORDINATOR:EXECUTOR] Error executing subgraphs:", error);
      return {
        ...state,
        error: `Failed to execute subgraphs: ${error.message}`
      };
    }
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
      // Dynamically import subgraph
      const subgraphModule = require(`../subgraphs/${domain}`);

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
      // If no subgraphs were executed, provide a simple response
      if (!state.subgraph_results || Object.keys(state.subgraph_results).length === 0) {
        const lastMessage = state.messages[state.messages.length - 1];
        
        // Use LLM to generate a response
        const response = await this.llm.invoke(`
          User query: "${lastMessage.content}"
          ${state.memory_context?.recalled_memories ? 
            `Context: ${JSON.stringify(state.memory_context.recalled_memories[0]?.content || '')}` : ''}
          
          Provide a helpful response.
        `);
        
        return {
          ...state,
          final_response: response.content
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
        
        // Store the interaction in memory
        if (this.mem0.client && state.org_id && state.user_id) {
          const messages = [
            ...state.messages,
            { role: "assistant", content: finalResponse }
          ];
          
          await this.mem0.synthesize(
            messages,
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
          final_response: finalResponse
        };
      }
      
      return {
        ...state,
        final_response: "I couldn't process your request. Please try again."
      };
      
    } catch (error) {
      console.error("[COORDINATOR:FINALIZER] Error finalizing response:", error);
      return {
        ...state,
        error: `Failed to generate response: ${error.message}`
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

    // Prepare initial state
    const initialState = {
      messages: [
        { role: "user", content: query }
      ],
      org_id: context.org_id,
      user_id: context.user_id,
      session_id: context.session_id,
      thread_id: context.thread_id,
      checkpoint_id: context.checkpoint_id,
      timezone: context.timezone || 'UTC'
    };

    try {
      // Create config with thread_id for checkpointer (REQUIRED by LangGraph)
      const config = {
        configurable: {
          thread_id: context.thread_id || `${context.session_id}:${context.org_id}`,
          checkpoint_ns: "" // Default namespace
        }
      };

      // Execute the coordinator graph WITH config (critical for checkpointer)
      const result = await this.graph.invoke(initialState, config);

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