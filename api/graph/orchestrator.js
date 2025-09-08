// Main orchestrator that wires all graph nodes together
// Builds and compiles the LangGraph with proper routing and parallelism

// Module-level cache for compiled graph (singleton pattern)
let compiledGraph = null;

// Import state management
const { getAppState, getCheckpointer, getStore } = require("./state");

// Import existing nodes
const { intentNode, routeByIntent } = require("./intent");
const { planNode } = require("./plan");
const { approvalBatchNode, isApprovalPending } = require("./approval");
const { responseFinalizerNode } = require("./response");
const { fanOutDesign, fanOutApply, routeAfterApply, markActionDone, allActionsDone } = require("./parallel");

// Import memory nodes (Phase 3, Step 5)
const { recallMemoryNode } = require("../memory/recall");
const { synthesizeMemoryNode } = require("../memory/synthesize");

// Import designer/applier agents (Phase 3, Steps 2-4)
const { design_build_workflow } = require("../agents/workflowDesigner");
const { apply_build_workflow } = require("../agents/workflowApplier");
const { design_create_task } = require("../agents/taskDesigner");
const { apply_create_task } = require("../agents/taskApplier");
const { design_create_appointment } = require("../agents/appointmentDesigner");
const { apply_create_appointment } = require("../agents/appointmentApplier");

/**
 * Stub KB retrieve node (to be implemented in Phase 4)
 * Will eventually search knowledge base for relevant documents
 */
async function kbRetrieveNode(state, config) {
  console.log("[KB:RETRIEVE] Stub - no KB search yet");
  return { 
    kb: { 
      chunks: [],
      query: state.messages?.[state.messages.length - 1]?.content || ""
    } 
  };
}

/**
 * Stub KB answer node (to be implemented in Phase 4)
 * Will eventually generate answers from KB chunks
 */
async function kbAnswerNode(state, config) {
  console.log("[KB:ANSWER] Stub - returning placeholder answer");
  return { 
    kb: { 
      answer: "This feature will search the knowledge base for answers to your questions.",
      citations: [],
      chunks: state.kb?.chunks || []
    }
  };
}

/**
 * Coordination node to handle mixed intent completion
 * Ensures both KB and action paths complete before finalizing
 */
async function coordinationJoinNode(state, config) {
  console.log("[COORDINATION] Checking completion status...");
  
  const intent = state.intent;
  const kbComplete = state.kb?.answer != null;
  const actionsComplete = allActionsDone(state);
  const hasActions = state.plan && state.plan.length > 0;
  
  // Check if all actions were rejected (zero-approval path)
  const approvals = state.approvals || {};
  const hasApprovals = Object.keys(approvals).length > 0;
  const allRejected = hasApprovals && Object.values(approvals).every(v => v === false);
  
  console.log(`[COORDINATION] Intent: ${intent}, KB complete: ${kbComplete}, Actions complete: ${actionsComplete}`);
  if (allRejected) {
    console.log("[COORDINATION] All actions were rejected - treating as complete");
  }
  
  // For help_kb only - finalize when KB is done
  if (intent === "help_kb") {
    console.log("[COORDINATION] KB-only query, ready to finalize");
    return { 
      readyToFinalize: true,
      coordinationComplete: true 
    };
  }
  
  // For action only - finalize when actions are done OR all rejected
  if (intent === "action") {
    const ready = allRejected || !hasActions || actionsComplete;
    console.log(`[COORDINATION] Action-only query, ready: ${ready}`);
    return { 
      readyToFinalize: ready,
      coordinationComplete: ready
    };
  }
  
  // For mixed - need both to complete (KB done AND actions done/rejected)
  if (intent === "mixed") {
    const actionsOk = allRejected || !hasActions || actionsComplete;
    const ready = kbComplete && actionsOk;
    console.log(`[COORDINATION] Mixed query, KB: ${kbComplete}, Actions OK: ${actionsOk}, Ready: ${ready}`);
    return {
      readyToFinalize: ready,
      coordinationComplete: ready,
      kbComplete,
      actionsComplete: actionsOk
    };
  }
  
  // Default case
  return { 
    readyToFinalize: true,
    coordinationComplete: true
  };
}

// Workflow, task, and appointment designers/appliers are imported above

/**
 * Stub task update designer node
 */
async function design_update_task(state, config) {
  console.log("[DESIGN:TASK:UPDATE] Stub - generating mock task update preview");
  const action = state.action || state;
  
  return {
    previews: [{
      actionId: action.id || "mock-id",
      kind: "task",
      type: "update_task",
      spec: {
        taskId: "existing-task-id",
        updates: {
          status: "Completed"
        }
      }
    }]
  };
}


/**
 * Stub appointment update designer node
 */
