// Conversational finalizer node
// Generates the final user-facing response with structured output

const { z } = require("zod");

// Define the response schema
// Note: OpenAI structured output requires all fields to be required at each level
// We handle optionality in the response generation logic
const ResponseSchema = z.object({
  message: z.string().describe("The main conversational response"),
  ui: z.object({
    actions: z.array(z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      status: z.enum(["planned", "waiting_approval", "completed", "failed"])
    })).describe("List of actions taken or planned"),
    citations: z.array(z.object({
      title: z.string(),
      url: z.string()
    })).describe("Citations from knowledge base")
  }).describe("UI elements to display"),
  followups: z.array(z.string()).length(3).describe("Exactly 3 follow-up questions")
});

/**
 * Response finalizer node that creates the final user-facing message
 * Generates a conversational response with structured UI elements
 * 
 * @param {Object} state - Graph state with results and context
 * @param {Object} config - Runtime configuration
 * @returns {Object} Updated state with final message
 */
async function responseFinalizerNode(state, config) {
  console.log("[RESPONSE] Starting response finalization");
  
  try {
    // Dynamic import for ESM module
    const { ChatOpenAI } = await import("@langchain/openai");
    
    // Initialize the model with structured output
    const model = new ChatOpenAI({
      model: process.env.LLM_FINALIZER || "gpt-4o-mini",
      temperature: 0.2,
      openAIApiKey: process.env.OPENAI_API_KEY
    });
    
    const structuredModel = model.withStructuredOutput(ResponseSchema);
    
    // Extract relevant information from state
    const lastUserMessage = getLastUserMessage(state);
    const isApprovalPending = state.interruptMarker === "PENDING_APPROVAL";
    const completedActions = state.artifacts?.doneIds || [];
    const previews = state.previews || [];
    const kbCitations = state.kb?.citations || [];
    const approvals = state.approvals || {};
    
    // Determine the tone and style
    const tone = config?.configurable?.tone || "direct, professional, no emojis, no em-dashes";
    
    // Build context for the response
    const context = buildResponseContext(state);
    
    // Create the response generation prompt
    const responsePrompt = `You are a helpful assistant for BlueSquare Apps. Generate a conversational response based on the current situation.

User's request: "${lastUserMessage}"

Current situation:
${isApprovalPending ? "- Waiting for user approval of actions" : ""}
${completedActions.length > 0 ? `- Completed ${completedActions.length} actions` : ""}
${previews.length > 0 ? `- Generated ${previews.length} action previews` : ""}
${kbCitations.length > 0 ? `- Found ${kbCitations.length} relevant KB articles` : ""}

${context}

Guidelines for your response:
1. Mirror the user's intent in your opening line
2. ${isApprovalPending ? "Clearly ask for approval of the pending actions" : "Summarize what was accomplished"}
3. If KB citations exist, reference them naturally
4. Keep the tone: ${tone}
5. End with exactly 3 follow-up questions (prefix with Q1:, Q2:, Q3:)
6. Do not use em-dashes (—) or emojis
7. Be concise and direct

For the UI elements:
- Always provide actions array (empty if none)
- Always provide citations array (empty if none)  
- Use clear, descriptive titles
- Default to "planned" status if unsure`;
    
    // Generate the response
    const result = await structuredModel.invoke(responsePrompt);
    
    // Ensure arrays are present even if empty (for schema compliance)
    if (!result.ui.actions || result.ui.actions.length === 0) {
      result.ui.actions = [];
    }
    if (!result.ui.citations || result.ui.citations.length === 0) {
      result.ui.citations = [];
    }
    
    // Sanitize the response (remove em-dashes and emojis)
    result.message = sanitizeText(result.message);
    result.followups = result.followups.map(q => sanitizeText(q));
    
    console.log("[RESPONSE] Generated response with", result.followups.length, "follow-ups");
    
    // Build the final message for the state
    const assistantMessage = {
      role: "assistant",
      content: result.message,
      metadata: {
        ui: result.ui,
        followups: result.followups,
        timestamp: new Date().toISOString()
      }
    };
    
    return {
      messages: [assistantMessage],
      responseGenerated: true,
      finalResponse: result
    };
    
  } catch (error) {
    console.error("[RESPONSE] Error generating response:", error.message);
    
    // Fallback response
    const fallbackMessage = {
      role: "assistant",
      content: "I've processed your request. Please let me know if you need anything else.",
      metadata: {
        ui: { actions: [] },
        followups: [
          "Q1: Would you like to see more details?",
          "Q2: Should I help with something else?",
          "Q3: Do you have any questions about what was done?"
        ],
        error: true
      }
    };
    
    return {
      messages: [fallbackMessage],
      responseGenerated: true,
      finalResponse: {
        message: fallbackMessage.content,
        ui: fallbackMessage.metadata.ui,
        followups: fallbackMessage.metadata.followups
      }
    };
  }
}

