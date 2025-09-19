/**
 * Memory Synthesis Node
 * 
 * Extracts and stores important facts from conversations
 * Uses LLM to identify memorable information and stores with appropriate metadata
 */

const crypto = require('crypto');
const { ChatOpenAI } = require('@langchain/openai');
const { z } = require('zod');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
// Note: PgMemoryStore import removed - now using UnifiedStore from config

// Memory item schema for structured extraction
const MemoryItemSchema = z.object({
  text: z.string().min(10).max(500).describe("The specific fact or information to remember"),
  kind: z.enum(["fact", "preference", "instruction", "context"]).describe("The type of memory"),
  importance: z.number().min(1).max(5).describe("Importance score from 1 (trivial) to 5 (critical)"),
  subjectId: z.string().nullable().describe("Related entity ID if applicable (contact, company, etc)")
});

const MemoryBatchSchema = z.object({
  memories: z.array(MemoryItemSchema).max(10),
  reasoning: z.string().describe("Brief explanation of why these memories were selected")
});

// TTL configuration by memory type (in days)
const TTL_BY_KIND = {
  instruction: 365,  // Standing orders last a year
  preference: 180,   // User preferences last 6 months
  fact: 90,         // General facts last 3 months
  context: 30       // Temporary context lasts 1 month
};

// Default configuration
const DEFAULT_CONFIG = {
  messagesLookback: 8,        // How many messages to analyze
  synthesisInterval: 5,        // Synthesize every N turns
  minImportance: 2,           // Minimum importance to store
  dedupeThreshold: 0.9,       // Similarity threshold for duplicates
  maxMemoriesPerBatch: 10,    // Max memories to extract at once
  enableAutoSynthesis: true   // Auto-synthesize vs manual only
};

/**
 * Format messages for the extraction prompt
 * @param {Array} messages - Array of message objects
 * @returns {string} Formatted conversation text
 */
function formatConversation(messages) {
  if (!messages || messages.length === 0) {
    return "";
  }
  
  const formatted = messages.map(msg => {
    // Determine role
    let role = 'Unknown';
    if (msg.constructor?.name === 'HumanMessage' || msg._getType?.() === 'human' || msg.role === 'user' || msg.role === 'human') {
      role = 'User';
    } else if (msg.constructor?.name === 'AIMessage' || msg._getType?.() === 'ai' || msg.role === 'assistant') {
      role = 'Assistant';
    } else if (msg.constructor?.name === 'SystemMessage' || msg._getType?.() === 'system' || msg.role === 'system') {
      role = 'System';
    }
    
    return `${role}: ${msg.content}`;
  }).join('\n\n');
  
  return formatted;
}

/**
 * Build the extraction prompt
 * @param {string} conversation - Formatted conversation text
 * @param {Array} existingMemories - Recent memories for deduplication
 * @returns {string} Complete prompt for the LLM
 */
function buildExtractionPrompt(conversation, existingMemories = []) {
  const existingText = existingMemories.length > 0
    ? existingMemories.map(m => `- ${m.value.text}`).join('\n')
    : "None";
  
  return `Analyze this conversation and extract important information to remember for future interactions.

Focus on extracting:
1. User preferences and requirements (e.g., "prefers morning meetings", "likes detailed reports")
2. Important facts about people, companies, or projects (e.g., "ABC Corp is a key client", "Project deadline is Q2")
3. Standing instructions for future interactions (e.g., "always include zoom links", "CC Sarah on emails")
4. Context that would be helpful in future conversations (e.g., "working on migration project", "has a team of 5")

For each memory, determine:
- kind: "fact" (objective information), "preference" (user likes/dislikes), "instruction" (how to do things), or "context" (situational info)
- importance: 1 (trivial) to 5 (critical)
- subjectId: entity ID if the memory is about a specific contact/company (optional)

Guidelines:
- Extract specific, actionable information
- Avoid temporary information (like "today's weather" or "current time")
- Don't duplicate these existing memories:
${existingText}
- Focus on information that would improve future interactions
- Keep each memory concise and clear

Conversation to analyze:
${conversation}`;
}

/**
 * Deduplicate memories against existing ones
 * @param {Array} newMemories - Memories to check
 * @param {PgMemoryStore} store - Memory store instance
 * @param {Array} namespace - Namespace for memories
 * @returns {Array} Deduplicated memories
 */
