// Parallel execution nodes for fan-out and fan-in
// Manages concurrent execution of independent actions

/**
 * Check which actions are ready to execute (dependencies satisfied)
 * @param {Object} state - Current graph state
 * @returns {Array} Array of actions ready to execute
 */
function ready(state) {
  const plan = state.plan || [];
  const doneIds = new Set(state.artifacts?.doneIds || []);
  
  console.log(`[PARALLEL:READY] Checking ready actions. Done: ${doneIds.size}, Total: ${plan.length}`);
  
  // Filter actions that:
  // 1. Are not already done
  // 2. Have all dependencies satisfied
  const readyActions = plan.filter(action => {
    // Skip if already done
    if (doneIds.has(action.id)) {
      return false;
    }
    
    // Check if all dependencies are satisfied
    const depsReady = action.dependsOn.every(depId => doneIds.has(depId));
    
    if (depsReady) {
      console.log(`[PARALLEL:READY] Action ${action.id} (${action.type}) is ready`);
    }
    
    return depsReady;
  });
  
  console.log(`[PARALLEL:READY] ${readyActions.length} actions ready for execution`);
  return readyActions;
}

/**
 * Fan-out node for parallel design phase
 * Sends ready actions to their respective designer nodes
 * 
 * @param {Object} state - Current graph state
 * @returns {Array} Array of Send objects for parallel execution
 */
async function fanOutDesign(state) {
  console.log("[PARALLEL:DESIGN] Starting fan-out for design phase");
  
  try {
    // Dynamic import for ESM module
    const { Send } = await import("@langchain/langgraph");
    
    // Get actions ready for design
    const readyActions = ready(state);
    
    if (readyActions.length === 0) {
      console.log("[PARALLEL:DESIGN] No actions ready for design");
      return {};
    }
    
    // Create Send objects for each ready action
    const sends = readyActions.map(action => {
      const nodeId = `design_${action.type}`;
      console.log(`[PARALLEL:DESIGN] Sending action ${action.id} to ${nodeId}`);
      
      // Create a Send object with the action in state
      return new Send(nodeId, {
        action: action,
        actionId: action.id,
        actionType: action.type,
        actionParams: action.params
      });
    });
    
    console.log(`[PARALLEL:DESIGN] Created ${sends.length} Send objects for parallel design`);
    return sends;
    
  } catch (error) {
    console.error("[PARALLEL:DESIGN] Error in fanOutDesign:", error.message);
    return {};
  }
}

/**
 * Fan-out node for parallel apply phase
 * Sends approved actions to their respective applier nodes
 * 
 * @param {Object} state - Current graph state
 * @returns {Array} Array of Send objects for parallel execution
 */
async function fanOutApply(state) {
  console.log("[PARALLEL:APPLY] Starting fan-out for apply phase");
  
  try {
    // Dynamic import for ESM module
    const { Send } = await import("@langchain/langgraph");
    
    // Get approvals
    const approvals = state.approvals || {};
    const approvedIds = new Set(
      Object.entries(approvals)
        .filter(([_, approved]) => approved)
        .map(([actionId, _]) => actionId)
    );
    
    console.log(`[PARALLEL:APPLY] ${approvedIds.size} actions approved`);
    
    if (approvedIds.size === 0) {
      console.log("[PARALLEL:APPLY] No actions approved for execution");
      return {};
    }
    
    // Get the approved actions from the plan
    const plan = state.plan || [];
    const approvedActions = plan.filter(action => approvedIds.has(action.id));
    
    // Create Send objects for each approved action
    const sends = approvedActions.map(action => {
      const nodeId = `apply_${action.type}`;
      console.log(`[PARALLEL:APPLY] Sending action ${action.id} to ${nodeId}`);
      
      // Find the corresponding preview
      const preview = (state.previews || []).find(p => p.actionId === action.id);
      
      return new Send(nodeId, {
        action: action,
        actionId: action.id,
        actionType: action.type,
        actionParams: action.params,
        preview: preview,
        spec: preview?.spec
      });
    });
    
    console.log(`[PARALLEL:APPLY] Created ${sends.length} Send objects for parallel execution`);
    return sends;
    
  } catch (error) {
    console.error("[PARALLEL:APPLY] Error in fanOutApply:", error.message);
    return {};
  }
}

/**
 * Mark an action as completed
 * @param {Object} state - Current graph state
 * @param {string} actionId - ID of completed action
 * @returns {Object} Updated artifacts with action marked as done
 */
function markActionDone(state, actionId) {
  const doneIds = new Set(state.artifacts?.doneIds || []);
  doneIds.add(actionId);
  
  console.log(`[PARALLEL:DONE] Marked action ${actionId} as complete. Total done: ${doneIds.size}`);
  
  return {
    messages: state.messages,
    artifacts: {
      ...state.artifacts,
      doneIds: Array.from(doneIds),
      lastCompleted: actionId,
      lastCompletedAt: new Date().toISOString()
    }
  };
}

/**
 * Check if all actions in the plan are complete
 * @param {Object} state - Current graph state
 * @returns {boolean} True if all actions are done
 */
function allActionsDone(state) {
  const plan = state.plan || [];
  const doneIds = new Set(state.artifacts?.doneIds || []);
  
  const allDone = plan.every(action => doneIds.has(action.id));
  
  console.log(`[PARALLEL:CHECK] ${doneIds.size}/${plan.length} actions complete. All done: ${allDone}`);
  
  return allDone;
}

/**
 * Get execution layers based on dependencies
 * Returns actions grouped by execution order
 * @param {Array} plan - Array of actions
 * @returns {Array} Array of layers, each containing parallel actions
 */
function getExecutionLayers(plan) {
  const layers = [];
  const processed = new Set();
  
  while (processed.size < plan.length) {
    const layer = [];
    
    for (const action of plan) {
      if (processed.has(action.id)) continue;
      
      // Check if all dependencies are processed
      const depsReady = action.dependsOn.every(depId => processed.has(depId));
      
      if (depsReady) {
        layer.push(action);
      }
    }
    
    if (layer.length === 0) {
      console.warn("[PARALLEL:LAYERS] Circular dependency detected or invalid plan");
      break;
    }
    
    // Mark layer actions as processed
    for (const action of layer) {
      processed.add(action.id);
    }
    
    layers.push(layer);
  }
  
  console.log(`[PARALLEL:LAYERS] Plan has ${layers.length} execution layers`);
  layers.forEach((layer, i) => {
    console.log(`  Layer ${i + 1}: ${layer.map(a => `${a.id}(${a.type})`).join(", ")}`);
  });
  
  return layers;
}

/**
 * Route based on whether there are more actions to process
 * @param {Object} state - Current graph state
 * @returns {string} Next node to execute
 */
function routeAfterApply(state) {
  if (allActionsDone(state)) {
    console.log("[PARALLEL:ROUTE] All actions complete, proceeding to memory synthesis");
    return "synthesize_memory";
  }
  
  // Check if there are more actions ready
  const moreReady = ready(state).length > 0;
  
  if (moreReady) {
    console.log("[PARALLEL:ROUTE] More actions ready, returning to design phase");
    return "fanOutDesign";
  }
  
  console.log("[PARALLEL:ROUTE] No more actions ready, proceeding to finalization");
  return "response_finalizer";
}

module.exports = {
  ready,
  fanOutDesign,
  fanOutApply,
  markActionDone,
  allActionsDone,
  getExecutionLayers,
  routeAfterApply
};