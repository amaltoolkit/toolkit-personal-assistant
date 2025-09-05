const axios = require('axios');

class Mem0Client {
  constructor() {
    this.baseURL = 'https://api.mem0.ai/v1';
    this.apiKey = process.env.MEM0_API_KEY;
    
    if (!this.apiKey) {
      console.warn('[Mem0Client] No API key found. Memory features will be disabled.');
    }
    
    // Create axios instance with default config
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 10000,
      headers: {
        'Authorization': `Token ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      error => {
        if (error.response?.status === 401) {
          console.error('[Mem0Client] Authentication failed. Check your API key.');
        }
        return Promise.reject(error);
      }
    );
  }

  // Add memories from conversation
  async addMemory(messages, userId, metadata = {}) {
    if (!this.apiKey) return { success: false, message: 'No API key' };
    
    try {
      const response = await this.client.post('/memories/', {
        messages,
        user_id: userId,
        metadata
      });
      
      console.log(`[Mem0Client] Added ${response.data.results?.length || 0} memories for user ${userId}`);
      return response.data;
    } catch (error) {
      console.error('[Mem0Client] Error adding memory:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  // Search memories with semantic search
  async searchMemories(query, userId, limit = 5) {
    if (!this.apiKey) return [];
    
    try {
      const response = await this.client.post('/memories/search/', {
        query,
        user_id: userId,
        limit
      });
      
      return response.data.results || [];
    } catch (error) {
      console.error('[Mem0Client] Error searching memories:', error.response?.data || error.message);
      return [];
    }
  }

  // Get all memories for a user
  async getMemories(userId, limit = 100) {
    if (!this.apiKey) return [];
    
    try {
      // Note: The GET /memories endpoint is deprecated
      // Using search without query to get all memories
      const response = await this.client.post('/memories/search/', {
        user_id: userId,
        limit,
        query: '' // Empty query returns all memories
      });
      
      return response.data.results || [];
    } catch (error) {
      console.error('[Mem0Client] Error getting memories:', error.response?.data || error.message);
      return [];
    }
  }

  // Get specific memory by ID
  async getMemory(memoryId) {
    if (!this.apiKey) return null;
    
    try {
      const response = await this.client.get(`/memories/${memoryId}/`);
      return response.data;
    } catch (error) {
      console.error('[Mem0Client] Error getting memory:', error.response?.data || error.message);
      return null;
    }
  }

  // Update a memory
  async updateMemory(memoryId, data) {
    if (!this.apiKey) return { success: false, message: 'No API key' };
    
    try {
      const response = await this.client.put(`/memories/${memoryId}/`, { data });
      return response.data;
    } catch (error) {
      console.error('[Mem0Client] Error updating memory:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  // Delete a specific memory
  async deleteMemory(memoryId) {
    if (!this.apiKey) return { success: false, message: 'No API key' };
    
    try {
      const response = await this.client.delete(`/memories/${memoryId}/`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('[Mem0Client] Error deleting memory:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  // Delete all memories for a user
  async deleteAllMemories(userId) {
    if (!this.apiKey) return { success: false, message: 'No API key' };
    
    try {
      const response = await this.client.delete('/memories/', {
        params: { user_id: userId }
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('[Mem0Client] Error deleting all memories:', error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  // Get memory history
  async getMemoryHistory(memoryId) {
    if (!this.apiKey) return [];
    
    try {
      const response = await this.client.get(`/memories/${memoryId}/history/`);
      return response.data.results || [];
    } catch (error) {
      console.error('[Mem0Client] Error getting memory history:', error.response?.data || error.message);
      return [];
    }
  }
}

module.exports = { Mem0Client };