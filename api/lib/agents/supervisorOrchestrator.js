// Supervisor Orchestrator Module for Multi-Agent Coordination
// Uses LangGraph to route queries to appropriate specialized agents
// Enables seamless coordination between Activities and Workflow Builder agents
// Integrated with LangSmith for comprehensive observability

// Check if LangSmith tracing is enabled via environment variables
// LangChain/LangGraph automatically instruments when these are set
const langSmithEnabled = process.env.LANGCHAIN_TRACING_V2 === 'true' && !!process.env.LANGCHAIN_API_KEY;

if (langSmithEnabled) {
  console.log('[LangSmith] Tracing enabled for project:', process.env.LANGCHAIN_PROJECT || 'default');
  console.log('[LangSmith] Traces will be visible at: https://smith.langchain.com');
} else {
  console.log('[LangSmith] Tracing not configured (set LANGCHAIN_TRACING_V2=true and LANGCHAIN_API_KEY)');
}

// Supervisor Orchestrator Prompt Template
const SUPERVISOR_PROMPT = `You are a supervisor orchestrator managing specialized agents for a financial advisory firm.

Your team includes:
1. **Activities Agent**: Handles calendar appointments, tasks, schedules, and time-based queries
   - Client meetings, reviews, consultations
   - Task management and to-do lists
   - Time-specific queries (today, this week, next month)
   - Existing scheduled activities

2. **Workflow Builder Agent**: Creates and manages automated business processes for financial advisors
   - Client onboarding workflows
   - Financial planning processes
   - Compliance procedures
   - Investment management workflows
   - Service request automation
   - Any multi-step business process creation

ROUTING RULES:
- Calendar, appointments, meetings, tasks, todos, schedules, "what's on my calendar" → activities_agent
- Creating workflows, processes, automation, procedures, onboarding, compliance steps → workflow_agent
- "Show me my tasks/meetings" → activities_agent
- "Create a process for..." or "Build a workflow for..." → workflow_agent
- Financial planning process creation → workflow_agent
- Viewing today's/this week's activities → activities_agent

FINANCIAL ADVISORY CONTEXT:
- Client reviews, meetings → activities_agent (if checking schedule) or workflow_agent (if creating process)
- Onboarding new clients → workflow_agent (creating the process)
- Compliance procedures → workflow_agent (creating the process)
- "What meetings do I have with clients?" → activities_agent
- "Create a client review process" → workflow_agent

ANALYSIS APPROACH:
1. Identify if user wants to VIEW existing items (activities_agent) or CREATE new processes (workflow_agent)
2. Look for action verbs: "create", "build", "design" → workflow_agent
3. Look for query verbs: "show", "list", "what", "when" → activities_agent
4. Consider the financial advisory context
5. Make a clear routing decision

IMPORTANT: Your job is only to route, not to answer queries directly.`;

// Create the supervisor agent function
async function createSupervisor(dependencies) {
  const { getLLMClient } = dependencies;
  
  // Dynamic imports for LangChain
  const { ChatPromptTemplate, MessagesPlaceholder } = await import("@langchain/core/prompts");
  const { HumanMessage, AIMessage } = await import("@langchain/core/messages");
  
  // Get LLM client
  const llm = await getLLMClient();
  
  // Create supervisor chain with function calling for routing
  const routingFunctions = [
    {
      name: "route_to_agent",
      description: "Route the query to the appropriate agent",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            enum: ["activities_agent", "workflow_agent"],
            description: "The agent to route to"
          },
          reasoning: {
            type: "string",
            description: "Brief explanation of why this agent was chosen"
          }
        },
        required: ["agent", "reasoning"]
      }
    }
  ];
  
  const supervisorLLM = llm.bind({
    functions: routingFunctions,
    function_call: { name: "route_to_agent" }
  });
  
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", SUPERVISOR_PROMPT],
    ["human", "Route this query: {query}"]
  ]);
  
  const supervisorChain = prompt.pipe(supervisorLLM);
  
  return supervisorChain;
}

