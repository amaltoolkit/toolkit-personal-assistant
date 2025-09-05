// Activities Agent Module for BSA Integration
// Unified agent for managing both calendar appointments and tasks
// Supports appointments-only, tasks-only, or mixed queries

// Activities Agent Prompt Template
const ACTIVITIES_PROMPT = `Today is {currentDate} at {currentTime} {timeZone}.

You are an intelligent activities assistant that manages both calendar appointments and tasks.

CRITICAL: Every query requires you to decide what to fetch:
- includeAppointments: true for meetings, appointments, calendar events
- includeTasks: true for tasks, todos, action items
- Both can be true for comprehensive views

QUERY INTERPRETATION RULES:
- "What's on my calendar?" → includeAppointments: true, includeTasks: false
- "What are my tasks?" → includeAppointments: false, includeTasks: true
- "What do I have today?" → includeAppointments: true, includeTasks: true
- "Show me my meetings" → includeAppointments: true, includeTasks: false
- "What needs to be done?" → includeAppointments: false, includeTasks: true
- "What's my schedule?" → includeAppointments: true, includeTasks: true
- "Any appointments?" → includeAppointments: true, includeTasks: false
- "Todo list" → includeAppointments: false, includeTasks: true
- Default when unclear → includeAppointments: true, includeTasks: true

NATURAL LANGUAGE DATE SUPPORT:
The tool supports natural language date queries. You can use the dateQuery parameter with patterns like:
- Single days: "today", "tomorrow", "yesterday"
- Weeks: "this week", "last week", "next week" (Monday-Sunday)
- Months: "this month", "last month", "next month"
- Quarters: "this quarter", "last quarter", "next quarter"
- Years: "this year", "last year", "next year"
- Relative days: "next 7 days", "past 3 days"
- Weekends: "this weekend", "last weekend", "next weekend"
- Specific weekdays: "this Monday", "next Friday", "last Tuesday"

CRITICAL RULES FOR DATE QUERIES:
- When the user mentions a date pattern like those above, pass it directly to the dateQuery parameter
- The tool will automatically convert these to proper date ranges
- For specific dates in YYYY-MM-DD format, use startDate/endDate parameters
- Do not answer from memory. Always use get_activities to verify data
- Present times to the user in {timeZone}

ACTIVITY TYPES:
Each activity in the response has a Type field:
- Type: "Appointment" - Calendar events, meetings, appointments
- Type: "Task" - Todo items, action items, tasks with due dates

When working with activity data:
- Activities are returned in an array with each item containing:
  - Type: Indicates whether it's an "Appointment" or "Task"
  - Activity: Object with Id, Subject, StartTime/DueDate, EndTime, Location, Description, and other metadata
  - Attendees: Object with ContactIds (array), UserIds (array), and CompanyIds (array)

ATTENDEE INFORMATION:
- Contact details are automatically enriched when activities are fetched with includeAttendees: true (default)
- Look for the _enrichedAttendees field which contains resolved contact information with names, emails, and phone numbers
- No need to call get_contact_details separately for activity attendees - it's done automatically
- If a contact couldn't be resolved, it won't appear in _enrichedAttendees

Example workflow:
1. User asks about activities → Determine which types to include
2. Use get_activities with appropriate includeAppointments and includeTasks flags
3. Activities returned with _enrichedAttendees field containing full contact details
4. Present the enriched information directly to the user

TOOLS AVAILABLE (2 total):
1. get_activities - Fetches appointments and/or tasks based on parameters
2. get_contact_details - Resolves contact information for attendees

Remember: The BSA API uses ObjectName intelligently:
- Appointments only: ObjectName = "appointment" is added
- Tasks only: ObjectName = "task" is added
- Both types: ObjectName is omitted from the request

IMPORTANT OUTPUT FORMATTING:
- Use clean, well-structured markdown formatting
- Use ## for main headers, ### for subheaders
- Use **bold** for emphasis on important information
- Use bullet points (-) or numbered lists for multiple items
- Keep formatting clean and professional
- Separate sections with blank lines for readability
- Group appointments and tasks separately when both are returned

Example of good formatting when both types are included:
## Your Activities for Today

### 📅 Appointments
1. **Team Meeting**
   - Time: 2:00 PM - 3:00 PM
   - Location: Conference Room A
   - Attendees: John Smith, Jane Doe

### ✅ Tasks
1. **Complete quarterly report**
   - Due: 5:00 PM
   - Priority: High

2. **Review budget proposal**
   - Due: End of day
   - Assigned by: Sarah Johnson

Be concise and informative in your responses. Always be explicit about what types of activities you're fetching.`;

