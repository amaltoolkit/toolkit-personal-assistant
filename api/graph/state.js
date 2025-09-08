// Graph state definition with checkpointer and store
// This module defines the application state and persistence layer

// Module-level cache for singleton instances
let checkpointerInstance = null;
let storeInstance = null;
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
      reducer: (old, new_) => old.concat(new_) // Accumulate previews
    }),
    
    // Approvals: User decisions on previews
    approvals: Annotation({ 
      default: () => null,
      reducer: (old, new_) => new_ // Replace approvals
    }),
    
    // Artifacts: Persistent data across nodes (e.g., created IDs)
    artifacts: Annotation({ 
      default: () => ({}),
      reducer: (old, new_) => ({ ...old, ...new_ }) // Merge artifacts
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

/**
 * Get or create the PostgresSaver checkpointer
 * This manages conversation state persistence
 */
async function getCheckpointer() {
  if (checkpointerInstance) return checkpointerInstance;
  
  if (!process.env.POSTGRES_CONNECTION_STRING) {
    throw new Error("POSTGRES_CONNECTION_STRING environment variable is required");
  }
  
  try {
    const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
    
    console.log("[STATE] Creating PostgresSaver checkpointer...");
    checkpointerInstance = PostgresSaver.fromConnString(process.env.POSTGRES_CONNECTION_STRING);
    
    // Note: setup() should have been run via the setup script
    // If not, uncomment the line below for first-time setup:
    // await checkpointerInstance.setup();
    
    console.log("[STATE] Checkpointer ready");
    return checkpointerInstance;
    
  } catch (error) {
    console.error("[STATE] Failed to create checkpointer:", error);
    throw error;
  }
}

/**
 * Get or create the InMemoryStore for ephemeral per-process needs
 * For persistent long-term memory, we use PgMemoryStore adapter with ltm_memories table
 * When PostgresStore becomes available in JS, we can swap the implementation
 */
async function getStore() {
  if (storeInstance) return storeInstance;
  
  try {
    const { InMemoryStore } = await import("@langchain/langgraph");
    
    console.log("[STATE] Creating InMemoryStore for ephemeral storage...");
    
    storeInstance = new InMemoryStore();
    
    console.log("[STATE] InMemoryStore ready (ephemeral, per-process)");
    console.log("[STATE] Note: Persistent memory uses PgMemoryStore adapter with ltm_memories table");
    console.log("[STATE] This provides full vector search via pgvector");
    return storeInstance;
    
  } catch (error) {
    console.error("[STATE] Failed to create store:", error);
    throw error;
  }
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
  checkpointerInstance = null;
  storeInstance = null;
  AppState = null;
  console.log("[STATE] Cache cleared");
}

module.exports = {
  getAppState,
  getCheckpointer,
  getStore,
  createEmbedding,
  clearCache
};