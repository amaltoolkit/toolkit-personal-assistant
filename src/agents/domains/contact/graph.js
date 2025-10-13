/**
 * Contact Conversational Agent - Tool-Calling Architecture (V4)
 *
 * Uses LangChain tool-calling pattern with ReAct agent loop.
 * The LLM decides which tools to call based on the user's query.
 *
 * Key Features:
 * - Single handleQuery node with tool execution loop
 * - LLM naturally handles field variations (phone vs mobile vs cell)
 * - Works with custom fields automatically (reads ExtendedProperties)
 * - Maintains disambiguation support (via error handling)
 * - 35% less code than previous multi-node approach
 */

const { StateGraph, END } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { getContactTools } = require("./tools");
const { NeedsClarification, PersonNotFound } = require("../../../services/people/errors");
const { getPassKeyManager } = require("../../../core/auth/passkey");

// Simplified state: Core channels only
const ContactStateChannels = {
  // Input
  messages: {
    value: (x, y) => y || x,
    default: () => []
  },
  query: {
    value: (x, y) => y || x,
    default: () => ""
  },
  memory_context: {
    value: (x, y) => y || x,
    default: () => ({})
  },
  entities: {
    value: (x, y) => ({ ...x, ...y }),
    default: () => ({})
  },

  // Output
  response: {
    value: (x, y) => y || x,
    default: () => ""
  },

  // Clarification state (coordinator compatibility)
  needsClarification: {
    value: (x, y) => y !== undefined ? y : x,
    default: () => false
  },
  clarificationType: {
    value: (x, y) => y || x,
    default: () => null
  },
  clarificationData: {
    value: (x, y) => y || x,
    default: () => null
  },

  // Context (required for authentication)
  session_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  org_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  user_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  thread_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  timezone: {
    value: (x, y) => y || x,
    default: () => 'UTC'
  }
};