// Fetch activities (appointments and/or tasks) using BSA getActivities endpoint
async function getActivities(passKey, orgId, options = {}, dependencies) {
  const { axios, axiosConfig, BSA_BASE, normalizeBSAResponse } = dependencies;
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivities.json`;

  // Helper: ensure YYYY-MM-DD format
  const toDateString = (d) => {
    if (!d) return undefined;
    const date = typeof d === 'string' ? new Date(d) : d;
    if (isNaN(date.getTime())) return undefined;
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
      .toISOString()
      .slice(0, 10);
  };

  // Defaults: current month window
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  // Build base payload
  const payload = {
    IncludeAppointments: !!options.includeAppointments,
    IncludeTasks: !!options.includeTasks,
    IncludeExtendedProperties: !!options.includeExtendedProperties,
    From: toDateString(options.from) || toDateString(defaultFrom),
    To: toDateString(options.to) || toDateString(defaultTo),
    IncludeAttendees: options.includeAttendees !== false,
    OrganizationId: orgId,
    PassKey: passKey
  };

  // Add ObjectName only when fetching a single type
  if (options.includeAppointments && !options.includeTasks) {
    payload.ObjectName = "appointment";
  } else if (!options.includeAppointments && options.includeTasks) {
    payload.ObjectName = "task";
  }
  // When both are true, ObjectName is intentionally omitted

  console.log("[Activities] Fetching with options:", {
    appointments: payload.IncludeAppointments,
    tasks: payload.IncludeTasks,
    objectName: payload.ObjectName || "(omitted for mixed types)",
    dateRange: `${payload.From} to ${payload.To}`
  });

  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);

  if (!normalized.valid) {
    throw new Error(normalized.error || 'Invalid BSA response');
  }

  const activities = Array.isArray(normalized.data?.Activities) ? normalized.data.Activities : [];
  
  return {
    activities,
    valid: true,
    from: payload.From,
    to: payload.To,
    count: Array.isArray(activities) ? activities.length : 0,
    types: {
      appointments: payload.IncludeAppointments,
      tasks: payload.IncludeTasks
    }
  };
}

// Batch fetch contacts by IDs using BSA getMultiple endpoint
async function getContactsByIds(passKey, orgId, contactIds = [], includeExtendedProperties = false, dependencies) {
  const { axios, axiosConfig, BSA_BASE, normalizeBSAResponse } = dependencies;
  
  if (!Array.isArray(contactIds) || contactIds.length === 0) return [];

  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/getMultiple.json`;
  const payload = {
    IncludeExtendedProperties: !!includeExtendedProperties,
    References: contactIds.map((id) => ({
      Fields: [],
      Id: id,
      OrganizationId: orgId,
      PassKey: passKey,
      ObjectName: "contact"
    })),
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "contact"
  };

  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Invalid BSA response');
  }

  return normalized.data?.Results || [];
}