async function design_update_appointment(state, config) {
  console.log("[DESIGN:APPOINTMENT:UPDATE] Stub - generating mock appointment update preview");
  const action = state.action || state;
  
  return {
    previews: [{
      actionId: action.id || "mock-id",
      kind: "appointment",
      type: "update_appointment",
      spec: {
        appointmentId: "existing-appointment-id",
        updates: {
          startTime: new Date(Date.now() + 172800000).toISOString()
        }
      }
    }]
  };
}

/**
 * Additional stub designers for other action types
 */
async function design_search_contacts(state, config) {
  console.log("[DESIGN:CONTACTS] Stub - mock contact search");
  return {
    previews: [{
      actionId: state.action?.id || "mock-id",
      kind: "search",
      type: "search_contacts",
      spec: { query: "search query", limit: 10 }
    }]
  };
}

async function design_get_calendar(state, config) {
  console.log("[DESIGN:CALENDAR] Stub - mock calendar fetch");
  return {
    previews: [{
      actionId: state.action?.id || "mock-id",
      kind: "fetch",
      type: "get_calendar",
      spec: { startDate: new Date().toISOString(), days: 7 }
    }]
  };
}

async function design_analyze_data(state, config) {
  console.log("[DESIGN:ANALYZE] Stub - mock data analysis");
  return {
    previews: [{
      actionId: state.action?.id || "mock-id",
      kind: "analysis",
      type: "analyze_data",
      spec: { dataSource: "mock", analysisType: "summary" }
    }]
  };
}

// apply_build_workflow imported from workflowApplier.js

// apply_create_task imported from taskApplier.js

/**
 * Stub task update applier node
 */
async function apply_update_task(state, config) {
  console.log("[APPLY:TASK:UPDATE] Stub - marking task as updated");
  const action = state.action || state;
  
  return markActionDone(state, action.id || "mock-id");
}

// apply_create_appointment imported from appointmentApplier.js

/**
 * Stub appointment update applier node
 */
async function apply_update_appointment(state, config) {
  console.log("[APPLY:APPOINTMENT:UPDATE] Stub - marking appointment as updated");
  const action = state.action || state;
  
  return markActionDone(state, action.id || "mock-id");
}

/**
 * Additional stub appliers
 */
async function apply_search_contacts(state, config) {
  console.log("[APPLY:CONTACTS] Stub - returning mock contacts");
  return markActionDone(state, state.action?.id || "mock-id");
}

async function apply_get_calendar(state, config) {
  console.log("[APPLY:CALENDAR] Stub - returning mock calendar");
  return markActionDone(state, state.action?.id || "mock-id");
}

async function apply_analyze_data(state, config) {
  console.log("[APPLY:ANALYZE] Stub - returning mock analysis");
  return markActionDone(state, state.action?.id || "mock-id");
}


/**
 * Build and compile the main orchestrator graph
 * Uses singleton pattern - builds once and caches
 * 
 * @returns {Promise<CompiledGraph>} The compiled LangGraph
 */
