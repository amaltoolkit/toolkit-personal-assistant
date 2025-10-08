/**
 * ApprovalBatcher Service - V2 Architecture
 * Collects and batches approval requests from multiple subgraphs
 * Uses LangGraph's interrupt mechanism for human-in-the-loop approvals
 * Includes timeout handling for auto-rejection after 30 seconds
 */

class ApprovalBatcher {
  constructor() {
    this.defaultTimeout = 30000; // 30 seconds default timeout
    this.pendingApprovals = new Map(); // Track pending approvals with timestamps
  }
  /**
   * Collect previews from multiple subgraph results
   * @param {Object} subgraphResults - Results from domain subgraphs
   * @returns {Array} Array of previews needing approval
   */
  async collectPreviews(subgraphResults) {
    const previews = [];
    
    for (const [domain, result] of Object.entries(subgraphResults)) {
      // Check if this domain has a preview that needs approval
      if (result.preview && !result.approved) {
        previews.push({
          domain,
          id: result.preview.id || `${domain}_${Date.now()}`,
          type: result.preview.type,
          title: result.preview.title || result.preview.subject,
          description: result.preview.description || result.preview.summary,
          details: result.preview.details || [],
          warnings: result.preview.warnings || [],
          metadata: result.preview.metadata || {},
          // Pass through spec if it exists (for detailed rendering)
          spec: result.preview.spec || result.preview.details
        });
      }
    }
    
    console.log(`[APPROVAL:BATCH] Collected ${previews.length} previews for approval`);
    return previews;
  }

  /**
   * Present previews for user approval using LangGraph interrupt with timeout
   * @param {Array} previews - Array of previews to approve
   * @param {Object} options - Options including timeout
   * @returns {Promise<Object>} Approval decisions (never returns - throws interrupt)
   */
  async presentForApproval(previews, options = {}) {
    if (previews.length === 0) {
      console.log('[APPROVAL:BATCH] No previews to approve');
      return {};
    }

    // Import LangGraph interrupt (dynamic import for ESM)
    const { interrupt } = await import("@langchain/langgraph");
    
    const timeout = options.timeout || this.defaultTimeout;
    const approvalId = `approval_${Date.now()}`;
    
    console.log(`[APPROVAL:BATCH] Presenting ${previews.length} items for approval (timeout: ${timeout}ms)`);
    
    // Format previews for clear presentation
    const formattedPreviews = previews.map((p, i) => ({
      index: i + 1,
      id: p.id,
      actionId: p.id,  // UI expects actionId
      domain: p.domain,
      title: p.title,
      type: p.type,
      summary: this.formatPreviewSummary(p),
      details: p.details,
      warnings: p.warnings.length > 0 ? p.warnings : undefined,
      // Include spec for UI rendering if available
      spec: p.spec || {
        name: p.title,
        description: p.description || p.summary,
        details: p.details,
        warnings: p.warnings
      }
    }));
    
    // Track this approval request with timestamp
    this.pendingApprovals.set(approvalId, {
      previews: formattedPreviews,
      timestamp: Date.now(),
      timeout: timeout
    });
    
    // Schedule auto-rejection after timeout
    this.scheduleTimeout(approvalId, timeout);
    
    // Use LangGraph's interrupt mechanism
    // This will pause execution and wait for user response
    throw interrupt({
      value: {
        type: 'batch_approval',
        approvalId: approvalId,
        message: 'Please review the following actions:',
        previews: formattedPreviews,
        actions: {
          approve_all: 'Approve All',
          reject_all: 'Reject All',
          selective: 'Review Each'
        },
        metadata: {
          timestamp: new Date().toISOString(),
          count: previews.length,
          timeout: timeout,
          autoRejectAt: new Date(Date.now() + timeout).toISOString()
        }
      }
    });
  }
  