/**
 * Get the last user message from state
 * @param {Object} state - Current graph state
 * @returns {string} Last user message content
 */
function getLastUserMessage(state) {
  const messages = state.messages || [];
  
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "human") {
      return String(messages[i].content || "");
    }
  }
  
  return "";
}

/**
 * Build detailed context for response generation
 * @param {Object} state - Current graph state
 * @returns {string} Formatted context
 */
function buildResponseContext(state) {
  const parts = [];
  
  // Add completed actions
  if (state.artifacts?.completedActions) {
    parts.push("Completed actions:");
    for (const action of state.artifacts.completedActions) {
      parts.push(`- ${action.type}: ${action.result || 'Success'}`);
    }
  }
  
  // Add pending previews
  if (state.previews?.length > 0) {
    parts.push("\nPending approval:");
    for (const preview of state.previews) {
      const spec = preview.spec || {};
      switch (preview.kind) {
        case "workflow":
          parts.push(`- Workflow: "${spec.name}" with ${spec.steps?.length || 0} steps`);
          break;
        case "task":
          parts.push(`- Task: "${spec.name}" ${spec.dueDate ? `due ${spec.dueDate}` : ''}`);
          break;
        case "appointment":
          parts.push(`- Appointment: "${spec.title}" at ${spec.startTime}`);
          break;
        default:
          parts.push(`- ${preview.kind}: ${JSON.stringify(spec).substring(0, 50)}...`);
      }
    }
  }
  
  // Add KB results
  if (state.kb?.answer) {
    parts.push("\nKnowledge base answer:");
    parts.push(state.kb.answer.substring(0, 200) + "...");
  }
  
  return parts.join("\n");
}

/**
 * Remove em-dashes and emojis from text
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
function sanitizeText(text) {
  if (!text) return text;
  
  // Replace em-dashes with regular dashes
  text = text.replace(/—/g, "-");
  
  // Remove common emojis (basic approach)
  text = text.replace(/[\u{1F600}-\u{1F64F}]/gu, ""); // Emoticons
  text = text.replace(/[\u{1F300}-\u{1F5FF}]/gu, ""); // Misc symbols
  text = text.replace(/[\u{1F680}-\u{1F6FF}]/gu, ""); // Transport
  text = text.replace(/[\u{2600}-\u{26FF}]/gu, "");   // Misc symbols
  text = text.replace(/[\u{2700}-\u{27BF}]/gu, "");   // Dingbats
  
  return text.trim();
}

/**
 * Format the final response for API output
 * @param {Object} state - Current graph state
 * @returns {Object} Formatted response for API
 */
function formatFinalResponse(state) {
  const finalResponse = state.finalResponse;
  
  if (!finalResponse) {
    return {
      status: "ERROR",
      message: "No response generated",
      ui: {}
    };
  }
  
  return {
    status: "SUCCESS",
    message: finalResponse.message,
    ui: finalResponse.ui || {},
    followups: finalResponse.followups || [],
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  responseFinalizerNode,
  formatFinalResponse,
  ResponseSchema
};