// Supervisor node for the graph
async function supervisorNode(state, dependencies) {
  // Add trace span annotation for supervisor decision
  const startTime = Date.now();
  
  const supervisor = await createSupervisor(dependencies);
  
  // Get the last message (user query)
  const messages = state.messages || [];
  const lastMessage = messages[messages.length - 1];
  
  if (!lastMessage) {
    return { next: "__end__" };
  }
  
  const query = typeof lastMessage === 'string' ? lastMessage : lastMessage.content;
  
  try {
    // Get routing decision from supervisor
    const response = await supervisor.invoke({ query });
    
    // Extract the function call arguments
    const functionCall = response.additional_kwargs?.function_call;
    if (functionCall?.arguments) {
      const routingDecision = JSON.parse(functionCall.arguments);
      
      console.log("[Supervisor] Routing decision:", {
        agent: routingDecision.agent,
        reasoning: routingDecision.reasoning
      });
      
      // Add supervisor's reasoning to state
      const supervisorMessage = {
        role: "assistant",
        content: `Routing to ${routingDecision.agent}: ${routingDecision.reasoning}`,
        metadata: { type: "routing" }
      };
      
      return {
        messages: [...messages, supervisorMessage],
        next: routingDecision.agent,
        currentAgent: routingDecision.agent
      };
    }
  } catch (error) {
    console.error("[Supervisor] Error in routing:", error);
  }
  
  // Fallback routing based on keywords
  const queryLower = query.toLowerCase();
  
  if (queryLower.includes('calendar') || queryLower.includes('appointment') ||
      queryLower.includes('meeting') || queryLower.includes('task') ||
      queryLower.includes('todo') || queryLower.includes('schedule') ||
      queryLower.includes('today') || queryLower.includes('tomorrow') ||
      queryLower.includes('week') || queryLower.includes('month')) {
    console.log("[Supervisor] Keyword routing to activities_agent");
    return {
      messages: [...messages, {
        role: "assistant",
        content: "Routing to activities agent based on keywords",
        metadata: { type: "routing" }
      }],
      next: "activities_agent",
      currentAgent: "activities_agent"
    };
  }
  
  if (queryLower.includes('workflow') || queryLower.includes('process') ||
      queryLower.includes('automate') || queryLower.includes('automation') ||
      queryLower.includes('procedure') || queryLower.includes('create steps') ||
      queryLower.includes('build') && queryLower.includes('process')) {
    console.log("[Supervisor] Keyword routing to workflow_agent");
    return {
      messages: [...messages, {
        role: "assistant",
        content: "Routing to workflow builder agent based on keywords",
        metadata: { type: "routing" }
      }],
      next: "workflow_agent",
      currentAgent: "workflow_agent"
    };
  }
  
  // Default to activities agent for general queries
  console.log("[Supervisor] Default routing to activities_agent");
  return {
    messages: [...messages, {
      role: "assistant",
      content: "Routing to activities agent as default",
      metadata: { type: "routing" }
    }],
    next: "activities_agent",
    currentAgent: "activities_agent"
  };
}

// Activities agent node wrapper
async function activitiesNode(state, passKey, orgId, timeZone, dependencies) {
  const { createActivitiesAgent } = require('./activitiesAgent');
  
  // Extract the original user query from messages
  const messages = state.messages || [];
  const userMessage = messages.find(m => m.role === 'user' || m.type === 'human');
  
  if (!userMessage) {
    return {
      messages: [...messages, {
        role: "assistant",
        content: "No user query found",
        metadata: { agent: "activities" }
      }],
      next: "__end__"
    };
  }
  
  const query = typeof userMessage === 'string' ? userMessage : userMessage.content;
  
  try {
    // Create and invoke the activities agent
    const agent = await createActivitiesAgent(passKey, orgId, timeZone, dependencies);
    const result = await agent.invoke({ input: query });
    
    // Add the response to messages
    const agentResponse = {
      role: "assistant",
      content: result.output,
      metadata: { agent: "activities" }
    };
    
    return {
      messages: [...messages, agentResponse],
      next: "__end__"
    };
  } catch (error) {
    console.error("[Activities Node] Error:", error);
    return {
      messages: [...messages, {
        role: "assistant",
        content: `Error in activities agent: ${error.message}`,
        metadata: { agent: "activities", error: true }
      }],
      next: "__end__"
    };
  }
}

// Workflow builder agent node wrapper
async function workflowNode(state, passKey, orgId, dependencies) {
  const { createWorkflowBuilderAgent } = require('./workflowBuilderAgent');
  
  // Extract the original user query from messages
  const messages = state.messages || [];
  const userMessage = messages.find(m => m.role === 'user' || m.type === 'human');
  
  if (!userMessage) {
    return {
      messages: [...messages, {
        role: "assistant",
        content: "No user query found",
        metadata: { agent: "workflow" }
      }],
      next: "__end__"
    };
  }
  
  const query = typeof userMessage === 'string' ? userMessage : userMessage.content;
  
  try {
    // Create and invoke the workflow agent
    const agent = await createWorkflowBuilderAgent(passKey, orgId, dependencies);
    const result = await agent.invoke({ input: query });
    
    // Add the response to messages
    const agentResponse = {
      role: "assistant",
      content: result.output,
      metadata: { agent: "workflow" }
    };
    
    return {
      messages: [...messages, agentResponse],
      next: "__end__"
    };
  } catch (error) {
    console.error("[Workflow Node] Error:", error);
    return {
      messages: [...messages, {
        role: "assistant",
        content: `Error in workflow agent: ${error.message}`,
        metadata: { agent: "workflow", error: true }
      }],
      next: "__end__"
    };
  }
}

