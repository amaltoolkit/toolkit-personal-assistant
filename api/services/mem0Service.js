/**
 * Mem0 Service - Wrapper for Mem0 Cloud API
 * 
 * Provides intelligent memory extraction and recall using Mem0's cloud service.
 * This replaces our custom memory implementation (UnifiedStore/PgMemoryStore)
 * while keeping PostgresSaver for state management.
 */

const { MemoryClient } = require('mem0ai');

class Mem0Service {
  constructor() {
    if (!process.env.MEM0_API_KEY) {
      console.warn('[MEM0] No API key found, memory features disabled');
      this.client = null;
    } else {
      // MemoryClient expects an object with apiKey property
      this.client = new MemoryClient({ apiKey: process.env.MEM0_API_KEY });
      this.retryConfig = {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 10000
      };
      console.log('[MEM0] Service initialized with API key');
    }
  }
  
  /**
   * Recall relevant memories based on a query
   * @param {string} query - The search query
   * @param {string} orgId - Organization ID
   * @param {string} userId - User ID
   * @param {Object} options - Search options
   * @returns {Array} Array of relevant memories
   */
  async recall(query, orgId, userId, options = {}) {
    if (!this.client) return [];
    
    const memoryId = `${orgId}:${userId}`;
    
    try {
      const results = await this.retryWithBackoff(async () => {
        return await this.client.search(query, { 
          user_id: memoryId,
          limit: options.limit || 5,
          threshold: options.threshold || 0.7
        });
      });
      
      console.log(`[MEM0:RECALL] Found ${results.length} memories for query: "${query.substring(0, 50)}..."`);
      
      // Transform to match our existing format
      return results.map(r => ({
        key: r.id,
        score: r.score,
        value: {
          text: r.memory,
          kind: r.metadata?.kind || 'fact',
          importance: r.metadata?.importance || 3,
          subjectId: r.metadata?.subjectId,
          createdAt: r.created_at
        }
      }));
    } catch (error) {
      console.error('[MEM0:RECALL] Error:', error.message);
      return [];
    }
  }
  
  /**
   * Synthesize and store memories from conversation
   * @param {Array} messages - Conversation messages
   * @param {string} orgId - Organization ID
   * @param {string} userId - User ID
   * @param {Object} metadata - Additional metadata
   * @returns {Object|null} Storage result
   */
  async synthesize(messages, orgId, userId, metadata = {}) {
    if (!this.client) return null;
    
    const memoryId = `${orgId}:${userId}`;
    
    try {
      const result = await this.retryWithBackoff(async () => {
        return await this.client.add(messages, {
          user_id: memoryId,
          metadata: {
            ...metadata,
            orgId,
            userId,
            timestamp: new Date().toISOString()
          }
        });
      });
      
      console.log(`[MEM0:SYNTHESIZE] Stored ${result.results?.length || 1} memories`);
      return result;
    } catch (error) {
      console.error('[MEM0:SYNTHESIZE] Error:', error.message);
      return null;
    }
  }
  
  /**
   * Retry function with exponential backoff
   * @private
   */
  async retryWithBackoff(fn) {
    let lastError;
    let delay = this.retryConfig.initialDelay;
    
    for (let i = 0; i < this.retryConfig.maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        // Check if error is retryable
        if (error.response?.status >= 500 || error.code === 'ECONNRESET') {
          console.log(`[MEM0] Retry ${i + 1}/${this.retryConfig.maxRetries} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, this.retryConfig.maxDelay);
        } else {
          // Non-retryable error
          throw error;
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * Get user's memory history
   * @param {string} orgId - Organization ID
   * @param {string} userId - User ID
   * @param {number} limit - Maximum number of memories to retrieve
   * @returns {Array} Memory history
   */
  async getHistory(orgId, userId, limit = 50) {
    if (!this.client) return [];
    
    const memoryId = `${orgId}:${userId}`;
    
    try {
      const history = await this.client.getAll({
        user_id: memoryId,
        limit
      });
      
      return history.map(h => ({
        id: h.id,
        memory: h.memory,
        metadata: h.metadata,
        createdAt: h.created_at
      }));
    } catch (error) {
      console.error('[MEM0:HISTORY] Error:', error.message);
      return [];
    }
  }
  
  /**
   * Delete a specific memory
   * @param {string} memoryId - Memory ID to delete
   * @returns {boolean} Success status
   */
  async deleteMemory(memoryId) {
    if (!this.client) return false;
    
    try {
      await this.client.delete(memoryId);
      console.log(`[MEM0:DELETE] Removed memory ${memoryId}`);
      return true;
    } catch (error) {
      console.error('[MEM0:DELETE] Error:', error.message);
      return false;
    }
  }
  
  /**
   * Format memories as a system message for context
   * @param {Array} memories - Array of memory objects
   * @returns {string|null} Formatted context string
   */
  formatAsSystemMessage(memories) {
    if (!memories || memories.length === 0) return null;
    
    const context = memories
      .map(m => `- ${m.value.text}`)
      .join('\n');
    
    return `Based on previous interactions:\n${context}`;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getMem0Service: () => {
    if (!instance) {
      instance = new Mem0Service();
    }
    return instance;
  },
  Mem0Service // Export class for testing
};