  /**
   * Schedule automatic rejection after timeout
   * @private
   */
  scheduleTimeout(approvalId, timeout) {
    setTimeout(() => {
      const pending = this.pendingApprovals.get(approvalId);
      if (pending) {
        console.log(`[APPROVAL:TIMEOUT] Auto-rejecting approval ${approvalId} after ${timeout}ms`);
        
        // Mark as timed out
        pending.timedOut = true;
        pending.autoRejected = true;
        
        // Could emit an event or callback here to notify the system
        // For now, the next check will see this status
      }
    }, timeout);
  }
  
  /**
   * Check if an approval has timed out
   * @param {string} approvalId - The approval ID to check
   * @returns {boolean} True if timed out
   */
  hasTimedOut(approvalId) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    
    const elapsed = Date.now() - pending.timestamp;
    return elapsed > pending.timeout || pending.timedOut === true;
  }
  
  /**
   * Handle timeout for approval decisions
   * @param {string} approvalId - The approval ID
   * @returns {Object} Auto-rejection decision
   */
  handleTimeout(approvalId) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return { action: 'reject_all', reason: 'Unknown approval ID' };
    }
    
    console.log(`[APPROVAL:TIMEOUT] Handling timeout for ${approvalId}`);
    
    // Clean up
    this.pendingApprovals.delete(approvalId);
    
    // Return auto-rejection
    return {
      action: 'reject_all',
      reason: 'Approval request timed out',
      timedOut: true,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Clear a pending approval (when user responds)
   * @param {string} approvalId - The approval ID to clear
   */
  clearPendingApproval(approvalId) {
    if (this.pendingApprovals.has(approvalId)) {
      console.log(`[APPROVAL:CLEAR] Clearing pending approval ${approvalId}`);
      this.pendingApprovals.delete(approvalId);
    }
  }

  /**
   * Format a preview into a readable summary
   * @private
   */
  formatPreviewSummary(preview) {
    switch (preview.type) {
      case 'appointment':
        return `Schedule "${preview.title}" on ${preview.metadata.date || 'TBD'}`;
      
      case 'task':
        return `Create task "${preview.title}" ${preview.metadata.dueDate ? `due ${preview.metadata.dueDate}` : ''}`;
      
      case 'workflow':
        return `Build workflow "${preview.title}" with ${preview.metadata.stepCount || 'multiple'} steps`;
      
      default:
        return preview.description || `${preview.type}: ${preview.title}`;
    }
  }

  /**
   * Distribute approval decisions back to subgraph results
   * @param {Object} approvals - User's approval decisions (or timeout)
   * @param {Object} subgraphResults - Original subgraph results
   * @returns {Object} Updated results with approval status
   */
  async distributeApprovals(approvals, subgraphResults) {
    const updatedResults = { ...subgraphResults };
    
    // Clear pending approval if approvalId provided
    if (approvals.approvalId) {
      this.clearPendingApproval(approvals.approvalId);
    }
    
    console.log('[APPROVAL:BATCH] Distributing approval decisions');
    
    // Handle timeout case
    if (approvals.timedOut) {
      console.log('[APPROVAL:BATCH] Handling timeout - auto-rejecting all actions');
      for (const domain of Object.keys(updatedResults)) {
        if (updatedResults[domain].preview) {
          updatedResults[domain].approved = false;
          updatedResults[domain].rejected = true;
          updatedResults[domain].rejectionReason = 'Approval request timed out';
          updatedResults[domain].timedOut = true;
        }
      }
      return updatedResults;
    }
    
    // Handle different approval formats
    if (approvals.action === 'approve_all') {
      console.log('[APPROVAL:BATCH] Approving all actions');
      for (const domain of Object.keys(updatedResults)) {
        if (updatedResults[domain].preview) {
          updatedResults[domain].approved = true;
          updatedResults[domain].approvalTimestamp = new Date().toISOString();
        }
      }
    } else if (approvals.action === 'reject_all') {
      console.log('[APPROVAL:BATCH] Rejecting all actions');
      for (const domain of Object.keys(updatedResults)) {
        if (updatedResults[domain].preview) {
          updatedResults[domain].approved = false;
          updatedResults[domain].rejected = true;
          updatedResults[domain].rejectionReason = 'User rejected all actions';
        }
      }
    } else if (approvals.selective) {
      console.log('[APPROVAL:BATCH] Processing selective approvals');
      // Handle individual approvals
      for (const [previewId, decision] of Object.entries(approvals.selective)) {
        // Find which domain this preview belongs to
        for (const [domain, result] of Object.entries(updatedResults)) {
          if (result.preview?.id === previewId) {
            if (typeof decision === 'boolean') {
              // Simple approve/reject
              updatedResults[domain].approved = decision;
              if (!decision) {
                updatedResults[domain].rejected = true;
              }
            } else if (typeof decision === 'object') {
              // Complex decision with refinement
              updatedResults[domain].approved = decision.approved;
              if (decision.refinement) {
                updatedResults[domain].refinementRequested = true;
                updatedResults[domain].refinementInstructions = decision.refinement;
              }
              if (decision.reason) {
                updatedResults[domain].decisionReason = decision.reason;
              }
            }
            updatedResults[domain].approvalTimestamp = new Date().toISOString();
            break;
          }
        }
      }
    }
    
    // Count approval stats
    let approved = 0;
    let rejected = 0;
    let refined = 0;
    
    for (const result of Object.values(updatedResults)) {
      if (result.approved) approved++;
      else if (result.rejected) rejected++;
      else if (result.refinementRequested) refined++;
    }
    
    console.log(`[APPROVAL:BATCH] Results: ${approved} approved, ${rejected} rejected, ${refined} need refinement`);
    
    return updatedResults;
  }

  /**
   * Handle refinement requests from user
   * @param {Object} refinements - User's refinement instructions
   * @param {Object} subgraphResults - Original subgraph results
   * @returns {Object} Instructions for subgraphs to regenerate
   */
  async processRefinements(refinements, subgraphResults) {
    const refinementInstructions = {};
    
    for (const [domain, instructions] of Object.entries(refinements)) {
      if (subgraphResults[domain]) {
        refinementInstructions[domain] = {
          originalPreview: subgraphResults[domain].preview,
          refinementInstructions: instructions,
          attemptNumber: (subgraphResults[domain].refinementAttempts || 0) + 1,
          maxAttempts: 3
        };
      }
    }
    
    console.log(`[APPROVAL:BATCH] Processing refinements for ${Object.keys(refinementInstructions).length} domains`);
    return refinementInstructions;
  }

  /**
   * Check if any previews need approval
   * @param {Object} subgraphResults - Results from domain subgraphs
   * @returns {boolean} True if approvals are needed
   */
  needsApproval(subgraphResults) {
    for (const result of Object.values(subgraphResults)) {
      if (result.preview && !result.approved && !result.rejected) {
        return true;
      }
    }
    return false;
  }

  /**
   * Generate approval summary for logging
   * @param {Object} approvals - Approval decisions
   * @returns {string} Summary text
   */
  generateApprovalSummary(approvals) {
    const lines = [];
    
    if (approvals.action === 'approve_all') {
      lines.push('All actions approved');
    } else if (approvals.action === 'reject_all') {
      lines.push('All actions rejected');
    } else if (approvals.selective) {
      const approved = [];
      const rejected = [];
      
      for (const [id, decision] of Object.entries(approvals.selective)) {
        if (decision === true || decision.approved === true) {
          approved.push(id);
        } else {
          rejected.push(id);
        }
      }
      
      if (approved.length > 0) {
        lines.push(`Approved: ${approved.join(', ')}`);
      }
      if (rejected.length > 0) {
        lines.push(`Rejected: ${rejected.join(', ')}`);
      }
    }
    
    return lines.join('\n');
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getApprovalBatcher: () => {
    if (!instance) {
      instance = new ApprovalBatcher();
    }
    return instance;
  },
  ApprovalBatcher // Export class for testing
};