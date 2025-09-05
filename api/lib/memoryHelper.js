const { Mem0Client } = require('./mem0Client');

class MemoryHelper {
  constructor() {
    this.mem0 = new Mem0Client();
  }

  // Create user ID from session and org
  getUserId(sessionId, orgId) {
    return `${sessionId}_${orgId}`;
  }

  // Add conversation to memory (Mem0 handles extraction automatically)
  async saveConversation(messages, sessionId, orgId) {
    const userId = this.getUserId(sessionId, orgId);
    
    try {
      // Mem0 Cloud automatically extracts relevant memories
      const result = await this.mem0.addMemory(messages, userId, {
        org_id: orgId,
        session_id: sessionId,
        timestamp: new Date().toISOString()
      });
      
      return result;
    } catch (error) {
      console.error('[MemoryHelper] Error saving conversation:', error);
      return null;
    }
  }

  // Get relevant memories for context
  async getRelevantMemories(query, sessionId, orgId, limit = 5) {
    const userId = this.getUserId(sessionId, orgId);
    
    try {
      const memories = await this.mem0.searchMemories(query, userId, limit);
      
      // Format memories for prompt context
      if (memories && memories.length > 0) {
        return memories.map(m => m.memory).join('\n');
      }
      
      return '';
    } catch (error) {
      console.error('[MemoryHelper] Error getting memories:', error);
      return '';
    }
  }

  // Get all memories for a user
  async getAllMemories(sessionId, orgId) {
    const userId = this.getUserId(sessionId, orgId);
    return await this.mem0.getMemories(userId);
  }

  // Clear all memories for a user
  async clearMemories(sessionId, orgId) {
    const userId = this.getUserId(sessionId, orgId);
    return await this.mem0.deleteAllMemories(userId);
  }
}

module.exports = { MemoryHelper };