async function deduplicateMemories(newMemories, store, namespace) {
  const deduplicated = [];
  
  for (const memory of newMemories) {
    try {
      // Search for similar memories
      const similar = await store.search(namespace, {
        query: memory.text,
        limit: 3,
        minImportance: 1
      });
      
      // Check if any are too similar
      const isDuplicate = similar.some(s => s.score > DEFAULT_CONFIG.dedupeThreshold);
      
      if (!isDuplicate) {
        deduplicated.push(memory);
        console.log(`[MEMORY:SYNTHESIZE] New memory: "${memory.text.substring(0, 50)}..."`);
      } else {
        // Found duplicate, check if we should update importance
        const existing = similar[0];
        if (memory.importance > existing.value.importance) {
          console.log(`[MEMORY:SYNTHESIZE] Updating importance of existing memory from ${existing.value.importance} to ${memory.importance}`);
          await store.put(namespace, existing.key, {
            ...existing.value,
            importance: memory.importance
          });
        } else {
          console.log(`[MEMORY:SYNTHESIZE] Skipping duplicate: "${memory.text.substring(0, 50)}..."`);
        }
      }
    } catch (error) {
      console.error(`[MEMORY:SYNTHESIZE] Error checking duplicates:`, error.message);
      // If deduplication fails, include the memory anyway
      deduplicated.push(memory);
    }
  }
  
  return deduplicated;
}

/**
 * Store memories with appropriate TTLs and metadata
 * @param {Array} memories - Memories to store
 * @param {PgMemoryStore} store - Memory store instance
 * @param {Array} namespace - Namespace for memories
 * @returns {Array} Stored memory details
 */
async function storeMemories(memories, store, namespace) {
  const stored = [];
  
  for (const memory of memories) {
    try {
      const ttlDays = TTL_BY_KIND[memory.kind] || 90;
      
      // Generate key since put() no longer returns it (Store API compliance)
      const key = crypto.randomUUID();
      
      await store.put(
        namespace,
        key,
        {
          text: memory.text,
          kind: memory.kind,
          subjectId: memory.subjectId || null,
          importance: memory.importance
        },
        {
          ttlDays,
          source: "synthesis",
          index: true // Create embeddings for semantic search
        }
      );
      
      stored.push({
        key,
        ...memory,
        ttlDays
      });
      
      console.log(`[MEMORY:SYNTHESIZE] Stored: [${memory.kind}] "${memory.text.substring(0, 50)}..." (importance: ${memory.importance}, TTL: ${ttlDays} days)`);
      
    } catch (error) {
      console.error(`[MEMORY:SYNTHESIZE] Failed to store memory:`, error.message);
    }
  }
  
  return stored;
}

/**
 * Check if synthesis should run based on configuration
 * @param {Object} state - Current state
 * @param {Object} config - Configuration
 * @returns {boolean} Whether to run synthesis
 */
function shouldSynthesize(state, config) {
  const synthConfig = { ...DEFAULT_CONFIG, ...config?.configurable?.synthesis };
  
  if (!synthConfig.enableAutoSynthesis) {
    return false;
  }
  
  // Check if enough messages have accumulated
  const messageCount = state.messages?.length || 0;
  if (messageCount < 2) {
    return false;
  }
  
  // Check if it's time based on interval
  const lastSynthesis = state.artifacts?.lastSynthesisTurn || 0;
  const currentTurn = state.artifacts?.turnCount || messageCount;
  
  if (currentTurn - lastSynthesis >= synthConfig.synthesisInterval) {
    return true;
  }
  
  // Check if an important action was completed
  if (state.artifacts?.actionsCompleted?.length > 0) {
    return true;
  }
  
  return false;
}

/**
 * Memory synthesis node for LangGraph
 * Extracts and stores important information from conversations
 * 
 * @param {Object} state - The graph state
 * @param {Object} config - Configuration including org/user context
 * @returns {Object} Updated state with synthesis results
 */