async function buildGraph() {
  // Return cached graph if already built
  if (compiledGraph) {
    console.log("[ORCHESTRATOR] Returning cached graph");
    return compiledGraph;
  }
  
  console.log("[ORCHESTRATOR] Building new graph...");
  
  try {
    // Dynamic imports for ESM modules
    const { StateGraph, START, END } = await import("@langchain/langgraph");
    
    // Get state and persistence layers
    const AppState = await getAppState();
    const checkpointer = await getCheckpointer();
    const store = await getStore();
    
    console.log("[ORCHESTRATOR] Creating StateGraph with AppState");
    
    // Build the graph
    const g = new StateGraph(AppState)
      // Memory nodes
      .addNode("recall_memory", recallMemoryNode)
      .addNode("synthesize_memory", synthesizeMemoryNode)
      
      // Core logic nodes (renamed to avoid conflict with state attributes)
      .addNode("intent_classifier", intentNode)  // Renamed from "intent"
      .addNode("planner", planNode)  // Renamed from "plan"
      .addNode("fanOutDesign", fanOutDesign)
      .addNode("approval_batch", approvalBatchNode)
      .addNode("fanOutApply", fanOutApply)
      .addNode("response_finalizer", responseFinalizerNode)
      
      // Knowledge base nodes
      .addNode("kb_retrieve", kbRetrieveNode)
      .addNode("kb_answer", kbAnswerNode)
      
      // Coordination node for mixed intent
      .addNode("coordination_join", coordinationJoinNode)
      
      // Designer nodes (all action types)
      .addNode("design_build_workflow", design_build_workflow)
      .addNode("design_create_task", design_create_task)
      .addNode("design_update_task", design_update_task)
      .addNode("design_create_appointment", design_create_appointment)
      .addNode("design_update_appointment", design_update_appointment)
      .addNode("design_search_contacts", design_search_contacts)
      .addNode("design_get_calendar", design_get_calendar)
      .addNode("design_analyze_data", design_analyze_data)
      
      // Applier nodes (all action types)
      .addNode("apply_build_workflow", apply_build_workflow)
      .addNode("apply_create_task", apply_create_task)
      .addNode("apply_update_task", apply_update_task)
      .addNode("apply_create_appointment", apply_create_appointment)
      .addNode("apply_update_appointment", apply_update_appointment)
      .addNode("apply_search_contacts", apply_search_contacts)
      .addNode("apply_get_calendar", apply_get_calendar)
      .addNode("apply_analyze_data", apply_analyze_data);
    
    console.log("[ORCHESTRATOR] Adding edges...");
    
    // Add edges for main flow
    g.addEdge(START, "recall_memory")
      .addEdge("recall_memory", "intent_classifier");
    
    // Conditional routing based on intent
    g.addConditionalEdges("intent_classifier", (state) => {
      const routes = routeByIntent(state);
      console.log(`[ORCHESTRATOR] Intent routing to: ${routes.join(", ")}`);
      // Map the route names to actual node names
      return routes.map(route => {
        if (route === "plan") return "planner";
        return route;
      });
    });
    
    // Knowledge base path
    g.addEdge("kb_retrieve", "kb_answer");
    
    // Route KB answer through coordination to prevent early termination
    g.addEdge("kb_answer", "coordination_join");
    
    // Action path
    g.addEdge("planner", "fanOutDesign");
    // Note: fanOutDesign uses Send for dynamic routing, no direct edge needed
    
    // Add edges from all designer nodes to approval_batch
    g.addEdge("design_build_workflow", "approval_batch")
      .addEdge("design_create_task", "approval_batch")
      .addEdge("design_update_task", "approval_batch")
      .addEdge("design_create_appointment", "approval_batch")
      .addEdge("design_update_appointment", "approval_batch")
      .addEdge("design_search_contacts", "approval_batch")
      .addEdge("design_get_calendar", "approval_batch")
      .addEdge("design_analyze_data", "approval_batch");
    
    // Conditional edge after approval
    g.addConditionalEdges("approval_batch", (state) => {
      if (state.interruptMarker === "PENDING_APPROVAL") {
        console.log("[ORCHESTRATOR] Approval pending, going to response");
        return "response_finalizer";
      }
      console.log("[ORCHESTRATOR] Approvals received, proceeding to apply");
      return "fanOutApply";
    });
    
    // Add edges from all applier nodes to a convergence point
    // We'll create a simple passthrough node for this
    g.addNode("apply_convergence", (state) => {
      console.log("[ORCHESTRATOR] Apply convergence point reached");
      // Use the shared markActionDone to properly track completion
      const actionId = state.action?.id || state.actionId;
      if (actionId) {
        return markActionDone(state, actionId);
      }
      return {};
    });
    
    // Connect all applier nodes to convergence
    g.addEdge("apply_build_workflow", "apply_convergence")
      .addEdge("apply_create_task", "apply_convergence")
      .addEdge("apply_update_task", "apply_convergence")
      .addEdge("apply_create_appointment", "apply_convergence")
      .addEdge("apply_update_appointment", "apply_convergence")
      .addEdge("apply_search_contacts", "apply_convergence")
      .addEdge("apply_get_calendar", "apply_convergence")
      .addEdge("apply_analyze_data", "apply_convergence");
    
    // After convergence, check if more actions or finalize
    g.addConditionalEdges("apply_convergence", (state) => {
      const next = routeAfterApply(state);
      console.log(`[ORCHESTRATOR] After apply, routing to: ${next}`);
      return next;
    });
    
    // fanOutApply no longer needs conditional edges since Send handles routing
    
    // Memory synthesis after actions complete - route to coordination
    g.addEdge("synthesize_memory", "coordination_join");
    
    // Coordination decides when to finalize
    g.addConditionalEdges("coordination_join", (state) => {
      if (state.readyToFinalize || state.coordinationComplete) {
        console.log("[ORCHESTRATOR] Coordination complete, moving to finalizer");
        return "response_finalizer";
      }
      // Should never reach here - all paths should set readyToFinalize
      console.log("[ORCHESTRATOR] ERROR: Coordination not ready, forcing completion");
      return "response_finalizer"; // Force completion instead of looping
    });
    
    // Final response always goes to END
    g.addEdge("response_finalizer", END);
    
    console.log("[ORCHESTRATOR] Compiling graph...");
    
    // Compile with persistence and concurrency limits
    compiledGraph = g.compile({
      checkpointer,
      store,
      maxConcurrency: 3 // Limit parallel branches for BSA API
    });
    
    console.log("[ORCHESTRATOR] Graph compiled successfully");
    
    return compiledGraph;
    
  } catch (error) {
    console.error("[ORCHESTRATOR] Failed to build graph:", error);
    throw error;
  }
}

/**
 * Clear the cached graph (useful for testing or updates)
 */
function clearGraphCache() {
  compiledGraph = null;
  console.log("[ORCHESTRATOR] Graph cache cleared");
}

module.exports = {
  buildGraph,
  clearGraphCache
};