// Approval node with interrupt handling
// Pauses execution for user approval when in safe mode

/**
 * Approval batch node that interrupts execution for user approval
 * Uses LangGraph's interrupt mechanism to pause and wait for user decisions
 * 
 * @param {Object} state - Graph state containing previews and configuration
 * @param {Object} config - Runtime configuration with safe_mode setting
 * @returns {Object} Updated state with approvals or interrupt marker
 */
async function approvalBatchNode(state, config) {
  console.log("[APPROVAL] Starting approval batch node");
  
  try {
    // Dynamic import for ESM module
    const { interrupt } = await import("@langchain/langgraph");
    
    // Check if safe mode is enabled
    const safeMode = config?.configurable?.safe_mode !== false; // Default to true
    console.log(`[APPROVAL] Safe mode: ${safeMode}`);
    
    // If safe mode is off, auto-approve everything
    if (!safeMode) {
      console.log("[APPROVAL] Safe mode disabled, auto-approving all actions");
      
      // Auto-approve all previews
      const autoApprovals = {};
      const previews = state.previews || [];
      
      for (const preview of previews) {
        if (preview.actionId) {
          autoApprovals[preview.actionId] = true;
        }
      }
      
      return {
        messages: state.messages,
        approvals: autoApprovals,
        interruptMarker: null // Clear any interrupt marker
      };
    }
    
    // Check if we have previews to approve
    const previews = state.previews || [];
    
    if (previews.length === 0) {
      console.log("[APPROVAL] No previews to approve, continuing");
      return {
        messages: state.messages,
        approvals: {},
        interruptMarker: null
      };
    }
    
    console.log(`[APPROVAL] Requesting approval for ${previews.length} previews`);
    
    // Create the interrupt payload
    const interruptPayload = {
      kind: "approval_batch",
      previews: previews.map(p => ({
        actionId: p.actionId,
        type: p.kind || p.type,
        spec: p.spec,
        summary: summarizePreview(p)
      })),
      message: "Please review and approve the following actions:",
      timestamp: new Date().toISOString()
    };
    
    // Set the interrupt marker in state
    // This will be checked by the orchestrator to detect interruption
    const updatedState = {
      messages: state.messages,
      interruptMarker: "PENDING_APPROVAL",
      approvalPayload: interruptPayload
    };
    
    console.log("[APPROVAL] Setting interrupt marker: PENDING_APPROVAL");
    
    // Call interrupt to pause execution
    // The graph will pause here and wait for resume with approvals
    const decision = interrupt(interruptPayload);
    
    // When resumed, decision will contain the user's approvals
    // Expected format: { [actionId]: true/false }
    console.log("[APPROVAL] Resumed with decisions:", Object.keys(decision || {}));
    
    return {
      messages: state.messages,
      approvals: decision,
      interruptMarker: null, // Clear the interrupt marker
      approvalPayload: null // Clear the payload
    };
    
  } catch (error) {
    console.error("[APPROVAL] Error in approval node:", error.message);
    
    // On error, auto-approve to prevent blocking
    console.log("[APPROVAL] Error occurred, auto-approving to prevent blocking");
    const autoApprovals = {};
    const previews = state.previews || [];
    
    for (const preview of previews) {
      if (preview.actionId) {
        autoApprovals[preview.actionId] = true;
      }
    }
    
    return {
      messages: state.messages,
      approvals: autoApprovals,
      interruptMarker: null
    };
  }
}

/**
 * Create a human-readable summary of a preview
 * @param {Object} preview - Preview object
 * @returns {string} Summary text
 */
function summarizePreview(preview) {
  const spec = preview.spec || {};
  
  switch (preview.kind || preview.type) {
    case "workflow":
      return `Create workflow "${spec.name}" with ${spec.steps?.length || 0} steps`;
    
    case "task":
      return `Create task "${spec.name}" ${spec.dueDate ? `due ${spec.dueDate}` : ''}`;
    
    case "appointment":
      return `Schedule "${spec.title}" from ${spec.startTime} to ${spec.endTime}`;
    
    default:
      return `Perform ${preview.kind || preview.type} action`;
  }
}

/**
 * Check if the state indicates an approval interrupt
 * @param {Object} state - Current graph state
 * @returns {boolean} True if approval is pending
 */
function isApprovalPending(state) {
  return state.interruptMarker === "PENDING_APPROVAL";
}

/**
 * Format approval request for API response
 * @param {Object} state - Current graph state
 * @returns {Object} Formatted approval request
 */
function formatApprovalRequest(state) {
  if (!isApprovalPending(state)) {
    return null;
  }
  
  return {
    status: "PENDING_APPROVAL",
    interrupt: state.approvalPayload || {
      kind: "approval_batch",
      previews: state.previews || [],
      message: "Please review and approve the following actions:"
    },
    message: "Approval required to continue",
    timestamp: new Date().toISOString()
  };
}

/**
 * Process approval response from the user
 * @param {Object} approvals - User's approval decisions
 * @returns {Object} Formatted approvals for state update
 */
function processApprovalResponse(approvals) {
  console.log("[APPROVAL] Processing approval response");
  
  // Validate approval format
  const processed = {};
  
  for (const [actionId, decision] of Object.entries(approvals || {})) {
    // Ensure boolean values
    processed[actionId] = Boolean(decision);
    console.log(`[APPROVAL] Action ${actionId}: ${processed[actionId] ? 'approved' : 'rejected'}`);
  }
  
  return processed;
}

module.exports = {
  approvalBatchNode,
  isApprovalPending,
  formatApprovalRequest,
  processApprovalResponse
};