class ContactConversationalAgent {
  constructor(checkpointer = null) {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.3
    });

    this.passKeyManager = getPassKeyManager();
    this.checkpointer = checkpointer;
    this.tools = getContactTools();  // Get all contact tools

    this.graph = this.buildGraph();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: ContactStateChannels
    });

    // Single node handles everything
    workflow.addNode("handle_query", this.handleQuery.bind(this));

    workflow.setEntryPoint("handle_query");
    workflow.addEdge("handle_query", END);

    // Compile WITHOUT checkpointer (stateless subgraph pattern)
    return workflow.compile();
  }

  /**
   * Main node: Handle query with tool-calling ReAct agent loop
   *
   * Flow:
   * 1. LLM receives query + conversation history
   * 2. LLM decides which tools to call (or answers directly)
   * 3. Tools are executed with runtime context
   * 4. Results fed back to LLM
   * 5. Loop continues until LLM has final answer
   * 6. Disambiguation errors break loop and return interrupt state
   */
  async handleQuery(state) {
    console.log("[CONTACT:HANDLE] Processing query with tool-calling LLM");

    const { query, messages = [], session_id, org_id, timezone, memory_context, entities } = state;

    try {
      // Build runtime context for tools
      const passKey = await this.passKeyManager.getPassKey(session_id);
      const context = {
        session_id,
        org_id,
        passKey,
        timezone,
        memory_context: memory_context || {},
        entities: entities || {}
      };

      // Bind tools to LLM (for schema/description)
      const llmWithTools = this.llm.bindTools(this.tools);

      // Build conversation history
      const conversationMessages = [
        {
          role: "system",
          content: this.getSystemPrompt()
        },
        ...messages,
        {
          role: "user",
          content: query
        }
      ];

      console.log("[CONTACT:HANDLE] Starting tool-calling loop");

      // ReAct agent loop: LLM ↔ Tools conversation
      let currentMessages = conversationMessages;
      let response;
      let loopCount = 0;
      const MAX_LOOPS = 5;  // Prevent infinite loops

      while (loopCount < MAX_LOOPS) {
        // Invoke LLM
        response = await llmWithTools.invoke(currentMessages);

        // Check if LLM wants to call tools
        if (!response.tool_calls || response.tool_calls.length === 0) {
          // No tool calls - LLM has final answer
          console.log("[CONTACT:HANDLE] LLM provided final answer (no tools called)");
          break;
        }

        console.log(`[CONTACT:HANDLE] LLM requested ${response.tool_calls.length} tool call(s)`);

        // Execute each tool call
        const toolMessages = [];
        for (const toolCall of response.tool_calls) {
          try {
            console.log(`[CONTACT:HANDLE] Executing tool: ${toolCall.name}`, toolCall.args);

            const toolResult = await this.executeTool(toolCall, context);

            // Add tool result to conversation
            toolMessages.push({
              role: "tool",
              content: toolResult,
              tool_call_id: toolCall.id
            });

            console.log(`[CONTACT:HANDLE] Tool ${toolCall.name} completed successfully`);

          } catch (error) {
            // Handle disambiguation errors
            if (error instanceof NeedsClarification || error instanceof PersonNotFound) {
              console.log("[CONTACT:HANDLE] Disambiguation needed - breaking tool loop");

              // Convert error to interrupt state
              const interruptState = error.toInterruptState();

              return {
                ...state,
                ...interruptState
              };
            }

            // Other errors - add as tool result
            console.error(`[CONTACT:HANDLE] Tool ${toolCall.name} error:`, error.message);
            toolMessages.push({
              role: "tool",
              content: JSON.stringify({ error: error.message }),
              tool_call_id: toolCall.id
            });
          }
        }

        // Add assistant's tool-calling message to conversation
        currentMessages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.tool_calls
        });

        // Add tool results to conversation
        currentMessages.push(...toolMessages);

        loopCount++;
      }

      if (loopCount >= MAX_LOOPS) {
        console.warn("[CONTACT:HANDLE] Hit max tool-calling loops - returning current response");
      }

      // Extract final answer
      const finalAnswer = response.content || "I couldn't process your request.";

      console.log("[CONTACT:HANDLE] Final answer:", finalAnswer.substring(0, 100));

      return {
        ...state,
        response: finalAnswer,
        messages: [
          ...messages,
          { role: "user", content: query },
          { role: "assistant", content: finalAnswer }
        ]
      };

    } catch (error) {
      console.error("[CONTACT:HANDLE] Unexpected error:", error);

      return {
        ...state,
        response: `Error: ${error.message}`
      };
    }
  }

  /**
   * Execute a single tool with runtime context
   *
   * @param {Object} toolCall - Tool call from LLM (contains name, args, id)
   * @param {Object} context - Runtime context (passKey, session_id, org_id, etc)
   * @returns {string} Tool result as JSON string
   */
  async executeTool(toolCall, context) {
    const { name, args } = toolCall;

    // Find tool
    const tool = this.tools.find(t => t.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Execute tool with context
    // Context is passed via config parameter (LangChain standard)
    const result = await tool.invoke(args, { context });

    return result;
  }

  /**
   * System prompt for Contact Agent
   * Instructs LLM on tool usage and response format
   */
  getSystemPrompt() {
    return `You are a contact information assistant for a CRM system.

**Available Tools:**
- search_contacts: Find contacts by name (returns id, name, email, company, title)
- get_contact_details: Get complete contact info including ALL fields and custom fields
- search_users: Find BSA users (team members) by name
- get_user_details: Get complete user info

**How to Answer Queries:**

1. **For field queries** ("What's X's email?", "When is X's anniversary?"):
   - Call get_contact_details (or get_user_details) to fetch ALL data
   - Read ALL fields including customFields array
   - If field exists, return the value
   - If field doesn't exist, say so and list available custom fields

2. **For search queries** ("Find John", "Who is Norman?"):
   - Call search_contacts (or search_users) first
   - Then call get_contact_details with the exact name to show full info

3. **For complex queries** ("Tell me about Norman's work"):
   - Get full contact details
   - Answer using relevant fields (company, title, etc)

**Important Guidelines:**
- Use tools to fetch data - don't make up information
- For custom/unusual field names, get_contact_details includes a customFields array
- Be concise and direct
- If information isn't available, say so clearly
- Format responses in markdown for better readability

**Example:**
User: "When is Norman's wedding anniversary?"
You: [Call get_contact_details with personName: "Norman"]
Tool returns: { name: "Norman Albertson", customFields: [{ name: "Favorite Color", value: "Blue" }] }
You: "I don't see a wedding anniversary field for Norman Albertson. Available custom fields: Favorite Color"`;
  }

  /**
   * Get compiled graph
   */
  getGraph() {
    return this.graph;
  }
}

// Singleton instance
let instance = null;

function getContactAgent(checkpointer = null) {
  if (!instance) {
    instance = new ContactConversationalAgent(checkpointer);
  }
  return instance;
}

/**
 * Create subgraph for coordinator (expected pattern)
 * Coordinator expects this function to exist
 */
async function createSubgraph(checkpointer = null) {
  const agent = new ContactConversationalAgent(checkpointer);
  return agent.getGraph();
}

module.exports = {
  ContactConversationalAgent,
  getContactAgent,
  createSubgraph  // Required by coordinator
};
