/**
 * Memory Recall Node
 * 
 * Retrieves relevant memories at the start of each conversation turn
 * Uses semantic search to find the most contextually relevant memories
 */

const { PgMemoryStore } = require('./storeAdapter');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

/**
 * Format memories into a system message for context
 * @param {Array} memories - Array of memory objects from search
 * @returns {string} Formatted context string
 */
function formatMemoriesAsContext(memories) {
  if (!memories || memories.length === 0) {
    return null;
  }
  
  // Group memories by kind for better organization
  const grouped = {
    instruction: [],
    preference: [],
    fact: [],
    context: []
  };
  
  memories.forEach(memory => {
    const kind = memory.value?.kind || 'fact';
    if (grouped[kind]) {
      grouped[kind].push(memory);
    }
  });
  
  // Build context sections
  const sections = [];
  
  // Instructions are most important
  if (grouped.instruction.length > 0) {
    sections.push("Standing Instructions:");
    grouped.instruction.forEach(m => {
      sections.push(`- ${m.value.text}`);
    });
  }
  
  // User preferences
  if (grouped.preference.length > 0) {
    sections.push("\nUser Preferences:");
    grouped.preference.forEach(m => {
      sections.push(`- ${m.value.text}`);
    });
  }
  
  // Important facts
  if (grouped.fact.length > 0) {
    sections.push("\nRelevant Facts:");
    grouped.fact.forEach(m => {
      sections.push(`- ${m.value.text}`);
    });
  }
  
  // Context from previous conversations
  if (grouped.context.length > 0) {
    sections.push("\nPrevious Context:");
    grouped.context.forEach(m => {
      sections.push(`- ${m.value.text}`);
    });
  }
  
  return sections.join('\n');
}

/**
 * Extract the user's query from messages
 * @param {Array} messages - Array of message objects
 * @returns {string} The user's latest query
 */
function extractUserQuery(messages) {
  if (!messages || messages.length === 0) {
    return "";
  }
  
  // Find the last human message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    
    // Handle different message formats
    if (msg.constructor?.name === 'HumanMessage' || msg._getType?.() === 'human') {
      return msg.content || "";
    }
    
    // Check for role property (plain objects)
    if (msg.role === 'user' || msg.role === 'human') {
      return msg.content || "";
    }
  }
  
  // Fallback to last message content
  const lastMessage = messages[messages.length - 1];
  return lastMessage?.content || "";
}

/**
 * Memory recall node for LangGraph
 * Retrieves relevant memories based on the current conversation
 * 
 * @param {Object} state - The graph state
 * @param {Object} config - Configuration including org/user context
 * @returns {Object} Updated state with recalled memories
 */
async function recallMemoryNode(state, config) {
  console.log("[MEMORY:RECALL] Starting memory recall...");
  
  try {
    // Extract configuration
    const orgId = config?.configurable?.orgId || state?.userContext?.orgId;
    const userId = config?.configurable?.userId || state?.userContext?.userId;
    
    if (!orgId || !userId) {
      console.log("[MEMORY:RECALL] Missing org/user context, skipping recall");
      return {};
    }
    
    // Initialize memory store
    const store = new PgMemoryStore(orgId, userId);
    const namespace = [orgId, userId, "memories"];
    
    // Extract the user's query
    const userQuery = extractUserQuery(state.messages);
    
    if (!userQuery) {
      console.log("[MEMORY:RECALL] No user query found, skipping recall");
      return {};
    }
    
    console.log(`[MEMORY:RECALL] Searching for memories related to: "${userQuery.substring(0, 50)}..."`);
    
    // Search for relevant memories
    const searchOptions = {
      query: userQuery,
      limit: config?.configurable?.memoryLimit || 5,
      minImportance: config?.configurable?.minImportance || 2
    };
    
    const memories = await store.search(namespace, searchOptions);
    
    console.log(`[MEMORY:RECALL] Found ${memories.length} relevant memories`);
    
    if (memories.length === 0) {
      return {};
    }
    
    // Log retrieved memories for debugging
    memories.forEach((memory, i) => {
      console.log(`[MEMORY:RECALL]   ${i + 1}. [${memory.score.toFixed(3)}] ${memory.value.kind}: ${memory.value.text.substring(0, 60)}...`);
    });
    
    // Format memories as context
    const memoryContext = formatMemoriesAsContext(memories);
    
    if (!memoryContext) {
      return {};
    }
    
    // Create a system message with the memory context
    const systemMessage = new SystemMessage({
      content: `Based on previous interactions, here is relevant context:\n\n${memoryContext}\n\nPlease consider this context when responding.`
    });
    
    console.log("[MEMORY:RECALL] Memory recall complete, context added to messages");
    
    // Return updated state with memory context
    return {
      messages: [systemMessage],
      artifacts: {
        ...state.artifacts,
        recalledMemories: memories.map(m => ({
          text: m.value.text,
          kind: m.value.kind,
          importance: m.value.importance,
          score: m.score
        }))
      }
    };
    
  } catch (error) {
    console.error("[MEMORY:RECALL] Error during memory recall:", error.message);
    // Don't fail the entire flow if memory recall fails
    return {};
  }
}

/**
 * Simplified recall function for testing
 * @param {string} query - The query to search for
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @param {Object} options - Search options
 * @returns {Array} Array of memories
 */
async function recallMemories(query, orgId, userId, options = {}) {
  const store = new PgMemoryStore(orgId, userId);
  const namespace = [orgId, userId, "memories"];
  
  const searchOptions = {
    query,
    limit: options.limit || 5,
    minImportance: options.minImportance || 2
  };
  
  return await store.search(namespace, searchOptions);
}

module.exports = {
  recallMemoryNode,
  recallMemories,
  formatMemoriesAsContext,
  extractUserQuery
};