/**
 * General Subgraph - Conversational and Informational Agent
 *
 * Handles:
 * - Greetings and farewells
 * - Questions about existing entities (workflows, appointments, tasks)
 * - System state queries ("What did I create today?")
 * - Follow-up questions
 * - Acknowledgments
 *
 * This agent does NOT create or modify BSA entities - it's read-only/informational.
 * Action agents (calendar, task, workflow, contact) handle creation/modification.
 */

const { StateGraph, END } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { getEntityManager } = require("../../../services/entities/entityManager");
const { getMem0Service } = require("../../../services/memory/mem0Service");
const { getAppointments } = require("../../../integrations/bsa/tools/appointments");
const { getTasks } = require("../../../integrations/bsa/tools/tasks");
const { parseDateQuery } = require("../../../utils/dateParser");

// State channels for general agent
const GeneralStateChannels = {
  // Input
  messages: {
    value: (x, y) => y || x,
    default: () => []
  },
  memory_context: {
    value: (x, y) => y || x,
    default: () => ({})
  },
  entities: {
    value: (x, y) => y || x,
    default: () => ({})
  },

  // Processing
  intent: {
    value: (x, y) => y || x,
    default: () => null
  },
  context: {
    value: (x, y) => y || x,
    default: () => ({})
  },
  bsa_data: {
    value: (x, y) => y || x,
    default: () => ({
      appointments: [],
      tasks: [],
      needsFetch: false
    })
  },
  answer: {
    value: (x, y) => y || x,
    default: () => ""
  },

  // Output
  response: {
    value: (x, y) => y || x,
    default: () => ""
  },
  error: {
    value: (x, y) => y || x,
    default: () => null
  },

  // Context fields
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

class GeneralSubgraph {
  constructor() {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.7  // Higher temperature for more natural conversation
    });
    this.entityManager = getEntityManager();
    this.mem0 = getMem0Service();

    this.graph = this.buildGraph();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: GeneralStateChannels
    });

    // Add nodes
    workflow.addNode("classify_query", this.classifyQuery.bind(this));
    workflow.addNode("detect_bsa_needs", this.detectBSANeeds.bind(this));
    workflow.addNode("fetch_bsa_data", this.fetchBSAData.bind(this));
    workflow.addNode("retrieve_context", this.retrieveContext.bind(this));
    workflow.addNode("generate_answer", this.generateAnswer.bind(this));
    workflow.addNode("format_response", this.formatResponse.bind(this));

    // Define edges
    workflow.setEntryPoint("classify_query");
    workflow.addEdge("classify_query", "detect_bsa_needs");

    // Conditional edge: fetch BSA data if needed
    workflow.addConditionalEdges(
      "detect_bsa_needs",
      (state) => state.bsa_data?.needsFetch ? "fetch_bsa_data" : "retrieve_context",
      {
        "fetch_bsa_data": "fetch_bsa_data",
        "retrieve_context": "retrieve_context"
      }
    );

    workflow.addEdge("fetch_bsa_data", "retrieve_context");
    workflow.addEdge("retrieve_context", "generate_answer");
    workflow.addEdge("generate_answer", "format_response");
    workflow.addEdge("format_response", END);

    // Compile without checkpointer (stateless)
    console.log("[GENERAL] Compiling graph in STATELESS mode");
    return workflow.compile();
  }

  /**
   * Classify the user's query intent
   */
  async classifyQuery(state) {
    console.log("[GENERAL:CLASSIFY] Classifying user query");

    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage) {
      return {
        ...state,
        intent: 'unknown',
        error: 'No message provided'
      };
    }

    const query = lastMessage.content.toLowerCase();

    // Pattern-based classification for speed
    const patterns = {
      greeting: /^(hey|hi|hello|what's up|good morning|good afternoon|good evening|howdy)/i,
      farewell: /^(bye|goodbye|thanks|thank you|see you|later|ttyl|catch you|take care)/i,
      entity_question: /what (is|was|were)|show (me |all |my )?|list|who was|when was|tell me about|describe|explain/i,
      system_state: /how many|what did i (create|do|make)|recent activity|my (workflows?|tasks?|appointments?|summary)/i,
      acknowledgment: /^(yes|yeah|yep|yup|no|nope|nah|ok|okay|got it|i see|understood|correct|right)/i
    };

    let intent = 'general';
    for (const [type, pattern] of Object.entries(patterns)) {
      if (pattern.test(query)) {
        intent = type;
        console.log(`[GENERAL:CLASSIFY] Detected intent: ${intent}`);
        break;
      }
    }

    return {
      ...state,
      intent
    };
  }

  /**
   * Detect if query needs BSA data (appointments, tasks)
   */
  async detectBSANeeds(state) {
    console.log("[GENERAL:DETECT] Detecting BSA data needs");

    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage) {
      return { ...state };
    }

    const query = lastMessage.content.toLowerCase();

    // Patterns that indicate need for BSA data
    const appointmentPatterns = /\b(appointment|meeting|calendar|schedule)\b/i;
    const taskPatterns = /\b(task|todo|to-do|action item)\b/i;
    const viewingPatterns = /(show|list|what|view|get|find|display)\s+(me\s+)?(my\s+|all\s+)?/i;
    const datePatterns = /(today|tomorrow|this\s+week|next\s+week|this\s+month|next\s+month)/i;

    const needsAppointments = appointmentPatterns.test(query) && viewingPatterns.test(query);
    const needsTasks = taskPatterns.test(query) && viewingPatterns.test(query);
    const hasDateReference = datePatterns.test(query);

    // Check if question is about BSA data (not just session entities)
    const needsFetch = (needsAppointments || needsTasks) && (hasDateReference || viewingPatterns.test(query));

    console.log("[GENERAL:DETECT] BSA needs analysis:", {
      needsAppointments,
      needsTasks,
      hasDateReference,
      needsFetch
    });

    return {
      ...state,
      bsa_data: {
        appointments: [],
        tasks: [],
        needsFetch,
        fetchAppointments: needsAppointments,
        fetchTasks: needsTasks
      }
    };
  }

  /**
   * Fetch data from BSA (appointments, tasks)
   */
  async fetchBSAData(state, config) {
    console.log("[GENERAL:FETCH] Fetching BSA data");

    const bsaData = {
      appointments: [],
      tasks: [],
      needsFetch: false
    };

    try {
      // Validate config exists
      if (!config?.configurable) {
        console.warn("[GENERAL:FETCH] No config provided - skipping BSA fetch");
        return { ...state, bsa_data: bsaData };
      }

      // Get PassKey and org ID
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      const timezone = state.timezone || 'UTC';

      if (!passKey || !orgId) {
        console.warn("[GENERAL:FETCH] Missing PassKey or orgId - skipping BSA fetch");
        return { ...state, bsa_data: bsaData };
      }

      const lastMessage = state.messages[state.messages.length - 1];
      const query = lastMessage.content;

      // Parse date from query
      const parsedDate = parseDateQuery(query, timezone);
      let startDate, endDate;

      if (parsedDate) {
        startDate = parsedDate.startDate;
        endDate = parsedDate.endDate;
        console.log("[GENERAL:FETCH] Parsed date range:", { startDate, endDate });
      } else {
        // Default to today
        const today = new Date();
        startDate = today.toISOString().split('T')[0];
        endDate = startDate;
        console.log("[GENERAL:FETCH] Using default date (today):", startDate);
      }

      // Fetch appointments if needed
      if (state.bsa_data.fetchAppointments) {
        console.log("[GENERAL:FETCH] Fetching appointments...");
        try {
          const result = await getAppointments({
            startDate,
            endDate,
            includeExtendedProperties: false
          }, passKey, orgId);

          bsaData.appointments = result.appointments || [];
          console.log(`[GENERAL:FETCH] Fetched ${bsaData.appointments.length} appointments`);
        } catch (error) {
          console.error("[GENERAL:FETCH] Error fetching appointments:", error.message);
        }
      }

      // Fetch tasks if needed
      if (state.bsa_data.fetchTasks) {
        console.log("[GENERAL:FETCH] Fetching tasks...");
        try {
          const result = await getTasks({
            startDate,
            endDate,
            includeCompleted: false
          }, passKey, orgId);

          bsaData.tasks = result.tasks || [];
          console.log(`[GENERAL:FETCH] Fetched ${bsaData.tasks.length} tasks`);
        } catch (error) {
          console.error("[GENERAL:FETCH] Error fetching tasks:", error.message);
        }
      }

      return {
        ...state,
        bsa_data: bsaData
      };

    } catch (error) {
      console.error("[GENERAL:FETCH] Error in fetchBSAData:", error);
      return {
        ...state,
        bsa_data: bsaData,
        error: `Failed to fetch BSA data: ${error.message}`
      };
    }
  }

  /**
   * Retrieve relevant context for answering
   */
  async retrieveContext(state) {
    console.log("[GENERAL:CONTEXT] Retrieving context for query");

    const context = {
      entities: {},
      history: {},
      stats: {},
      memory: [],
      bsa: {
        appointments: [],
        tasks: []
      }
    };

    try {
      // Get entity statistics
      context.stats = this.entityManager.getStats(state.entities);
      console.log("[GENERAL:CONTEXT] Entity stats:", context.stats);

      // Get latest entities of each type
      const types = this.entityManager.getTypes(state.entities);
      types.forEach(type => {
        if (!type.startsWith('_')) {  // Skip internal fields
          context.entities[type] = this.entityManager.getLatest(state.entities, type);

          // Also get history for "show all" queries
          context.history[type] = this.entityManager.getHistory(state.entities, type, 5);
        }
      });

      console.log("[GENERAL:CONTEXT] Retrieved entities:", Object.keys(context.entities));

      // Include BSA data if fetched
      if (state.bsa_data) {
        context.bsa.appointments = state.bsa_data.appointments || [];
        context.bsa.tasks = state.bsa_data.tasks || [];
        console.log("[GENERAL:CONTEXT] BSA data:", {
          appointments: context.bsa.appointments.length,
          tasks: context.bsa.tasks.length
        });
      }

      // Memory context is already in state
      context.memory = state.memory_context?.recalled_memories || [];
      console.log(`[GENERAL:CONTEXT] Memory context: ${context.memory.length} memories`);

      return {
        ...state,
        context
      };

    } catch (error) {
      console.error("[GENERAL:CONTEXT] Error retrieving context:", error);
      return {
        ...state,
        context,
        error: `Failed to retrieve context: ${error.message}`
      };
    }
  }

  /**
   * Generate answer using LLM with context
   */
  async generateAnswer(state) {
    console.log("[GENERAL:ANSWER] Generating answer");

    const lastMessage = state.messages[state.messages.length - 1];
    const userQuery = lastMessage.content;

    try {
      // Handle simple greetings/farewells without LLM
      if (state.intent === 'greeting') {
        const greetings = [
          "Hey! How can I help you today?",
          "Hi there! What would you like to do?",
          "Hello! I'm here to assist you with workflows, appointments, and tasks.",
          "Hey! Ready to help. What do you need?"
        ];
        const stats = state.context.stats;
        let greeting = greetings[Math.floor(Math.random() * greetings.length)];

        if (stats.totalEntities > 0) {
          const summary = Object.entries(stats.byType)
            .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
            .join(', ');
          greeting += ` I see you have ${summary} in this session.`;
        }

        return {
          ...state,
          answer: greeting
        };
      }

      if (state.intent === 'farewell') {
        const farewells = [
          "Goodbye! Feel free to come back anytime.",
          "See you later! Your workflows and data will be here when you return.",
          "Take care! Let me know if you need anything else.",
          "Bye! Have a great day!"
        ];
        return {
          ...state,
          answer: farewells[Math.floor(Math.random() * farewells.length)]
        };
      }

      if (state.intent === 'acknowledgment') {
        return {
          ...state,
          answer: "Got it! Anything else I can help with?"
        };
      }

      // For other intents, use LLM with full context
      const entityContext = this.buildEntityContext(state.context.entities, state.context.history);
      const bsaContext = this.buildBSAContext(state.context.bsa);
      const memoryContext = this.buildMemoryContext(state.context.memory);
      const statsContext = this.buildStatsContext(state.context.stats);
      const conversationContext = this.buildConversationContext(state.messages);

      const prompt = `
You are a helpful AI assistant for a business automation system that helps financial advisors manage workflows, appointments, and tasks.

User query: "${userQuery}"

${conversationContext}

${entityContext}

${bsaContext}

${memoryContext}

${statsContext}

INSTRUCTIONS:
- Provide a natural, conversational response
- Be concise but informative
- If asking about a specific step in a workflow, provide the step details from the context
- If asking "show all" or "list", provide the list from the history
- If asking about system state, use the stats
- If context is empty, politely explain what you can help with
- Use markdown formatting for better readability (**bold** for emphasis, lists, etc.)
- For step questions, extract the step number even if spelled out ("two" = 2, "second" = 2, etc.)

Answer:`;

      const response = await this.llm.invoke(prompt);
      console.log("[GENERAL:ANSWER] Generated answer successfully");

      return {
        ...state,
        answer: response.content
      };

    } catch (error) {
      console.error("[GENERAL:ANSWER] Error generating answer:", error);
      return {
        ...state,
        answer: "I encountered an error generating a response. Please try rephrasing your question.",
        error: error.message
      };
    }
  }

  /**
   * Build entity context for LLM prompt
   */
  buildEntityContext(entities, history) {
    if (!entities || Object.keys(entities).length === 0) {
      return "\nNo entities available in this session yet.";
    }

    const parts = ["\n**Recent Entities:**"];

    // Workflow context
    if (entities.workflow) {
      const wf = entities.workflow;
      parts.push(`\n**Workflow**: "${wf.name}" (ID: ${wf.id})`);
      parts.push(`- ${wf.stepCount} steps total`);
      parts.push(`- Created: ${new Date(wf.createdAt).toLocaleString()}`);

      if (wf.steps && wf.steps.length > 0) {
        parts.push("- Steps:");
        wf.steps.forEach((step, idx) => {
          parts.push(`  ${idx + 1}. **${step.name}** (${step.assignee}) - ${step.description}`);
        });
      }
    }

    // Workflow history for "show all" queries
    if (history.workflow && history.workflow.length > 1) {
      parts.push(`\n**All Workflows (${history.workflow.length}):**`);
      history.workflow.forEach((wf, idx) => {
        parts.push(`${idx + 1}. "${wf.name}" - ${wf.stepCount} steps (Created: ${new Date(wf.createdAt).toLocaleString()})`);
      });
    }

    // Appointment context
    if (entities.appointment) {
      const appt = entities.appointment;
      parts.push(`\n**Appointment**: "${appt.name}"`);
      parts.push(`- Time: ${new Date(appt.time).toLocaleString()}`);
      if (appt.participants && appt.participants.length > 0) {
        parts.push(`- Participants: ${appt.participants.join(', ')}`);
      }
      if (appt.location) {
        parts.push(`- Location: ${appt.location}`);
      }
    }

    // Task context
    if (entities.task) {
      const task = entities.task;
      parts.push(`\n**Task**: "${task.title}"`);
      parts.push(`- Assigned to: ${task.assignee}`);
      if (task.dueDate) {
        parts.push(`- Due: ${new Date(task.dueDate).toLocaleString()}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Build BSA data context for LLM prompt
   */
  buildBSAContext(bsaData) {
    if (!bsaData || (bsaData.appointments.length === 0 && bsaData.tasks.length === 0)) {
      return "";
    }

    const parts = ["\n**Data from BlueSquare Apps:**"];

    // Appointments
    if (bsaData.appointments && bsaData.appointments.length > 0) {
      parts.push(`\n**Appointments (${bsaData.appointments.length}):**`);
      bsaData.appointments.slice(0, 10).forEach((appt, idx) => {
        const time = new Date(appt.startTime || appt.time);
        parts.push(`${idx + 1}. **${appt.name || appt.subject}**`);
        parts.push(`   - Time: ${time.toLocaleString()}`);
        if (appt.location) {
          parts.push(`   - Location: ${appt.location}`);
        }
        if (appt.participants && appt.participants.length > 0) {
          parts.push(`   - With: ${appt.participants.join(', ')}`);
        }
      });

      if (bsaData.appointments.length > 10) {
        parts.push(`   ... and ${bsaData.appointments.length - 10} more`);
      }
    }

    // Tasks
    if (bsaData.tasks && bsaData.tasks.length > 0) {
      parts.push(`\n**Tasks (${bsaData.tasks.length}):**`);
      bsaData.tasks.slice(0, 10).forEach((task, idx) => {
        parts.push(`${idx + 1}. **${task.title || task.name}**`);
        if (task.assignee) {
          parts.push(`   - Assigned to: ${task.assignee}`);
        }
        if (task.dueDate) {
          parts.push(`   - Due: ${new Date(task.dueDate).toLocaleString()}`);
        }
        if (task.status) {
          parts.push(`   - Status: ${task.status}`);
        }
      });

      if (bsaData.tasks.length > 10) {
        parts.push(`   ... and ${bsaData.tasks.length - 10} more`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Build memory context for LLM prompt
   */
  buildMemoryContext(memories) {
    if (!memories || memories.length === 0) {
      return "";
    }

    const parts = ["\n**Context from Previous Interactions:**"];
    memories.forEach((mem, idx) => {
      parts.push(`${idx + 1}. ${mem.content || mem.value?.text || mem.memory}`);
    });

    return parts.join('\n');
  }

  /**
   * Build stats context for LLM prompt
   */
  buildStatsContext(stats) {
    if (!stats || stats.totalEntities === 0) {
      return "\nNo entities created in this session yet.";
    }

    const parts = [`\n**Session Statistics:**`];
    parts.push(`- Total entities: ${stats.totalEntities}`);

    if (stats.byType && Object.keys(stats.byType).length > 0) {
      parts.push("- Breakdown:");
      Object.entries(stats.byType).forEach(([type, count]) => {
        parts.push(`  • ${count} ${type}${count > 1 ? 's' : ''}`);
      });
    }

    if (stats.newestEntity) {
      parts.push(`- Most recent: ${new Date(stats.newestEntity).toLocaleString()}`);
    }

    return parts.join('\n');
  }

  /**
   * Build conversation context from recent messages
   */
  buildConversationContext(messages) {
    if (!messages || messages.length <= 1) {
      return "";
    }

    // Include last 3 messages for context (excluding current)
    const recentMessages = messages.slice(-4, -1);
    if (recentMessages.length === 0) {
      return "";
    }

    const parts = ["\n**Recent Conversation:**"];
    recentMessages.forEach(msg => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      parts.push(`${role}: ${msg.content}`);
    });

    return parts.join('\n');
  }

  /**
   * Format final response
   */
  async formatResponse(state) {
    console.log("[GENERAL:RESPONSE] Formatting response");

    if (state.error) {
      return {
        ...state,
        response: `Error: ${state.error}`
      };
    }

    return {
      ...state,
      response: state.answer
    };
  }
}

// Export factory function
async function createSubgraph(checkpointer = null) {
  return new GeneralSubgraph(checkpointer).graph;
}

module.exports = {
  createSubgraph,
  GeneralSubgraph
};

// Export graph for LangGraph Studio (synchronous - no checkpointer needed)
module.exports.graph = new GeneralSubgraph().graph;