// Define Activities Agent Tools using tool function with Zod
function createActivitiesTools(tool, z, passKey, orgId, timeZone = 'UTC', dependencies) {
  const { parseDateQuery } = dependencies;
  
  return [
    // Tool 1: Get activities (appointments and/or tasks)
    tool(
      async ({ includeAppointments, includeTasks, startDate, endDate, dateQuery, includeAttendees, includeExtendedProperties }) => {
        try {
          // Validate at least one type is requested
          if (!includeAppointments && !includeTasks) {
            return JSON.stringify({ 
              error: "Must include at least one type: appointments or tasks. Set includeAppointments: true and/or includeTasks: true" 
            });
          }

          // Handle natural language date queries
          if (dateQuery && !startDate && !endDate) {
            const parsed = parseDateQuery(dateQuery, timeZone);
            if (parsed) {
              console.log("[Activities Tool] Parsed date query:", dateQuery, "=>", parsed);
              startDate = parsed.startDate;
              endDate = parsed.endDate;
            }
          }
          
          // Normalize and expand single-day queries to a +/- 1 day window to match BSA API behavior
          const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
          const addDays = (ymd, days) => {
            const d = new Date(ymd + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + days);
            return d.toISOString().slice(0, 10);
          };

          let effectiveFrom = isDate(startDate) ? startDate : undefined;
          let effectiveTo = isDate(endDate) ? endDate : undefined;

          if (effectiveFrom && effectiveTo && effectiveFrom === effectiveTo) {
            // exact single day -> expand window
            effectiveFrom = addDays(effectiveFrom, -1);
            effectiveTo = addDays(effectiveTo, +1);
          } else if (effectiveFrom && !effectiveTo) {
            // only start provided -> assume single day
            effectiveTo = addDays(effectiveFrom, +1);
            effectiveFrom = addDays(effectiveFrom, -1);
          } else if (!effectiveFrom && effectiveTo) {
            // only end provided -> assume single day
            effectiveFrom = addDays(effectiveTo, -1);
            effectiveTo = addDays(effectiveTo, +1);
          }

          console.log("[Activities Tool] get_activities args:", { 
            includeAppointments, 
            includeTasks, 
            startDate, 
            endDate, 
            dateQuery, 
            includeAttendees, 
            effectiveFrom, 
            effectiveTo 
          });

          const data = await getActivities(passKey, orgId, {
            includeAppointments,
            includeTasks,
            from: effectiveFrom,
            to: effectiveTo,
            includeAttendees: includeAttendees !== false,
            includeExtendedProperties: !!includeExtendedProperties
          }, dependencies);
          
          // Automatic contact enrichment when attendees are included
          let enrichedActivities = data.activities;
          let contactsEnriched = false;
          
          if (includeAttendees !== false && data.activities.length > 0) {
            // Collect all unique ContactIds from all activities
            const allContactIds = new Set();
            
            data.activities.forEach(item => {
              // Handle both direct Attendees and nested Activity.Attendees structures
              const attendees = item.Activity?.Attendees || item.Attendees;
              if (attendees?.ContactIds && Array.isArray(attendees.ContactIds)) {
                attendees.ContactIds.forEach(id => {
                  if (id) allContactIds.add(id);
                });
              }
            });
            
            // Fetch all contacts in one batch if any found
            if (allContactIds.size > 0) {
              console.log(`[Activities Tool] Auto-enriching ${allContactIds.size} contact(s)`);
              
              try {
                const contactsArray = Array.from(allContactIds);
                const contacts = await getContactsByIds(
                  passKey,
                  orgId,
                  contactsArray,
                  !!includeExtendedProperties,
                  dependencies
                );
                
                // Create a map for quick lookup
                const contactMap = {};
                contacts.forEach(contact => {
                  if (contact.Id) {
                    contactMap[contact.Id] = contact;
                  }
                });
                
                // Enrich activities with contact details
                enrichedActivities = data.activities.map(item => {
                  const attendees = item.Activity?.Attendees || item.Attendees;
                  const contactIds = attendees?.ContactIds || [];
                  
                  // Add enriched contacts while preserving original structure
                  const enrichedItem = { ...item };
                  
                  // Add enriched attendees information
                  if (contactIds.length > 0) {
                    enrichedItem._enrichedAttendees = {
                      contacts: contactIds
                        .map(id => contactMap[id])
                        .filter(Boolean)
                    };
                  }
                  
                  return enrichedItem;
                });
                
                contactsEnriched = true;
                console.log(`[Activities Tool] Successfully enriched contacts`);
              } catch (enrichError) {
                console.error("[Activities Tool] Contact enrichment failed:", enrichError);
                // Continue with un-enriched data if enrichment fails
              }
            }
          }
          
          return JSON.stringify({
            activities: enrichedActivities,
            dateRange: { from: data.from, to: data.to },
            count: data.count,
            included: data.types,
            contactsEnriched
          });
        } catch (error) {
          console.error("[Activities Tool] Error fetching activities:", error);
          return JSON.stringify({ 
            error: `Failed to fetch activities: ${error.message}` 
          });
        }
      },
      {
        name: "get_activities",
        description: "Fetch activities from BSA including appointments, tasks, or both. When includeAttendees is true (default), automatically enriches ContactIds with full contact details including names, emails, and phone numbers. Each activity has a Type field indicating 'Appointment' or 'Task'. Enriched contacts appear in the _enrichedAttendees field.",
        schema: z.object({
          includeAppointments: z.boolean().describe("Include calendar appointments, meetings, and events"),
          includeTasks: z.boolean().describe("Include tasks, todos, and action items"),
          startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
          endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
          dateQuery: z.string().optional().describe("Natural language date query like 'this week', 'next month', 'last 7 days', 'this quarter', etc."),
          includeAttendees: z.boolean().optional().describe("Whether to include attendee details (default true)"),
          includeExtendedProperties: z.boolean().optional().describe("Include custom/extended properties (default false)")
        })
      }
    ),
    
    // Tool 2: Get contact details by IDs
    tool(
      async ({ contactIds, includeExtendedProperties }) => {
        try {
          if (!contactIds || contactIds.length === 0) {
            return JSON.stringify({ 
              error: "No contact IDs provided",
              contacts: [],
              count: 0
            });
          }
          
          const contacts = await getContactsByIds(
            passKey, 
            orgId, 
            contactIds, 
            includeExtendedProperties || false,
            dependencies
          );
          
          return JSON.stringify({
            contacts,
            count: contacts.length
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to fetch contacts: ${error.message}`,
            contacts: [],
            count: 0
          });
        }
      },
      {
        name: "get_contact_details",
        description: "Fetch contact details for specific contact IDs. Note: Activity attendees are automatically enriched, so this tool is only needed for fetching contacts outside of activity context.",
        schema: z.object({
          contactIds: z.array(z.string()).describe("Array of contact IDs to fetch"),
          includeExtendedProperties: z.boolean().optional().describe("Include custom properties (default false)")
        })
      }
    )
  ];
}

// Create Activities Agent
async function createActivitiesAgent(passKey, orgId, timeZone = "UTC", dependencies) {
  const { getLLMClient } = dependencies;
  
  // Extract memory context if provided
  const memoryContext = dependencies.memoryContext || '';
  const checkpointer = dependencies.checkpointer;
  const threadConfig = dependencies.threadConfig;
  
  // Dynamic imports for LangChain and Zod
  const { z } = await import("zod");
  const { tool } = await import("@langchain/core/tools");
  const { AgentExecutor, createToolCallingAgent } = await import("langchain/agents");
  const { ChatPromptTemplate, MessagesPlaceholder } = await import("@langchain/core/prompts");
  
  // Use cached LLM client for better performance
  const llm = await getLLMClient();
  
  const tools = createActivitiesTools(tool, z, passKey, orgId, timeZone, dependencies);
  
  // Get current date/time for context
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    timeZone: timeZone
  });
  const currentTime = now.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: timeZone,
    hour12: true 
  });

  // Debug log to confirm agent time context in server logs
  console.log(`[Activities Agent] Time context: Today is ${currentDate} at ${currentTime} ${timeZone}`);
  if (memoryContext) {
    console.log(`[Activities Agent] Memory context available: ${memoryContext.length} chars`);
  }

  // Format the prompt with current date/time context and memory
  let formattedPrompt = ACTIVITIES_PROMPT
    .replace(/{currentDate}/g, currentDate)
    .replace(/{currentTime}/g, currentTime)
    .replace(/{timeZone}/g, timeZone);
  
  // Add memory context to the prompt if available
  if (memoryContext) {
    formattedPrompt += `\n\nRelevant memories about this user:\n${memoryContext}`;
  }

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", formattedPrompt],
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad")
  ]);
  
  const agent = createToolCallingAgent({
    llm,
    tools,
    prompt
  });
  
  // If checkpointer is provided, create a stateful graph
  if (checkpointer && threadConfig) {
    console.log(`[Activities Agent] Using stateful mode with thread: ${threadConfig.configurable.thread_id}`);
    
    // Dynamic import for LangGraph
    const { StateGraph } = await import('@langchain/langgraph');
    
    const graph = new StateGraph({
      channels: {
        messages: {
          value: (x, y) => x.concat(y),
          default: () => []
        }
      }
    });
    
    // Add the agent as a node
    graph.addNode("agent", async (state) => {
      const result = await agent.invoke(state);
      return { messages: [result] };
    });
    
    graph.setEntryPoint("agent");
    graph.setFinishPoint("agent");
    
    const compiledGraph = graph.compile({ checkpointer });
    
    // Return a wrapper that matches AgentExecutor interface
    return {
      async invoke(input, config = threadConfig) {
        const result = await compiledGraph.invoke(
          { input: input.input, messages: [] },
          config
        );
        // Extract the output from the graph result
        const lastMessage = result.messages[result.messages.length - 1];
        return { output: lastMessage.output || lastMessage.content || '' };
      }
    };
  }
  
  // Fallback to stateless executor (existing behavior)
  const executorConfig = {
    agent,
    tools,
    verbose: false
  };
  
  // Add LangSmith metadata if tracing is enabled
  if (process.env.LANGCHAIN_TRACING_V2 === 'true') {
    executorConfig.tags = ['agent:activities', `org:${orgId}`, `timezone:${timeZone}`];
    executorConfig.metadata = {
      agent: 'activities',
      orgId,
      timeZone,
      hasMemory: !!memoryContext
    };
  }
  
  return new AgentExecutor(executorConfig);
}

// Create Activities Node for LangGraph integration
async function createActivitiesNode(passKey, orgId, timeZone = "UTC", dependencies) {
  return async (state) => {
    // Extract the user query from state
    const messages = state.messages || [];
    const userMessage = messages.find(m => m.role === 'user' || m.type === 'human');
    
    if (!userMessage) {
      return {
        messages: [...messages, {
          role: "assistant",
          content: "No user query found for activities agent",
          metadata: { agent: "activities", error: true }
        }],
        next: "__end__"
      };
    }
    
    const query = typeof userMessage === 'string' ? userMessage : userMessage.content;
    
    try {
      // Create and invoke the activities agent
      const agent = await createActivitiesAgent(passKey, orgId, timeZone, dependencies);
      const result = await agent.invoke({ input: query });
      
      // Add the response to state
      return {
        messages: [...messages, {
          role: "assistant",
          content: result.output,
          metadata: { agent: "activities" }
        }],
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
  };
}

// Module exports
module.exports = {
  createActivitiesAgent,
  createActivitiesNode,
  createActivitiesTools,
  getActivities,
  getContactsByIds,
  ACTIVITIES_PROMPT
};