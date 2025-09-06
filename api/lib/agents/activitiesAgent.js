// Activities Agent Module for BSA Integration
// Unified agent for managing both calendar appointments and tasks
// Supports appointments-only, tasks-only, or mixed queries
// Now includes appointment creation and attendee linking capabilities

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

TOOLS AVAILABLE (4 total):
1. get_activities - Fetches appointments and/or tasks based on parameters
2. get_contact_details - Resolves contact information for attendees
3. create_appointment - Creates a new calendar appointment
4. link_attendees - Links contacts, companies, or users to an appointment

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

CREATING APPOINTMENTS:
You can create new appointments using the create_appointment tool. Examples:
- "Create a meeting tomorrow at 2pm for 30 minutes" - Parse the natural language date/time
- "Schedule a call with John next Monday from 10-11am" - Convert to proper timestamps
- "Book a team meeting in Conference Room A" - Include location details

After creating an appointment, you can link attendees using the link_attendees tool:
- Provide the appointment ID from creation
- Specify contacts, companies, or users to link
- The tool handles the proper linker types automatically
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

// Create a new appointment using BSA create endpoint
async function createAppointment(passKey, orgId, appointmentData, dependencies) {
  const { axios, axiosConfig, BSA_BASE, normalizeBSAResponse } = dependencies;
  
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;
  
  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "appointment",
    DataObject: {
      Subject: appointmentData.subject,
      Description: appointmentData.description || null,
      StartTime: appointmentData.startTime,
      EndTime: appointmentData.endTime,
      Location: appointmentData.location || null,
      AllDay: appointmentData.allDay || false,
      Complete: false,
      AppointmentTypeId: appointmentData.appointmentTypeId || null
    },
    IncludeExtendedProperties: false
  };

  console.log("[createAppointment] Creating appointment:", payload.DataObject.Subject);
  
  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);

  if (!normalized.valid) {
    throw new Error(normalized.error || 'Failed to create appointment');
  }

  const created = normalized.data;
  console.log("[createAppointment] Created with ID:", created.Id);
  
  return {
    id: created.Id,
    subject: created.Subject,
    startTime: created.StartTime,
    endTime: created.EndTime,
    location: created.Location,
    description: created.Description,
    createdOn: created.CreatedOn
  };
}

