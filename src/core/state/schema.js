// Graph state definition
// This module defines the application state schema

// Module-level cache for AppState singleton
let AppState = null;

/**
 * Define the application state schema
 * This is created once and reused across all graph invocations
 */
async function getAppState() {
  if (AppState) return AppState;
  
  // Dynamic import for ESM modules
  const { Annotation, MessagesAnnotation } = await import("@langchain/langgraph");
  
  // Define state schema with all necessary fields
  AppState = Annotation.Root({
    // Inherit message handling from MessagesAnnotation
    ...MessagesAnnotation.spec,
    
    // Plan: Array of actions with dependencies (DAG)
    plan: Annotation({ 
      default: () => [],
      reducer: (old, new_) => new_ // Replace plan entirely
    }),
    
    // Cursor: Current position in plan execution
    cursor: Annotation({ 
      default: () => 0,
      reducer: (old, new_) => new_
    }),
    
    // Previews: Accumulated design previews for approval
    previews: Annotation({ 
      default: () => [], 
      reducer: (old, new_) => {
        // Deduplicate previews by actionId to prevent exponential growth
        const byId = new Map();
        for (const p of old || []) {
          if (p?.actionId) byId.set(p.actionId, p);
        }
        for (const p of new_ || []) {
          if (p?.actionId) byId.set(p.actionId, p);
        }
        return Array.from(byId.values());
      }
    }),
    
    // Approvals: User decisions on previews
    approvals: Annotation({ 
      default: () => null,
      reducer: (old, new_) => new_ // Replace approvals
    }),
    
    // Artifacts: Persistent data across nodes (e.g., created IDs)
    artifacts: Annotation({ 
      default: () => ({}),
      reducer: (old, new_) => {
        // Deep merge with special handling for arrays
        const merged = { ...old, ...new_ };

        // Merge doneIds as a set (union of completed actions)
        // BUT if new explicitly sets empty array, respect that (plan reset)
        if (new_?.doneIds !== undefined) {
          if (new_.doneIds.length === 0) {
            // Explicitly clearing doneIds (new plan)
            merged.doneIds = [];
          } else {
            // Merge with existing
            const doneSet = new Set([...(old?.doneIds || []), ...(new_.doneIds || [])]);
            merged.doneIds = Array.from(doneSet);
          }
        } else if (old?.doneIds) {
          // Keep existing if not specified in new
          merged.doneIds = old.doneIds;
        }

        // Merge failedActions by actionId (deduplicate failures)
        const failMap = new Map();
        for (const f of old?.failedActions || []) {
          if (f?.actionId) failMap.set(f.actionId, f);
        }
        for (const f of new_?.failedActions || []) {
          if (f?.actionId) failMap.set(f.actionId, f);
        }
        if (failMap.size) merged.failedActions = Array.from(failMap.values());

        return merged;
      }
    }),
    
    // Intent: Classified user intent (help_kb, action, mixed)
    intent: Annotation({ 
      default: () => null,
      reducer: (old, new_) => new_
    }),
    
    // KB: Knowledge base query results
    kb: Annotation({ 
      default: () => null,
      reducer: (old, new_) => new_
    }),
    
    // Interrupt marker for approval detection
    interruptMarker: Annotation({ 
      default: () => null,
      reducer: (old, new_) => new_
    }),
    
    // User context
    userContext: Annotation({
      default: () => ({
        timezone: "UTC",
        orgId: null,
        userId: null
      }),
      reducer: (old, new_) => ({ ...old, ...new_ })
    })
  });
  
  console.log("[STATE] AppState schema initialized");
  return AppState;
}

// Re-export checkpointer and store from their respective modules
const { getCheckpointer } = require('./checkpointer');
const { getUnifiedStore } = require('./store');

/**
 * Get or create the UnifiedStore for all memory operations
 * This bridges InMemoryStore (dev) and PgMemoryStore (production)
 * 
 * @param {Object} config - Optional configuration with orgId/userId
 * @returns {UnifiedStore} Store instance for memory operations
 */
async function getStore(config = {}) {
  // Extract org/user context from config if provided
  const orgId = config?.orgId || process.env.DEFAULT_ORG_ID || null;
  const userId = config?.userId || process.env.DEFAULT_USER_ID || null;
  
  const storeConfig = {
    orgId,
    userId,
    isDev: process.env.NODE_ENV === 'development',
    debug: process.env.DEBUG === 'true'
  };
  
  const store = getUnifiedStore(storeConfig);
  
  console.log("[STATE] UnifiedStore ready - bridging InMemoryStore and PgMemoryStore");
  console.log("[STATE] PgMemoryStore provides persistent memory with vector search");
  console.log("[STATE] InMemoryStore provides development fallback");
  
  return store;
}

/**
 * Helper to create embeddings for manual vector operations
 */
async function createEmbedding(text) {
  try {
    const { OpenAIEmbeddings } = await import("@langchain/openai");
    
    const embeddings = new OpenAIEmbeddings({ 
      model: "text-embedding-3-small",
      openAIApiKey: process.env.OPENAI_API_KEY
    });
    
    const vector = await embeddings.embedQuery(text);
    return vector;
    
  } catch (error) {
    console.error("[STATE] Failed to create embedding:", error);
    throw error;
  }
}

/**
 * Clear cached instances (useful for testing)
 */
function clearCache() {
  const { clearCheckpointerCache } = require('./checkpointer');
  const { clearStoreCache } = require('./store');
  
  clearCheckpointerCache();
  AppState = null;
  clearStoreCache();
  console.log("[STATE] Cache cleared");
}

module.exports = {
  getAppState,
  getCheckpointer,
  getStore,
  createEmbedding,
  clearCache
};