async function synthesizeMemoryNode(state, config) {
  console.log("[MEMORY:SYNTHESIZE] Starting memory synthesis...");
  
  try {
    // Check if synthesis should run
    if (!shouldSynthesize(state, config)) {
      console.log("[MEMORY:SYNTHESIZE] Skipping synthesis (conditions not met)");
      return {};
    }
    
    // Extract configuration
    const orgId = config?.configurable?.orgId || state?.userContext?.orgId;
    const userId = config?.configurable?.userId || state?.userContext?.userId;
    
    if (!orgId || !userId) {
      console.log("[MEMORY:SYNTHESIZE] Missing org/user context, skipping synthesis");
      return {};
    }
    
    // Get synthesis configuration
    const synthConfig = { ...DEFAULT_CONFIG, ...config?.configurable?.synthesis };
    
    // Get UnifiedStore from config
    const store = config?.configurable?.store;
    if (!store) {
      console.warn("[MEMORY:SYNTHESIZE] No store in config, skipping memory synthesis");
      return {};
    }
    
    const namespace = [orgId, userId, "memories"];
    
    // Get recent messages to analyze
    const messages = state.messages || [];
    const recentMessages = messages.slice(-synthConfig.messagesLookback);
    
    if (recentMessages.length < 2) {
      console.log("[MEMORY:SYNTHESIZE] Not enough messages to synthesize");
      return {};
    }
    
    // Format conversation for analysis
    const conversation = formatConversation(recentMessages);
    
    // Get recent memories for deduplication context
    const recentMemories = await store.search(namespace, {
      query: conversation.substring(0, 200), // Use beginning of conversation as query
      limit: 10,
      minImportance: 1
    });
    
    console.log(`[MEMORY:SYNTHESIZE] Analyzing ${recentMessages.length} messages with ${recentMemories.length} existing memories for context`);
    
    // Initialize LLM with structured output
    const llm = new ChatOpenAI({
      model: config?.configurable?.synthesisModel || "gpt-4o-mini",
      temperature: 0.2,
      openAIApiKey: process.env.OPENAI_API_KEY
    });
    
    const extractionChain = llm.withStructuredOutput(MemoryBatchSchema);
    
    // Build and execute extraction prompt
    const prompt = buildExtractionPrompt(conversation, recentMemories);
    
    console.log("[MEMORY:SYNTHESIZE] Extracting memories with LLM...");
    const extraction = await extractionChain.invoke([
      new SystemMessage("You are a memory extraction specialist. Extract important information from conversations that should be remembered for future interactions."),
      new HumanMessage(prompt)
    ]);
    
    console.log(`[MEMORY:SYNTHESIZE] LLM extracted ${extraction.memories.length} memories: ${extraction.reasoning}`);
    
    if (extraction.memories.length === 0) {
      console.log("[MEMORY:SYNTHESIZE] No new memories to store");
      return {
        artifacts: {
          ...state.artifacts,
          lastSynthesisTurn: state.artifacts?.turnCount || state.messages?.length || 0
        }
      };
    }
    
    // Filter by minimum importance
    const importantMemories = extraction.memories.filter(
      m => m.importance >= synthConfig.minImportance
    );
    
    if (importantMemories.length < extraction.memories.length) {
      console.log(`[MEMORY:SYNTHESIZE] Filtered to ${importantMemories.length} memories with importance >= ${synthConfig.minImportance}`);
    }
    
    // Deduplicate against existing memories
    const deduplicated = await deduplicateMemories(importantMemories, store, namespace);
    
    console.log(`[MEMORY:SYNTHESIZE] ${deduplicated.length} memories after deduplication`);
    
    // Store the memories
    const stored = await storeMemories(deduplicated, store, namespace);
    
    console.log(`[MEMORY:SYNTHESIZE] Successfully stored ${stored.length} new memories`);
    
    // Return updated state with synthesis results
    return {
      artifacts: {
        ...state.artifacts,
        lastSynthesisTurn: state.artifacts?.turnCount || state.messages?.length || 0,
        synthesizedMemories: stored.map(m => ({
          key: m.key,
          text: m.text,
          kind: m.kind,
          importance: m.importance,
          ttlDays: m.ttlDays
        }))
      }
    };
    
  } catch (error) {
    console.error("[MEMORY:SYNTHESIZE] Error during memory synthesis:", error.message);
    // Don't fail the entire flow if synthesis fails
    return {
      artifacts: {
        ...state.artifacts,
        lastSynthesisTurn: state.artifacts?.turnCount || state.messages?.length || 0,
        synthesisError: error.message
      }
    };
  }
}

/**
 * Manual synthesis function for testing
 * @param {Array} messages - Messages to analyze
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @param {Object} options - Synthesis options (including optional store)
 * @returns {Array} Stored memories
 */
async function synthesizeMemories(messages, orgId, userId, options = {}) {
  const state = {
    messages,
    artifacts: { turnCount: messages.length }
  };
  
  // Use provided store or create one for backward compatibility
  let store = options.store;
  if (!store) {
    // Fallback for testing - import only when needed
    const { PgMemoryStore } = require('./storeAdapter');
    store = new PgMemoryStore(orgId, userId);
  }
  
  const config = {
    configurable: {
      orgId,
      userId,
      store,
      synthesis: { ...DEFAULT_CONFIG, ...options, enableAutoSynthesis: true }
    }
  };
  
  const result = await synthesizeMemoryNode(state, config);
  return result.artifacts?.synthesizedMemories || [];
}

module.exports = {
  synthesizeMemoryNode,
  synthesizeMemories,
  deduplicateMemories,
  storeMemories,
  buildExtractionPrompt,
  formatConversation,
  MemoryBatchSchema,
  TTL_BY_KIND,
  DEFAULT_CONFIG
};