/**
 * Polling Fallback for Interrupt Delivery
 * 
 * Used in production (Vercel) where WebSocket connections aren't supported.
 * Clients poll this service to check for pending interrupts.
 */

class InterruptPollingService {
  constructor() {
    this.pendingInterrupts = new Map(); // sessionId -> interrupt data
    this.approvalCallbacks = new Map(); // sessionId -> callback function
    this.cleanupInterval = null;
    
    // Start cleanup interval to remove old interrupts
    this.startCleanup();
  }

  /**
   * Store an interrupt for a session
   * @param {string} sessionId - Session ID
   * @param {Object} interruptData - Interrupt payload
   */
  storeInterrupt(sessionId, interruptData) {
    console.log(`[POLLING:INTERRUPTS] Storing interrupt for session: ${sessionId}`);
    
    const interrupt = {
      type: 'interrupt',
      timestamp: Date.now(),
      data: interruptData
    };
    
    this.pendingInterrupts.set(sessionId, interrupt);
  }

  /**
   * Check for pending interrupts (called by polling endpoint)
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Pending interrupt or null
   */
  checkPending(sessionId) {
    if (this.pendingInterrupts.has(sessionId)) {
      const interrupt = this.pendingInterrupts.get(sessionId);
      
      // Don't delete yet - wait for acknowledgment
      console.log(`[POLLING:INTERRUPTS] Found pending interrupt for session: ${sessionId}`);
      return interrupt;
    }
    
    return null;
  }

  /**
   * Acknowledge interrupt receipt
   * @param {string} sessionId - Session ID
   */
  acknowledgeInterrupt(sessionId) {
    console.log(`[POLLING:INTERRUPTS] Interrupt acknowledged by session: ${sessionId}`);
    this.pendingInterrupts.delete(sessionId);
  }

  /**
   * Handle approval response
   * @param {string} sessionId - Session ID
   * @param {Object} approvalData - Approval decision
   * @returns {Promise<Object>} Processing result
   */
  async handleApprovalResponse(sessionId, approvalData) {
    console.log(`[POLLING:INTERRUPTS] Approval response from ${sessionId}:`, approvalData);
    
    const callback = this.approvalCallbacks.get(sessionId);
    if (callback) {
      try {
        const result = await callback(approvalData);
        this.approvalCallbacks.delete(sessionId);
        return {
          success: true,
          message: 'Approval processed',
          result
        };
      } catch (error) {
        console.error('[POLLING:INTERRUPTS] Error processing approval:', error);
        return {
          success: false,
          message: 'Failed to process approval',
          error: error.message
        };
      }
    }
    
    return {
      success: false,
      message: 'No pending approval callback found'
    };
  }

  /**
   * Register approval callback
   * @param {string} sessionId - Session ID
   * @param {Function} callback - Callback to execute on approval
   */
  registerApprovalCallback(sessionId, callback) {
    console.log(`[POLLING:INTERRUPTS] Registering approval callback for session: ${sessionId}`);
    this.approvalCallbacks.set(sessionId, callback);
  }

  /**
   * Start cleanup interval to remove old interrupts
   */
  startCleanup() {
    // Clean up old interrupts every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const maxAge = 5 * 60 * 1000; // 5 minutes
      
      // Clean up old interrupts
      this.pendingInterrupts.forEach((interrupt, sessionId) => {
        if (now - interrupt.timestamp > maxAge) {
          console.log(`[POLLING:INTERRUPTS] Removing old interrupt for session: ${sessionId}`);
          this.pendingInterrupts.delete(sessionId);
        }
      });
      
      // Clean up old callbacks
      this.approvalCallbacks.forEach((callback, sessionId) => {
        if (!this.pendingInterrupts.has(sessionId)) {
          console.log(`[POLLING:INTERRUPTS] Removing orphaned callback for session: ${sessionId}`);
          this.approvalCallbacks.delete(sessionId);
        }
      });
      
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Stop cleanup interval
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get statistics
   * @returns {Object} Service statistics
   */
  getStats() {
    return {
      pendingInterrupts: this.pendingInterrupts.size,
      pendingCallbacks: this.approvalCallbacks.size,
      sessions: Array.from(this.pendingInterrupts.keys())
    };
  }

  /**
   * Clear all data for a session
   * @param {string} sessionId - Session ID
   */
  clearSession(sessionId) {
    console.log(`[POLLING:INTERRUPTS] Clearing data for session: ${sessionId}`);
    this.pendingInterrupts.delete(sessionId);
    this.approvalCallbacks.delete(sessionId);
  }

  /**
   * Shutdown the service
   */
  shutdown() {
    console.log('[POLLING:INTERRUPTS] Shutting down polling service');
    this.stopCleanup();
    this.pendingInterrupts.clear();
    this.approvalCallbacks.clear();
  }
}

// Create singleton instance
let instance = null;

module.exports = {
  getInterruptPollingService: () => {
    if (!instance) {
      instance = new InterruptPollingService();
    }
    return instance;
  },
  InterruptPollingService
};