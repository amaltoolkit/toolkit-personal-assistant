// Intent classification node
// Classifies user messages into help_kb, action, or mixed categories

const { z } = require("zod");

// Define the intent schema
const IntentSchema = z.object({
  kind: z.enum(["help_kb", "action", "mixed"]).describe("The classified intent type")
});

/**
 * Intent classification node
 * Determines whether the user wants help/information (help_kb),
 * wants to perform actions (action), or both (mixed)
 * 
 * @param {Object} state - Graph state containing messages
 * @param {Object} config - Runtime configuration
 * @returns {Object} Updated state with intent classification
 */
async function intentNode(state, config) {
  console.log("[INTENT] Starting intent classification");
  
  try {
    // Dynamic import for ESM module
    const { ChatOpenAI } = await import("@langchain/openai");
    
    // Get the last user message
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    if (!lastMessage || lastMessage.role !== "human") {
      console.log("[INTENT] No user message found, defaulting to action");
      return { intent: "action", messages: state.messages };
    }
    
    const userQuery = String(lastMessage.content || "");
    console.log(`[INTENT] Classifying query: "${userQuery.substring(0, 100)}..."`);
    
    // Initialize the model with structured output
    const model = new ChatOpenAI({
      model: "gpt-4o-mini",
      temperature: 0,
      openAIApiKey: process.env.OPENAI_API_KEY
    });
    
    const structuredModel = model.withStructuredOutput(IntentSchema);
    
    // Create the classification prompt
    const classificationPrompt = `Classify the following user request into one of these categories:
    
- help_kb: The user is asking "how to" questions, seeking information, documentation, or guidance
- action: The user wants to create, update, or perform actions (workflows, tasks, appointments)
- mixed: The user both wants information AND wants to perform actions

User request: "${userQuery}"

Examples:
- "How do I create a workflow?" → help_kb
- "Create a workflow for client onboarding" → action  
- "Show me how to create workflows and then create one for onboarding" → mixed
- "What are the best practices for task management?" → help_kb
- "Schedule a meeting for tomorrow at 3pm" → action`;
    
    // Get the classification
    const result = await structuredModel.invoke(classificationPrompt);
    
    console.log(`[INTENT] Classified as: ${result.kind}`);
    
    return { 
      messages: state.messages,
      intent: result.kind,
      userContext: {
        ...state.userContext,
        lastQuery: userQuery
      }
    };
    
  } catch (error) {
    console.error("[INTENT] Error during classification:", error.message);
    // Default to action on error
    return { intent: "action", messages: state.messages };
  }
}

/**
 * Helper function to determine if the graph should proceed to planning
 * @param {Object} state - Current graph state
 * @returns {Array} Array of next node names
 */
function routeByIntent(state) {
  const intent = state.intent;
  
  console.log(`[INTENT:ROUTE] Routing based on intent: ${intent}`);
  
  switch(intent) {
    case "help_kb":
      // Route to knowledge base retrieval
      return ["kb_retrieve"];
    
    case "action":
      // Route to planning
      return ["plan"];
    
    case "mixed":
      // Route to both KB and planning (parallel)
      return ["kb_retrieve", "plan"];
    
    default:
      // Default to planning
      return ["plan"];
  }
}

module.exports = {
  intentNode,
  routeByIntent,
  IntentSchema
};