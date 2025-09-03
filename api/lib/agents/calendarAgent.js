// Calendar Agent Module for BSA Integration
// This module provides calendar and appointment management capabilities
// using LangChain agents and BSA API endpoints

// Calendar Agent Prompt Template
const CALENDAR_PROMPT = `Today is {currentDate} at {currentTime} {timeZone}.

You are a helpful calendar assistant. Use the available tools to answer questions about calendar activities, appointments, meetings, and schedules.

IMPORTANT: Use the current date and time provided above to correctly interpret relative date references. Always interpret dates in the user's time zone ({timeZone}).

NATURAL LANGUAGE DATE SUPPORT:
The calendar tool now supports natural language date queries. You can use the dateQuery parameter with patterns like:
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
- Do not answer from memory. Always use get_calendar_activities to verify appointments
- Present times to the user in {timeZone}

When working with calendar data:
- Activities are returned in an array with each item containing:
  - Type: Usually "Appointment" for calendar events
  - Activity: Object with Id, Subject, StartTime, EndTime, Location, Description, and other metadata
  - Attendees: Object with ContactIds (array), UserIds (array), and CompanyIds (array)

IMPORTANT - Be proactive with contact information:
- When you retrieve appointments that have Attendees with ContactIds, ALWAYS immediately fetch their contact details
- Use get_contact_details to fetch contact information for all ContactIds found in appointments
- Present appointment information WITH attendee contact details together in your response
- Don't wait for the user to ask about attendees - provide this information proactively

Example workflow:
1. User asks about appointments → Use get_calendar_activities
2. See ContactIds in Attendees → Immediately use get_contact_details with those IDs
3. Response includes both appointment details AND attendee names, emails, phone numbers

Available tools (2 total):
- get_calendar_activities: Fetch activities for a date range or search for specific appointments
- get_contact_details: Fetch contact information for one or more contact IDs (works with single ID too)

Examples for get_contact_details:
- Single contact: contactIds: ["40071328-2515-47da-8f17-c13d0c9b3162"]
- Multiple contacts: contactIds: ["id1", "id2", "id3"]

IMPORTANT OUTPUT FORMATTING:
- Use clean, well-structured markdown formatting
- Use ## for main headers, ### for subheaders
- Use **bold** for emphasis on important information
- Use bullet points (-) or numbered lists (1. 2. 3.) for multiple items
- Keep formatting clean and professional
- Separate sections with blank lines for readability

Example of good formatting:
## Appointment Details
**Subject:** Team Meeting  
**Date:** March 15, 2024  
**Time:** 2:00 PM  
**Location:** Conference Room A

### Attendees
1. **John Smith**
   - Email: john@example.com
   - Phone: (555) 123-4567
2. **Jane Doe**
   - Email: jane@example.com
   - Phone: (555) 987-6543

Be concise and informative in your responses.`;

// Fetch calendar activities (appointments) using BSA calendar endpoint
async function getCalendarActivities(passKey, orgId, options = {}, dependencies) {
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

  const payload = {
    IncludeAppointments: true,
    IncludeExtendedProperties: !!options.includeExtendedProperties,
    IncludeTasks: false,
    From: toDateString(options.from) || toDateString(defaultFrom),
    To: toDateString(options.to) || toDateString(defaultTo),
    IncludeAttendees: options.includeAttendees !== false,
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "appointment"
  };

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
    count: Array.isArray(activities) ? activities.length : 0
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

// Define Calendar Agent Tools using tool function with Zod
function createCalendarTools(tool, z, passKey, orgId, timeZone = 'UTC', dependencies) {
  const { parseDateQuery } = dependencies;
  
  return [
    // Tool 1: Get calendar activities with optional date filtering
    tool(
      async ({ startDate, endDate, includeAttendees, dateQuery }) => {
        try {
          // Handle natural language date queries
          if (dateQuery && !startDate && !endDate) {
            const parsed = parseDateQuery(dateQuery, timeZone);
            if (parsed) {
              console.log("[Calendar Tool] Parsed date query:", dateQuery, "=>", parsed);
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

          console.log("[Calendar Tool] get_calendar_activities args:", { startDate, endDate, dateQuery, includeAttendees, effectiveFrom, effectiveTo });

          const data = await getCalendarActivities(passKey, orgId, {
            from: effectiveFrom,
            to: effectiveTo,
            includeAttendees: includeAttendees !== false
          }, dependencies);
          
          return JSON.stringify({
            activities: data.activities,
            dateRange: { from: data.from, to: data.to },
            count: data.count
          });
        } catch (error) {
          console.error("[Calendar Tool] Error fetching activities:", error);
          return JSON.stringify({ 
            error: `Failed to fetch calendar activities: ${error.message}` 
          });
        }
      },
      {
        name: "get_calendar_activities",
        description: "Fetch calendar activities (appointments, meetings, events) with date range filtering. Supports natural language dates like 'this week', 'next month', 'last 7 days', etc. Returns activities in native BSA format with Type, Activity, and Attendees objects.",
        schema: z.object({
          startDate: z.string().optional().describe("Start date in YYYY-MM-DD format"),
          endDate: z.string().optional().describe("End date in YYYY-MM-DD format"),
          dateQuery: z.string().optional().describe("Natural language date query like 'this week', 'next month', 'last 7 days', 'this quarter', etc."),
          includeAttendees: z.boolean().optional().describe("Whether to include attendees in response (default true)")
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
        description: "Fetch contact details for one or more contact IDs using the getMultiple endpoint. Works with a single ID or array of IDs. Use this after getting ContactIds from appointments.",
        schema: z.object({
          contactIds: z.array(z.string()).describe("Array of contact IDs to fetch (can be a single ID in an array, e.g., ['single-id'])"),
          includeExtendedProperties: z.boolean().optional().describe("Include custom properties (default false)")
        })
      }
    )
  ];
}

// Create Calendar Agent
async function createCalendarAgent(passKey, orgId, timeZone = "UTC", dependencies) {
  const { getLLMClient } = dependencies;
  
  // Dynamic imports for LangChain and Zod
  const { z } = await import("zod");
  const { tool } = await import("@langchain/core/tools");
  const { AgentExecutor, createToolCallingAgent } = await import("langchain/agents");
  const { ChatPromptTemplate, MessagesPlaceholder } = await import("@langchain/core/prompts");
  
  // Use cached LLM client for better performance
  const llm = await getLLMClient();
  
  const tools = createCalendarTools(tool, z, passKey, orgId, timeZone, dependencies);
  
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
  console.log(`[Agent] Time context: Today is ${currentDate} at ${currentTime} ${timeZone}`);

  // Format the prompt with current date/time context
  const formattedPrompt = CALENDAR_PROMPT
    .replace(/{currentDate}/g, currentDate)
    .replace(/{currentTime}/g, currentTime)
    .replace(/{timeZone}/g, timeZone);

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
  
  return new AgentExecutor({
    agent,
    tools,
    verbose: false
  });
}

// Module exports
module.exports = {
  createCalendarAgent,
  createCalendarTools,
  getCalendarActivities,
  getContactsByIds,
  CALENDAR_PROMPT
};