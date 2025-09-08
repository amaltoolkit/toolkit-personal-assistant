/**
 * Base Designer - Shared logic for all designer agents
 * 
 * Provides common functionality for:
 * - LLM initialization with structured output
 * - Preview generation
 * - Error handling
 * - Common prompting patterns
 */

const { ChatOpenAI } = require("@langchain/openai");

/**
 * Creates a base designer with common configuration
 * @param {string} modelName - The OpenAI model to use
 * @param {number} temperature - Temperature for generation (0-1)
 * @returns {ChatOpenAI} Configured LLM instance
 */
function createDesignerLLM(modelName = "gpt-4o-mini", temperature = 0) {
  return new ChatOpenAI({
    model: process.env[`LLM_${modelName.toUpperCase().replace('-', '_')}`] || modelName,
    temperature,
    maxTokens: 2000
  });
}

/**
 * Base designer function that handles common design patterns
 * @param {Object} state - The graph state
 * @param {Object} config - The configuration object
 * @param {Object} designerConfig - Configuration for this specific designer
 * @returns {Object} Updated state with preview
 */
async function baseDesigner(state, config, designerConfig) {
  const {
    schema,           // Zod schema for structured output
    promptTemplate,   // Function to generate prompt
    previewType,      // Type of preview (workflow, task, appointment)
    extractParams     // Function to extract params from user message
  } = designerConfig;

  try {
    // Get the LLM with structured output
    const llm = createDesignerLLM(designerConfig.model, designerConfig.temperature);
    const structuredLLM = llm.withStructuredOutput(schema);

    // Extract parameters from state
    const userMessage = state.messages?.at(-1)?.content || "";
    const params = extractParams ? extractParams(state, config) : { userMessage };

    // Generate the prompt
    const prompt = promptTemplate(params);

    // Get structured output from LLM
    console.log(`[DESIGNER:${previewType.toUpperCase()}] Generating design...`);
    const spec = await structuredLLM.invoke(prompt);

    // Create preview object
    const preview = {
      actionId: state.action?.id || `${previewType}_${Date.now()}`,
      kind: previewType,
      spec,
      timestamp: new Date().toISOString()
    };

    // Return updated state with preview
    return {
      previews: [preview]
    };

  } catch (error) {
    console.error(`[DESIGNER:${designerConfig.previewType || 'UNKNOWN'}:ERROR]`, error);
    
    // Return error preview
    return {
      previews: [{
        actionId: state.action?.id || `error_${Date.now()}`,
        kind: "error",
        error: error.message,
        timestamp: new Date().toISOString()
      }]
    };
  }
}

/**
 * Common prompt patterns for designers
 */
const promptPatterns = {
  /**
   * Generate context about the user and organization
   */
  getUserContext: (config) => {
    const userId = config?.configurable?.userId || "unknown";
    const orgId = config?.configurable?.orgId || "unknown";
    const timezone = config?.configurable?.user_tz || "UTC";
    
    return `User Context:
- User ID: ${userId}
- Organization ID: ${orgId}
- Timezone: ${timezone}`;
  },

  /**
   * Generate memory context if available
   */
  getMemoryContext: (state) => {
    // Look for memory context in messages
    const memoryMessage = state.messages?.find(m => 
      m.role === "system" && m.content?.includes("Relevant context:")
    );
    
    if (memoryMessage) {
      return `\n${memoryMessage.content}`;
    }
    return "";
  },

  /**
   * Standard instructions for quality
   */
  getQualityInstructions: () => {
    return `Important Instructions:
- Be specific and actionable
- Use professional language
- Consider timezone differences
- Ensure all dates/times are properly formatted
- Provide meaningful descriptions`;
  }
};

/**
 * Validate that required config is present
 */
function validateDesignerConfig(config) {
  const required = ['schema', 'promptTemplate', 'previewType'];
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    throw new Error(`Designer config missing required fields: ${missing.join(', ')}`);
  }
}

module.exports = {
  createDesignerLLM,
  baseDesigner,
  promptPatterns,
  validateDesignerConfig
};