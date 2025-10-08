// PostgreSQL checkpointer for conversation state persistence
// Extracted from schema.js for better modularity

let checkpointerInstance = null;

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
    
    console.log("[CHECKPOINTER] Creating PostgresSaver checkpointer...");
    checkpointerInstance = PostgresSaver.fromConnString(process.env.POSTGRES_CONNECTION_STRING);
    
    // Note: setup() should have been run via the setup script
    // If not, uncomment the line below for first-time setup:
    // await checkpointerInstance.setup();
    
    console.log("[CHECKPOINTER] Checkpointer ready");
    return checkpointerInstance;
    
  } catch (error) {
    console.error("[CHECKPOINTER] Failed to create checkpointer:", error);
    throw error;
  }
}

/**
 * Clear checkpointer cache (useful for testing)
 */
function clearCheckpointerCache() {
  checkpointerInstance = null;
  console.log("[CHECKPOINTER] Cache cleared");
}

module.exports = {
  getCheckpointer,
  clearCheckpointerCache
};