// Link an attendee to an appointment using BSA link endpoint
async function linkAttendeeToAppointment(passKey, orgId, appointmentId, attendeeId, attendeeType, dependencies) {
  const { axios, axiosConfig, BSA_BASE, normalizeBSAResponse } = dependencies;
  
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/link.json`;
  
  // Determine the correct linker type and right object name based on attendee type
  let linkerType, rightObjectName;
  switch (attendeeType.toLowerCase()) {
    case 'contact':
      linkerType = 'linker_appointments_contacts';
      rightObjectName = 'contact';
      break;
    case 'company':
      linkerType = 'linker_appointments_companies';
      rightObjectName = 'company';
      break;
    case 'user':
      linkerType = 'linker_appointments_users';
      rightObjectName = 'organization_user';
      break;
    default:
      throw new Error(`Invalid attendee type: ${attendeeType}. Must be 'contact', 'company', or 'user'`);
  }
  
  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: linkerType,
    LeftObjectName: "appointment",
    LeftId: appointmentId,
    RightObjectName: rightObjectName,
    RightId: attendeeId
  };

  console.log(`[linkAttendee] Linking ${attendeeType} ${attendeeId} to appointment ${appointmentId}`);
  
  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);

  if (!normalized.valid) {
    throw new Error(normalized.error || `Failed to link ${attendeeType} to appointment`);
  }

  return {
    success: true,
    appointmentId,
    attendeeId,
    attendeeType,
    linkerId: normalized.data?.Id
  };
}

// Batch link multiple attendees to an appointment
async function linkMultipleAttendees(passKey, orgId, appointmentId, attendees, dependencies) {
  const results = [];
  const errors = [];
  
  // Process contacts
  if (attendees.contactIds && Array.isArray(attendees.contactIds)) {
    for (const contactId of attendees.contactIds) {
      try {
        const result = await linkAttendeeToAppointment(passKey, orgId, appointmentId, contactId, 'contact', dependencies);
        results.push(result);
      } catch (error) {
        errors.push({ type: 'contact', id: contactId, error: error.message });
      }
    }
  }
  
  // Process companies
  if (attendees.companyIds && Array.isArray(attendees.companyIds)) {
    for (const companyId of attendees.companyIds) {
      try {
        const result = await linkAttendeeToAppointment(passKey, orgId, appointmentId, companyId, 'company', dependencies);
        results.push(result);
      } catch (error) {
        errors.push({ type: 'company', id: companyId, error: error.message });
      }
    }
  }
  
  // Process users
  if (attendees.userIds && Array.isArray(attendees.userIds)) {
    for (const userId of attendees.userIds) {
      try {
        const result = await linkAttendeeToAppointment(passKey, orgId, appointmentId, userId, 'user', dependencies);
        results.push(result);
      } catch (error) {
        errors.push({ type: 'user', id: userId, error: error.message });
      }
    }
  }
  
  return {
    appointmentId,
    linked: results,
    errors,
    totalLinked: results.length,
    totalErrors: errors.length
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
    ),
    
    // Tool 3: Create a new appointment
    tool(
      async ({ subject, description, startTime, endTime, location, allDay, dateQuery, duration }) => {
        try {
          // Validate required fields
          if (!subject) {
            return JSON.stringify({ 
              error: "Subject is required for creating an appointment" 
            });
          }
          
          // Handle natural language date parsing if dateQuery is provided
          if (dateQuery && (!startTime || !endTime)) {
            const parsed = parseDateQuery(dateQuery, timeZone);
            if (parsed) {
              // Use parsed dates as starting point
              if (!startTime) {
                // Default to 9 AM in the user's timezone for the start date
                const startDate = new Date(parsed.startDate + 'T09:00:00');
                startTime = startDate.toISOString();
              }
              if (!endTime && startTime) {
                // Default to 1 hour duration if not specified
                const start = new Date(startTime);
                const durationMs = duration ? duration * 60000 : 60 * 60000; // duration in minutes or default 60 min
                const end = new Date(start.getTime() + durationMs);
                endTime = end.toISOString();
              }
            }
          }
          
          // Ensure we have both startTime and endTime
          if (!startTime || !endTime) {
            return JSON.stringify({ 
              error: "Both startTime and endTime are required. Provide them in ISO format or use dateQuery with duration." 
            });
          }
          
          // Convert to ISO format if needed
          const ensureISO = (dateStr) => {
            const date = new Date(dateStr);
            return date.toISOString();
          };
          
          const appointmentData = {
            subject,
            description: description || null,
            startTime: ensureISO(startTime),
            endTime: ensureISO(endTime),
            location: location || null,
            allDay: allDay || false
          };
          
          console.log("[create_appointment Tool] Creating appointment:", appointmentData);
          
          const result = await createAppointment(passKey, orgId, appointmentData, dependencies);
          
          return JSON.stringify({
            success: true,
            appointment: result,
            message: `Appointment "${result.subject}" created successfully`,
            id: result.id
          });
          
        } catch (error) {
          console.error("[create_appointment Tool] Error:", error);
          return JSON.stringify({ 
            success: false,
            error: `Failed to create appointment: ${error.message}` 
          });
        }
      },
      {
        name: "create_appointment",
        description: "Create a new calendar appointment. Supports natural language dates via dateQuery parameter.",
        schema: z.object({
          subject: z.string().describe("The subject/title of the appointment (required)"),
          description: z.string().optional().describe("Detailed description of the appointment"),
          startTime: z.string().optional().describe("Start time in ISO format (e.g., 2025-09-10T14:00:00Z)"),
          endTime: z.string().optional().describe("End time in ISO format (e.g., 2025-09-10T15:00:00Z)"),
          location: z.string().optional().describe("Location of the appointment"),
          allDay: z.boolean().optional().describe("Whether this is an all-day event (default: false)"),
          dateQuery: z.string().optional().describe("Natural language date like 'tomorrow at 2pm' or 'next Monday'"),
          duration: z.number().optional().describe("Duration in minutes (used with dateQuery if endTime not specified)")
        })
      }
    ),
    
    // Tool 4: Link attendees to an appointment
    tool(
      async ({ appointmentId, contactIds, companyIds, userIds }) => {
        try {
          // Validate that we have an appointment ID
          if (!appointmentId) {
            return JSON.stringify({ 
              error: "appointmentId is required to link attendees" 
            });
          }
          
          // Validate that we have at least one type of attendee
          if ((!contactIds || contactIds.length === 0) && 
              (!companyIds || companyIds.length === 0) && 
              (!userIds || userIds.length === 0)) {
            return JSON.stringify({ 
              error: "At least one attendee (contact, company, or user) must be provided" 
            });
          }
          
          const attendees = {
            contactIds: contactIds || [],
            companyIds: companyIds || [],
            userIds: userIds || []
          };
          
          console.log("[link_attendees Tool] Linking attendees to appointment:", appointmentId, attendees);
          
          const result = await linkMultipleAttendees(passKey, orgId, appointmentId, attendees, dependencies);
          
          // Prepare a summary message
          let message = `Successfully linked ${result.totalLinked} attendee(s) to appointment ${appointmentId}`;
          if (result.totalErrors > 0) {
            message += ` (${result.totalErrors} error(s) occurred)`;
          }
          
          return JSON.stringify({
            success: result.totalErrors === 0,
            ...result,
            message
          });
          
        } catch (error) {
          console.error("[link_attendees Tool] Error:", error);
          return JSON.stringify({ 
            success: false,
            error: `Failed to link attendees: ${error.message}` 
          });
        }
      },
      {
        name: "link_attendees",
        description: "Link contacts, companies, or users as attendees to an existing appointment",
        schema: z.object({
          appointmentId: z.string().describe("The ID of the appointment to link attendees to (required)"),
          contactIds: z.array(z.string()).optional().describe("Array of contact IDs to link as attendees"),
          companyIds: z.array(z.string()).optional().describe("Array of company IDs to link as attendees"),
          userIds: z.array(z.string()).optional().describe("Array of user IDs to link as attendees")
        })
      }
    )
  ];
}

// Create Activities Agent
async function createActivitiesAgent(passKey, orgId, timeZone = "UTC", dependencies) {
  const { getLLMClient } = dependencies;
  
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

  // Format the prompt with current date/time context
  const formattedPrompt = ACTIVITIES_PROMPT
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
  
  // Configure executor with LangSmith tracing if available
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
      timeZone
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
  createAppointment,
  linkAttendeeToAppointment,
  linkMultipleAttendees,
  ACTIVITIES_PROMPT
};