// Create the orchestrator graph
async function createOrchestratorGraph(passKey, orgId, timeZone = "UTC", dependencies) {
  // Dynamic imports for LangGraph
  const { StateGraph, Annotation, START, END } = await import("@langchain/langgraph");
  
  // Define the state schema
  const OrchestratorState = Annotation.Root({
    messages: Annotation({
      reducer: (x, y) => {
        if (!x) return y;
        if (!y) return x;
        return [...(Array.isArray(x) ? x : []), ...(Array.isArray(y) ? y : [])];
      },
      default: () => []
    }),
    next: Annotation({
      reducer: (x, y) => y ?? x ?? END,
      default: () => END
    }),
    currentAgent: Annotation({
      reducer: (x, y) => y ?? x ?? null,
      default: () => null
    })
  });
  
  // Create the workflow graph
  const workflow = new StateGraph(OrchestratorState)
    // Add supervisor node
    .addNode("supervisor", async (state) => supervisorNode(state, dependencies))
    
    // Add agent nodes with their specific parameters
    .addNode("activities_agent", async (state) => 
      activitiesNode(state, passKey, orgId, timeZone, dependencies))
    
    .addNode("workflow_agent", async (state) => 
      workflowNode(state, passKey, orgId, dependencies))
    
    // Add edges
    .addEdge(START, "supervisor")
    
    // Conditional edges from supervisor
    .addConditionalEdges(
      "supervisor",
      async (state) => state.next || END,
      {
        "activities_agent": "activities_agent",
        "workflow_agent": "workflow_agent",
        [END]: END
      }
    )
    
    // Edges from agents back to end
    .addEdge("activities_agent", END)
    .addEdge("workflow_agent", END);
  
  // Compile the graph with LangSmith metadata if available
  const compileOptions = {};
  
  // Add LangSmith project name to metadata
  if (langSmithEnabled && process.env.LANGCHAIN_PROJECT) {
    compileOptions.tags = [`project:${process.env.LANGCHAIN_PROJECT}`];
    compileOptions.metadata = {
      project: process.env.LANGCHAIN_PROJECT,
      orgId: orgId,
      environment: process.env.NODE_ENV || 'production'
    };
  }
  
  const app = workflow.compile(compileOptions);
  
  console.log('[Orchestrator] Graph compiled with tracing:', langSmithEnabled ? 'enabled' : 'disabled');
  
  return app;
}

// Main orchestrator function
async function createSupervisorOrchestrator(passKey, orgId, timeZone = "UTC", dependencies) {
  console.log("[Orchestrator] Initializing supervisor orchestrator");
  
  const graph = await createOrchestratorGraph(passKey, orgId, timeZone, dependencies);
  
  // Return an executor-like interface
  return {
    invoke: async ({ input }) => {
      try {
        // Convert input to initial state
        const initialState = {
          messages: [{
            role: "user",
            content: input,
            type: "human"
          }],
          next: "supervisor"
        };
        
        // Prepare invocation config with LangSmith metadata
        const invokeConfig = {
          recursionLimit: 10,
          tags: [],
          metadata: {}
        };
        
        if (langSmithEnabled) {
          invokeConfig.runName = `orchestrator_${Date.now()}`;
          invokeConfig.tags = [
            `org:${orgId}`,
            `timezone:${timeZone}`,
            'orchestrator:supervisor'
          ];
          invokeConfig.metadata = {
            query: input.substring(0, 100),
            orgId: orgId,
            timestamp: new Date().toISOString()
          };
        }
        
        // Run the graph with tracing config
        const result = await graph.invoke(initialState, invokeConfig);
        
        // Extract the final response
        const messages = result.messages || [];
        const lastAgentMessage = messages
          .filter(m => m.metadata?.agent && !m.metadata?.error)
          .pop();
        
        if (lastAgentMessage) {
          return {
            output: lastAgentMessage.content,
            metadata: {
              agent: lastAgentMessage.metadata.agent,
              routing: messages
                .filter(m => m.metadata?.type === "routing")
                .map(m => m.content)
            }
          };
        }
        
        // Fallback if no agent response
        return {
          output: "I couldn't process your request. Please try rephrasing your query.",
          metadata: {
            error: true,
            messages: messages
          }
        };
        
      } catch (error) {
        console.error("[Orchestrator] Error:", error);
        return {
          output: `An error occurred: ${error.message}`,
          metadata: {
            error: true,
            errorDetails: error.toString()
          }
        };
      }
    },
    
    // Stream method for future enhancement
    stream: async function* ({ input }) {
      const initialState = {
        messages: [{
          role: "user",
          content: input,
          type: "human"
        }],
        next: "supervisor"
      };
      
      // Stream events from the graph
      for await (const event of graph.stream(initialState)) {
        yield event;
      }
    }
  };
}

// Module exports
module.exports = {
  createSupervisorOrchestrator,
  createOrchestratorGraph,
  supervisorNode,
  activitiesNode,
  workflowNode,
  SUPERVISOR_PROMPT
};