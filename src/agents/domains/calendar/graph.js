/**
 * Calendar Subgraph - Domain-specific graph for calendar operations
 * 
 * Handles all calendar-related queries including:
 * - Viewing appointments
 * - Creating new appointments
 * - Updating existing appointments
 * - Managing attendees
 */

const { StateGraph, END, interrupt } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { z } = require("zod");
const { parseDateQuery, parseDateTimeQuery, calculateEndTime } = require("../../../utils/chronoParser");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);
const { getAppointments, createAppointment, updateAppointment } = require("../../../integrations/bsa/tools/appointments");
const { getContactResolver } = require("../../../services/entities/contactResolverCompat");
const { getUserResolver } = require("../../../services/entities/userResolverCompat");
const { getApprovalBatcher } = require("../../../services/approval/approvalBatcher");
const { getMem0Service } = require("../../../services/memory/mem0Service");
const { getCalendarTools, createAppointmentTool } = require("./tools");
const { getPassKeyManager } = require("../../../core/auth/passkey");
const { getTeamMemberCache } = require("../../../services/cache/teamMemberCache");

// State channels for calendar operations (LangGraph compatible)
const CalendarStateChannels = {
  messages: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  memory_context: {
    value: (x, y) => y ? y : x,
    default: () => ({})
  },
  entities: {
    value: (x, y) => y ? y : x,
    default: () => ({})
  },

  // Calendar-specific fields
  action: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  date_range: {
    value: (x, y) => y ? y : x,
    default: () => ({ start: null, end: null })
  },
  appointments: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  appointment_data: {
    value: (x, y) => y ? y : x,
    default: () => ({})
  },
  contacts_to_resolve: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  resolved_contacts: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  users_to_resolve: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  resolved_users: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  unresolved_contacts: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  unresolved_users: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  conflicts: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  preview: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  approved: {
    value: (x, y) => y ? y : x,
    default: () => false
  },
  requiresApproval: {
    value: (x, y) => y !== undefined ? y : x,
    default: () => false
  },
  approvalContext: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  approvalRequest: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  approval_decision: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  _pendingData: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  response: {
    value: (x, y) => y ? y : x,
    default: () => ""
  },
  error: {
    value: (x, y) => y ? y : x,
    default: () => null
  },

  // Clarification-related fields
  needsClarification: {
    value: (x, y) => y !== undefined ? y : x,
    default: () => false
  },
  clarificationType: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  clarificationData: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  // Resume fields for clarification responses
  contact_clarification_response: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  user_clarification_response: {
    value: (x, y) => y ? y : x,
    default: () => null
  },

  // Context fields (required for authentication and state management)
  session_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  org_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  user_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  thread_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  timezone: {
    value: (x, y) => y ? y : x,
    default: () => 'UTC'
  }
};

class CalendarSubgraph {
  constructor(checkpointer = null) {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.3
    });

    this.contactResolver = getContactResolver();
    this.userResolver = getUserResolver();
    this.approvalBatcher = getApprovalBatcher();
    this.mem0 = getMem0Service();
    this.passKeyManager = getPassKeyManager();
    this.checkpointer = checkpointer;

    // Tool-calling support (Phase 1: Read-only tools)
    this.tools = getCalendarTools();

    this.graph = this.buildGraph();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: CalendarStateChannels  // Use state channels instead of Zod schema
    });

    // Add nodes
    workflow.addNode("parse_request", this.parseRequest.bind(this));
    workflow.addNode("resolve_contacts", this.resolveContacts.bind(this));
    workflow.addNode("resolve_users", this.resolveUsers.bind(this));
    workflow.addNode("fetch_appointments", this.fetchAppointments.bind(this));
    workflow.addNode("check_conflicts", this.checkConflicts.bind(this));
    workflow.addNode("generate_preview", this.generatePreview.bind(this));
    workflow.addNode("approval", this.approvalNode.bind(this));
    workflow.addNode("create_appointment", this.createAppointmentNode.bind(this));
    workflow.addNode("update_appointment", this.updateAppointmentNode.bind(this));
    workflow.addNode("link_attendees", this.linkAttendees.bind(this));
    workflow.addNode("synthesize_memory", this.synthesizeMemory.bind(this));
    workflow.addNode("format_response", this.formatResponse.bind(this));
    // Phase 1: Tool-calling handler for view operations
    workflow.addNode("handle_query_tool_calling", this.handleQueryToolCalling.bind(this));

    // Define flow
    workflow.setEntryPoint("parse_request");
    
    // Route based on action
    workflow.addConditionalEdges(
      "parse_request",
      (state) => {
        console.log("[CALENDAR:ROUTER] After parse_request:", {
          hasError: !!state.error,
          action: state.action,
          contactsToResolve: state.contacts_to_resolve?.length || 0,
          usersToResolve: state.users_to_resolve?.length || 0
        });

        if (state.error) return "format_response";

        // Phase 1-2: Use tool-calling for view and create operations
        if (state.action === "view") {
          console.log("[CALENDAR:ROUTER] View action - using tool-calling path");
          return "handle_query_tool_calling";
        }

        if (state.action === "create") {
          // Phase 2: Use tool-calling for create operations (preview + approval)
          console.log("[CALENDAR:ROUTER] Create action - using tool-calling path (Phase 2)");
          return "handle_query_tool_calling";

          // OLD CODE (commented out for Phase 2-3 migration):
          // Determine next node based on what needs resolution
          // let nextNode;
          // if (state.users_to_resolve?.length > 0) {
          //   nextNode = "resolve_users";
          // } else if (state.contacts_to_resolve?.length > 0) {
          //   nextNode = "resolve_contacts";
          // } else {
          //   nextNode = "check_conflicts";
          // }
          // console.log(`[CALENDAR:ROUTER] Create action routing to: ${nextNode}`);
          // return nextNode;
        }
        if (state.action === "update") return "fetch_appointments";
        return "format_response";
      },
      {
        "fetch_appointments": "fetch_appointments",
        "handle_query_tool_calling": "handle_query_tool_calling",
        "resolve_contacts": "resolve_contacts",
        "resolve_users": "resolve_users",
        "check_conflicts": "check_conflicts",
        "format_response": "format_response"
      }
    );

    // User resolution flow - check if clarification is needed or contacts need resolution
    workflow.addConditionalEdges(
      "resolve_users",
      (state) => {
        // If user clarification is needed, go to format_response to return early
        if (state.needsClarification) {
          console.log("[CALENDAR:ROUTER] User clarification needed - returning early");
          return "format_response";
        }
        // If contacts need resolution, go to resolve_contacts
        if (state.contacts_to_resolve?.length > 0) {
          return "resolve_contacts";
        }
        // Otherwise continue to check conflicts
        return "check_conflicts";
      },
      {
        "format_response": "format_response",
        "resolve_contacts": "resolve_contacts",
        "check_conflicts": "check_conflicts"
      }
    );

    // Contact resolution flow - check if clarification is needed
    workflow.addConditionalEdges(
      "resolve_contacts",
      (state) => {
        // If clarification is needed, go to format_response to return early
        if (state.needsClarification) {
          console.log("[CALENDAR:ROUTER] Contact clarification needed - returning early");
          return "format_response";
        }
        // Otherwise continue to check conflicts
        return "check_conflicts";
      },
      {
        "format_response": "format_response",
        "check_conflicts": "check_conflicts"
      }
    );
    
    // View flow
    workflow.addConditionalEdges(
      "fetch_appointments",
      (state) => {
        if (state.action === "view") return "format_response";
        if (state.action === "update") return "generate_preview";
        return "format_response";
      },
      {
        "format_response": "format_response",
        "generate_preview": "generate_preview"
      }
    );
    
    // Creation flow
    workflow.addEdge("check_conflicts", "generate_preview");
    workflow.addEdge("generate_preview", "approval");
    
    workflow.addConditionalEdges(
      "approval",
      (state) => {
        // If approval is required, format response and return to coordinator
        if (state.requiresApproval) {
          console.log("[CALENDAR:ROUTER] Approval required - formatting response for coordinator");
          return "format_response";
        }
        // Otherwise continue with normal flow
        if (!state.approved) return "format_response";
        if (state.action === "create") return "create_appointment";
        if (state.action === "update") return "update_appointment";
        return "format_response";
      },
      {
        "create_appointment": "create_appointment",
        "update_appointment": "update_appointment",
        "format_response": "format_response"
      }
    );
    
    workflow.addEdge("create_appointment", "link_attendees");
    workflow.addEdge("update_appointment", "link_attendees");
    workflow.addEdge("link_attendees", "synthesize_memory");
    workflow.addEdge("synthesize_memory", "format_response");
    workflow.addEdge("format_response", END);
    // Phase 1: Tool-calling path goes directly to END (returns final response)
    workflow.addEdge("handle_query_tool_calling", END);

    // Always compile WITHOUT checkpointer - subgraphs are stateless
    // This prevents deadlocks from concurrent checkpoint writes
    const compileOptions = {};
    console.log("[CALENDAR] Compiling graph in STATELESS mode (no checkpointer)");

    return workflow.compile(compileOptions);
  }

  /**
   * Parse the user request to determine action and parameters
   */
  async parseRequest(state) {
    console.log("[CALENDAR:PARSE] Parsing user request");

    // Log incoming state for debugging
    console.log("[CALENDAR:PARSE] State check:", {
      hasContactClarification: !!state.contact_clarification_response,
      hasUserClarification: !!state.user_clarification_response,
      hasAction: !!state.action,
      action: state.action,
      hasAppointmentData: !!state.appointment_data,
      hasDateRange: !!state.date_range,
      contactsToResolve: state.contacts_to_resolve?.length || 0,
      usersToResolve: state.users_to_resolve?.length || 0
    });

    // CRITICAL: Check if we're resuming from clarification with existing context
    // If we have clarification response AND existing appointment data, skip parsing
    // This preserves the action and data from the first invocation
    if (state.contact_clarification_response || state.user_clarification_response) {
      if (state.action && (state.appointment_data || state.date_range)) {
        console.log("[CALENDAR:PARSE] Resuming from clarification - using existing context");
        console.log("[CALENDAR:PARSE] Preserved action:", state.action);
        console.log("[CALENDAR:PARSE] Has appointment_data:", !!state.appointment_data);
        console.log("[CALENDAR:PARSE] Has date_range:", !!state.date_range);

        // Return state as-is, let the routing logic proceed to resolution
        // The clarification response will be processed by resolve_contacts or resolve_users
        return state;
      }
    }

    // Safety check for messages array
    if (!state.messages || !Array.isArray(state.messages) || state.messages.length === 0) {
      console.error("[CALENDAR:PARSE] No messages in state:", {
        hasMessages: !!state.messages,
        isArray: Array.isArray(state.messages),
        length: state.messages?.length || 0
      });
      return { ...state, error: "No messages found in state" };
    }

    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      return { ...state, error: "No user message found" };
    }

    const userQuery = lastMessage.content;
    const userTimezone = state.timezone || 'UTC';

    try {
      // Check if this might be a correction for a previously unresolved name
      let isCorrection = false;
      let correctionContext = null;

      if (state.memory_context?.recalled_memories?.length > 0) {
        // Look for mentions of unresolved names in recent memory
        for (const memory of state.memory_context.recalled_memories) {
          const content = memory.content || memory.value?.text || '';
          if (content.includes('Could not find')) {
            // Extract the unresolved name from memory
            const unresolvedMatch = content.match(/Could not find (?:contact|user) "([^"]+)"/);
            if (unresolvedMatch) {
              const unresolvedName = unresolvedMatch[1];

              // Check if current message might be a correction
              const words = userQuery.toLowerCase().split(/\s+/);
              if (words.length <= 3 && !words.includes('appointment') && !words.includes('meeting')) {
                isCorrection = true;
                correctionContext = {
                  original: unresolvedName,
                  correction: userQuery.trim(),
                  type: content.includes('contact') ? 'contact' : 'user'
                };
                console.log(`[CALENDAR:PARSE] Detected possible correction: "${unresolvedName}" -> "${userQuery}"`);
              }
            }
          }
        }
      }

      // If this is a correction, return it for special handling
      if (isCorrection && correctionContext) {
        return {
          ...state,
          action: 'correction',
          correction_context: correctionContext,
          response: `I'll note that "${correctionContext.correction}" is the correct spelling. Please try your request again with the correct name.`
        };
      }

      // First, try to parse date/time directly from the query
      const dateTimeResult = parseDateTimeQuery(userQuery, userTimezone);

      // Fetch team member context from database (with caching) for intelligent classification
      let teamMemberContext = "";
      try {
        const orgId = state.org_id || config?.configurable?.org_id;
        if (orgId) {
          const cache = getTeamMemberCache();

          // Try cache first
          let teamMembers = cache.get(orgId);

          if (!teamMembers) {
            // Cache miss - fetch from database
            console.log(`[CALENDAR:PARSE] Fetching team members for org: ${orgId}`);
            teamMembers = await this.userResolver.userSyncService.getOrganizationUsers(orgId);

            // Cache the result
            if (teamMembers && teamMembers.length > 0) {
              cache.set(orgId, teamMembers);
            }
          }

          if (teamMembers && teamMembers.length > 0) {
            // Format as simple list for LLM context
            const memberList = teamMembers
              .map(u => {
                const name = u.full_name || `${u.first_name || ''} ${u.last_name || ''}`.trim();
                const title = u.job_title || '';
                return title ? `${name} - ${title}` : name;
              })
              .filter(Boolean)
              .join('\n        ');

            teamMemberContext = `\n\n        YOUR ORGANIZATION'S TEAM MEMBERS:\n        ${memberList}\n        `;
            console.log(`[CALENDAR:PARSE] Loaded ${teamMembers.length} team members into context`);
          } else {
            console.log('[CALENDAR:PARSE] No team members found');
          }
        } else {
          console.warn('[CALENDAR:PARSE] No org_id available to fetch team members');
        }
      } catch (error) {
        console.warn('[CALENDAR:PARSE] Could not fetch team members:', error.message);
        // Continue without team context - LLM will default to contacts
      }

      // Build conversation context - full message window (no artificial limits)
      let conversationHistory = '';

      // RECENT CONVERSATION: Last 50 messages (25 turns)
      if (state.messages && state.messages.length > 1) {
        conversationHistory = '\n\nRECENT CONVERSATION (search through ALL messages for pronoun resolution):\n';
        const recentMessages = state.messages.slice(-50); // Increased from 10 to 50
        recentMessages.forEach((msg, idx) => {
          conversationHistory += `  ${idx + 1}. ${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
        });
      }

      // ENTITY CONTEXT: Track people mentioned
      let entityContext = '\n\nENTITY CONTEXT:\n';
      if (state.entities?.last_contact) {
        const contactName = state.entities.last_contact.name || state.entities.last_contact.data?.name;
        entityContext += `LAST MENTIONED: ${contactName}\n`;
      }
      if (state.entities?.conversation_context?.data?.people_mentioned?.length > 0) {
        const peopleMentioned = state.entities.conversation_context.data.people_mentioned;
        entityContext += `ALL MENTIONED: ${peopleMentioned.join(', ')}\n`;
      }
      if (!state.entities?.last_contact && !state.entities?.conversation_context) {
        entityContext += '(no entity context)\n';
      }

      // Add people mentioned hint from entity context
      let peopleHint = '';
      if (state.entities?.conversation_context?.data?.people_mentioned?.length > 0) {
        const people = state.entities.conversation_context.data.people_mentioned;
        peopleHint = `\n\n🔍 PEOPLE IN THIS CONVERSATION: ${people.join(', ')}\nUse this list to resolve pronouns like "them", "both", "they", etc.`;
      }

      // Enhanced pronoun resolution instructions
      entityContext += `\nIMPORTANT PRONOUN RESOLUTION:
- You have access to the FULL conversation history above (all numbered messages)
- "first person mentioned" = find earliest name in numbered messages (lowest number)
- "second person mentioned" = find second name in numbered messages
- "both of them" / "both" / "all of them" = ALL people in conversation (see PEOPLE IN CONVERSATION list)
- "them" / "they" = ALL people mentioned in conversation
- "he/she/him/her" = check LAST MENTIONED and recent context
- Search through ALL messages, not just recent ones
${peopleHint}
`;

      // Use LLM to extract other details
      const parsePrompt = `
        Analyze this calendar-related query and extract:
        1. Action: view, create, update, or delete
        2. Appointment details (if creating/updating)
        3. Contact names mentioned (EXTERNAL people NOT in your team)
        4. User names mentioned (INTERNAL team members from list below)
        5. Self-references like "me", "myself", "I"
        6. Keep the EXACT date/time expression as the user stated it
        7. **IMPORTANT: If the query contains pronouns (his, her, their, he, she, they), look at the conversation history below to determine who they refer to, then use the actual person's name**
        ${teamMemberContext}${conversationHistory}${entityContext}
        Current Query: "${userQuery}"

        Return JSON:
        {
          "action": "view|create|update|delete",
          "date_query": "EXACT date/time text from user (e.g., 'tomorrow at 8am')",
          "appointment": {
            "subject": "meeting title",
            "description": "details",
            "location": "where",
            "duration": "in minutes",
            "isAllDay": boolean
          },
          "contacts": ["external person names NOT in team list"],
          "users": ["internal team member names FROM team list above"],
          "selfReferences": ["me", "myself", "I"] // if user refers to themselves
        }

        IMPORTANT:
        - For date_query, preserve EXACTLY what the user said, including the time.
        - Check the "YOUR ORGANIZATION'S TEAM MEMBERS" list above (if present)
        - If a name matches someone in that list, put it in "users" array
        - If a name is NOT in that list, put it in "contacts" array
        - Detect self-references like "me", "myself", "I" and list them in selfReferences

        Examples:
        - "Schedule a meeting with John and Sarah"
          → If "John Smith" is in team list and Sarah is not:
          → contacts: ["Sarah"], users: ["John Smith"]

        - "Book time with Sarah and me"
          → If "Sarah Johnson" is in team list:
          → users: ["Sarah Johnson"], selfReferences: ["me"]

        - "Appointment with client Bob"
          → If Bob is not in team list:
          → contacts: ["Bob"]

        - "Meeting with team member Alice"
          → users: ["Alice"] (explicit team member reference)

        CRITICAL PRONOUN RESOLUTION EXAMPLES (search ALL 50 numbered messages above):
        - Conversation: "1. User: I'm working with Norman Albertson", "3. User: also Clara Basile"
          Query: "schedule meeting with both of them tomorrow at 2pm"
          → contacts: ["Norman Albertson", "Clara Basile"] ✅ (resolve "both of them" to ALL people)

        - Conversation: "1. User: working with Norman", later messages with Clara
          Query: "schedule meeting with him tomorrow"
          → contacts: ["Norman Albertson"] (resolve "him" to Norman)

        - Conversation: Multiple people mentioned across many messages
          Query: "meeting with them next week"
          → Find ALL names in conversation, add to contacts array

        - Conversation: "1. User: working with Norman", "5. User: also Clara"
          Query: "schedule with the first person I mentioned"
          → contacts: ["Norman Albertson"] (FIRST = EARLIEST message number)

        IMPORTANT: Always return FULL NAMES (First Last), not just first names.
      `;

      const response = await this.llm.invoke(parsePrompt);

      // Extract JSON from response (handle markdown code blocks)
      let jsonContent = response.content;
      if (jsonContent.includes('```json')) {
        jsonContent = jsonContent.split('```json')[1].split('```')[0].trim();
      } else if (jsonContent.includes('```')) {
        jsonContent = jsonContent.split('```')[1].split('```')[0].trim();
      }

      const parsed = JSON.parse(jsonContent);

      console.log("[CALENDAR:PARSE] Detected action:", parsed.action);
      console.log("[CALENDAR:PARSE] Date query:", parsed.date_query);

      // Prepare appointment data if creating
      let appointmentData = null;
      if (parsed.action === "create" || parsed.action === "update") {
        // Try to parse the date/time from the extracted date_query
        let startTime = null;
        let endTime = null;

        if (parsed.date_query) {
          const parsedDateTime = parseDateTimeQuery(parsed.date_query, userTimezone);

          if (parsedDateTime && parsedDateTime.hasTime) {
            // We have both date and time
            startTime = parsedDateTime.startDateTime;
            const duration = parsed.appointment?.duration || 60; // Default 60 minutes
            endTime = calculateEndTime(startTime, duration);
            console.log("[CALENDAR:PARSE] Parsed date/time:", parsedDateTime.interpreted);
          } else if (parsedDateTime && parsedDateTime.dateComponent) {
            // We have date but no time - use default business hours
            const dateOnly = parsedDateTime.dateComponent.startDate;
            // Build 9:00 AM in the user's timezone, then convert to ISO (UTC)
            startTime = dayjs.tz(`${dateOnly} 09:00`, userTimezone).toISOString();
            const duration = parsed.appointment?.duration || 60;
            endTime = calculateEndTime(startTime, duration);
            console.log("[CALENDAR:PARSE] Date only, using 9 AM default");
          }
        }

        // Fallback if date parsing failed
        if (!startTime) {
          const now = new Date();
          const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          tomorrow.setHours(9, 0, 0, 0);
          startTime = tomorrow.toISOString();
          endTime = calculateEndTime(startTime, parsed.appointment?.duration || 60);
          console.log("[CALENDAR:PARSE] No date found, defaulting to tomorrow 9 AM");
        }

        appointmentData = {
          subject: parsed.appointment?.subject || "New Appointment",
          description: parsed.appointment?.description || "",
          startTime: startTime,
          endTime: endTime,
          location: parsed.appointment?.location || "",
          isAllDay: parsed.appointment?.isAllDay || false,
          // Preserve the original date query for applier compatibility
          dateQuery: parsed.date_query
        };
      }

      // Parse dates for viewing
      let dateRange = {};
      if (parsed.action === "view" && parsed.date_query) {
        const parsedDates = parseDateQuery(parsed.date_query, userTimezone);
        if (parsedDates) {
          dateRange = {
            start: parsedDates.startDate,
            end: parsedDates.endDate
          };
        }
      }

      // Combine users and self-references
      const usersToResolve = [
        ...(parsed.users || []),
        ...(parsed.selfReferences || [])
      ];

      const result = {
        ...state,
        action: parsed.action,
        date_range: dateRange,
        appointment_data: appointmentData,
        contacts_to_resolve: parsed.contacts || [],
        users_to_resolve: usersToResolve
      };

      console.log("[CALENDAR:PARSE] Returning state:", {
        action: result.action,
        hasDateRange: !!result.date_range,
        hasAppointmentData: !!result.appointment_data,
        contactsToResolve: result.contacts_to_resolve?.length || 0,
        usersToResolve: result.users_to_resolve?.length || 0,
        hasError: !!result.error
      });

      return result;

    } catch (error) {
      console.error("[CALENDAR:PARSE] Error parsing request:", error);
      return {
        ...state,
        error: `Failed to understand request: ${error.message}`
      };
    }
  }

  /**
   * Resolve user names to IDs (internal team members)
   */
  async resolveUsers(state, config) {
    console.log("[CALENDAR:USERS] Resolving users");
    console.log("[CALENDAR:USERS] Users to resolve:", state.users_to_resolve);

    // Check if we're resuming from user DISAMBIGUATION (user selected from multiple)
    if (state.user_clarification_response?.selected_user) {
      // VALIDATE: Only use if this is actually a resume scenario
      // Reject stale responses from previous queries
      if (!state.user_selected && !state.users_to_resolve?.length) {
        console.warn("[CALENDAR:USERS] Ignoring stale user_clarification_response from previous query");
        state.user_clarification_response = null;
      } else {
        console.log("[CALENDAR:USERS] Resuming with user-selected team member from disambiguation");

        const selectedUser = state.user_clarification_response.selected_user;
        const resolved = state.resolved_users || [];

        // Add the selected user to resolved list if not already present
        if (!resolved.some(u => u.id === selectedUser.id)) {
          resolved.push(selectedUser);
          console.log(`[CALENDAR:USERS] Added selected user: ${selectedUser.name} (${selectedUser.id})`);
        }

        // Filter out already-resolved users from to-resolve list to prevent re-resolution
        const remainingUsers = state.users_to_resolve.filter(name => {
          const alreadyResolved = resolved.some(u =>
            u.name?.toLowerCase() === name.toLowerCase()
          );
          if (alreadyResolved) {
            console.log(`[CALENDAR:USERS] Removing already-resolved user from to-resolve list: ${name}`);
          }
          return !alreadyResolved;
        });

        return {
          ...state,
          resolved_users: resolved,
          user_clarification_response: null,  // Clear after processing
          user_selected: false,  // Clear flag
          users_to_resolve: remainingUsers  // Only keep unresolved users
        };
      }
    }

    // Check if we're resuming from a user clarification (text response)
    if (state.user_clarification_response) {
      // VALIDATE: Only process if we have users to resolve
      if (!state.users_to_resolve || state.users_to_resolve.length === 0) {
        console.warn("[CALENDAR:USERS] Ignoring stale text clarification response - no users to resolve");
        state.user_clarification_response = null;
      } else {
        console.log("[CALENDAR:USERS] Resuming with clarification:", state.user_clarification_response);

        const clarifiedName = state.user_clarification_response.clarified_name;
        const originalQuery = state.user_clarification_response.original_query;
        const skipUser = state.user_clarification_response.skip;

        if (!skipUser && clarifiedName && clarifiedName.toLowerCase() !== 'skip') {
          // Replace the original query with the clarified name in users_to_resolve
          console.log(`[CALENDAR:USERS] Replacing "${originalQuery}" with "${clarifiedName}"`);

          const updatedUsers = state.users_to_resolve.map(name =>
            name === originalQuery ? clarifiedName : name
          );

          // Update state and fall through to normal search logic
          // (don't return - we need to actually search for the clarified name!)
          state = {
            ...state,
            users_to_resolve: updatedUsers,
            user_clarification_response: null
          };

          // Fall through to search logic below
        } else {
          // User chose to skip this user
          console.log(`[CALENDAR:USERS] User chose to skip user: ${originalQuery}`);

          // Remove the skipped user from the list
          // Also check if any other users in the list are already resolved (to prevent re-resolution)
          const resolved = state.resolved_users || [];
          const remainingUsers = state.users_to_resolve.filter(name => {
            // Keep only users that are NOT the skipped one AND NOT already resolved
            if (name === originalQuery) return false;
            // Check if already resolved by matching name (case-insensitive)
            const alreadyResolved = resolved.some(u =>
              u.name?.toLowerCase() === name.toLowerCase()
            );
            if (alreadyResolved) {
              console.log(`[CALENDAR:USERS] Removing already-resolved user from to-resolve list: ${name}`);
            }
            return !alreadyResolved;
          });

          const unresolved = state.unresolved_users || [];
          unresolved.push({
            query: originalQuery,
            type: 'user_skipped',
            message: `Skipped adding "${originalQuery}" (name not found)`
          });

          return {
            ...state,
            users_to_resolve: remainingUsers,
            unresolved_users: unresolved,
            user_clarification_response: null
          };
        }
      }
    }

    if (!state.users_to_resolve || state.users_to_resolve.length === 0) {
      return state;
    }

    try {
      const sessionId = state.session_id || config?.configurable?.session_id;
      const orgId = state.org_id || config?.configurable?.org_id;

      if (!sessionId || !orgId) {
        console.warn("[CALENDAR:USERS] Missing session or org ID, skipping user resolution");
        return state;
      }

      const resolved = state.resolved_users || [];
      const unresolved = [];

      for (const userQuery of state.users_to_resolve) {
        // Check for "me" reference
        if (this.userResolver.isSelfReference(userQuery)) {
          console.log("[CALENDAR:USERS] Resolving 'me' pronoun");
          const currentUser = await this.userResolver.resolveMe(sessionId, orgId);

          if (currentUser) {
            // Deduplicate: Only add if not already in resolved array (check by ID)
            const userId = currentUser.id || currentUser.Id;
            if (!resolved.some(u => (u.id || u.Id) === userId)) {
              resolved.push(currentUser);
            } else {
              console.log(`[CALENDAR:USERS] Current user already resolved, skipping`);
            }
          } else {
            console.warn("[CALENDAR:USERS] Could not resolve 'me' - no current user found");
            unresolved.push({
              query: userQuery,
              type: 'self_reference',
              message: "Could not identify current user"
            });
          }
          continue;
        }

        // Search for user by name
        const candidates = await this.userResolver.search(userQuery, orgId, 5);

        if (candidates.length === 0) {
          console.warn(`[CALENDAR:USERS] No matches for: ${userQuery}`);

          // Try fuzzy search for suggestions
          console.log(`[CALENDAR:USERS] Attempting fuzzy search for suggestions`);
          const partialQuery = userQuery.substring(0, Math.min(userQuery.length - 1, 3));
          const fuzzyResults = await this.userResolver.search(partialQuery, orgId, 10, false);

          // Get top suggestions
          const suggestions = fuzzyResults
            .filter(u => {
              const similarity = this.userResolver.calculateNameSimilarity(userQuery, u.name);
              return similarity > 0.3;
            })
            .sort((a, b) => {
              const simA = this.userResolver.calculateNameSimilarity(userQuery, a.name);
              const simB = this.userResolver.calculateNameSimilarity(userQuery, b.name);
              return simB - simA;
            })
            .slice(0, 3)
            .map(u => u.name);

          // Return state indicating clarification is needed
          console.log(`[CALENDAR:USERS] Needs clarification for: ${userQuery}`);
          return {
            ...state,
            needsClarification: true,
            clarificationType: 'user_clarification',
            clarificationData: {
              type: 'user_clarification',
              message: `I couldn't find a team member named "${userQuery}".`,
              suggestions: suggestions,
              original_query: userQuery,
              prompt: suggestions.length > 0
                ? `Did you mean one of these team members: ${suggestions.join(', ')}? Or please type the correct name:`
                : `Could you please check the spelling and provide the correct name?`,
              allow_skip: true
            }
          };
        }

        // Check if we have only fuzzy matches
        const fuzzyMatches = candidates.filter(c => c.fuzzyMatch);
        if (fuzzyMatches.length > 0 && fuzzyMatches.length === candidates.length) {
          console.log(`[CALENDAR:USERS] Only fuzzy matches found for "${userQuery}"`);

          const topSuggestions = fuzzyMatches
            .slice(0, 3)
            .map(u => u.name);

          // Return state for fuzzy match confirmation
          console.log(`[CALENDAR:USERS] Needs clarification for fuzzy matches: ${userQuery}`);
          return {
            ...state,
            needsClarification: true,
            clarificationType: 'user_clarification',
            clarificationData: {
              type: 'user_clarification',
              message: `No exact match for team member "${userQuery}".`,
              suggestions: topSuggestions,
              original_query: userQuery,
              prompt: `Did you mean: ${topSuggestions[0]}? Or select from: ${topSuggestions.join(', ')}`,
              fuzzy_candidates: fuzzyMatches.slice(0, 3),
              allow_skip: true
            }
          };
        }

        // Disambiguate if multiple matches
        const selected = await this.userResolver.disambiguate(candidates, {
          query: userQuery,
          memoryContext: state.memory_context || {},
          orgId,
          userId: state.user_id
        });

        // Handle disambiguation that requires user input
        if (selected.needsDisambiguation) {
          // Save partial progress before interrupt
          if (resolved.length > 0) {
            state.resolved_users = resolved;
          }

          // Use interrupt for user selection
          throw interrupt({
            value: {
              type: 'user_disambiguation',
              message: `Multiple users found for "${userQuery}". Please select:`,
              candidates: selected.alternatives,
              original_query: userQuery
            }
          });
        }

        // Deduplicate: Only add if not already in resolved array (check by ID)
        const userToAdd = selected;
        const userId = userToAdd.id || userToAdd.Id;
        if (!resolved.some(u => (u.id || u.Id) === userId)) {
          resolved.push(userToAdd);
        } else {
          console.log(`[CALENDAR:USERS] User already resolved, skipping: ${userToAdd.name}`);
        }
      }

      console.log(`[CALENDAR:USERS] Resolved ${resolved.length} users, ${unresolved.length} unresolved`);

      // Clear users_to_resolve to make this function idempotent
      // This prevents re-resolving the same users on subsequent invocations
      return {
        ...state,
        resolved_users: resolved,
        unresolved_users: unresolved,
        users_to_resolve: []
      };

    } catch (error) {
      if (error.name === 'GraphInterrupt') throw error;

      console.error("[CALENDAR:USERS] Error resolving users:", error);
      // Continue without users rather than failing
      // Clear users_to_resolve to prevent retry loops on persistent errors
      return {
        ...state,
        resolved_users: [],
        users_to_resolve: []
      };
    }
  }

  /**
   * Resolve contact names to IDs
   */
  async resolveContacts(state, config) {
    console.log("[CALENDAR:CONTACTS] Resolving contacts");
    console.log("[CALENDAR:CONTACTS] Contacts to resolve:", state.contacts_to_resolve);
    console.log("[CALENDAR:CONTACTS] Config available:", !!config);

    // Check if we're resuming from a contact selection
    if (state.contact_selected && state.resolved_contacts) {
      console.log("[CALENDAR:CONTACTS] Resuming with selected contacts:", state.resolved_contacts);
      return {
        ...state,
        contact_selected: false // Clear the flag after processing
      };
    }

    // Check if we're resuming from contact DISAMBIGUATION (user selected from multiple)
    if (state.contact_clarification_response?.selected_contact) {
      // VALIDATE: Only use if this is actually a resume scenario
      // Reject stale responses from previous queries that shouldn't be here
      if (!state.contact_selected && !state.contacts_to_resolve?.length) {
        console.warn("[CALENDAR:CONTACTS] Ignoring stale contact_clarification_response from previous query");
        // Don't use the stale response - fall through to normal resolution
        state.contact_clarification_response = null;
      } else {
        console.log("[CALENDAR:CONTACTS] Resuming with user-selected contact from disambiguation");

        const selectedContact = state.contact_clarification_response.selected_contact;
        const resolved = state.resolved_contacts || [];

        // Add the selected contact to resolved list if not already present
        if (!resolved.some(c => c.id === selectedContact.id)) {
          resolved.push(selectedContact);
          console.log(`[CALENDAR:CONTACTS] Added selected contact: ${selectedContact.name} (${selectedContact.id})`);
        }

        // Filter out already-resolved contacts from to-resolve list to prevent re-resolution
        const remainingContacts = state.contacts_to_resolve.filter(name => {
          const alreadyResolved = resolved.some(c =>
            c.name?.toLowerCase() === name.toLowerCase()
          );
          if (alreadyResolved) {
            console.log(`[CALENDAR:CONTACTS] Removing already-resolved contact from to-resolve list: ${name}`);
          }
          return !alreadyResolved;
        });

        return {
          ...state,
          resolved_contacts: resolved,
          contact_clarification_response: null,  // Clear after processing
          contact_selected: false,  // Clear flag
          contacts_to_resolve: remainingContacts  // Only keep unresolved contacts
        };
      }
    }

    // Check if we're resuming from a contact clarification (text response)
    if (state.contact_clarification_response) {
      // VALIDATE: Only process if we have contacts to resolve
      // This prevents stale responses from previous queries being processed
      if (!state.contacts_to_resolve || state.contacts_to_resolve.length === 0) {
        console.warn("[CALENDAR:CONTACTS] Ignoring stale text clarification response - no contacts to resolve");
        state.contact_clarification_response = null;
        // Fall through to normal resolution
      } else {
        console.log("[CALENDAR:CONTACTS] Resuming with clarification:", state.contact_clarification_response);

        const clarifiedName = state.contact_clarification_response.clarified_name;
        const originalQuery = state.contact_clarification_response.original_query;
        const skipContact = state.contact_clarification_response.skip;

        if (!skipContact && clarifiedName && clarifiedName.toLowerCase() !== 'skip') {
          // Replace the original query with the clarified name in contacts_to_resolve
          console.log(`[CALENDAR:CONTACTS] Replacing "${originalQuery}" with "${clarifiedName}"`);

          const updatedContacts = state.contacts_to_resolve.map(name =>
            name === originalQuery ? clarifiedName : name
          );

          // Update state and fall through to normal search logic
          // (don't return - we need to actually search for the clarified name!)
          state = {
            ...state,
            contacts_to_resolve: updatedContacts,
            contact_clarification_response: null
          };

          // Fall through to search logic below
        } else {
          // User chose to skip this contact
          console.log(`[CALENDAR:CONTACTS] User chose to skip contact: ${originalQuery}`);

          // Remove the skipped contact from the list
          // Also check if any other contacts in the list are already resolved (to prevent re-resolution)
          const resolved = state.resolved_contacts || [];
          const remainingContacts = state.contacts_to_resolve.filter(name => {
            // Keep only contacts that are NOT the skipped one AND NOT already resolved
            if (name === originalQuery) return false;
            // Check if already resolved by matching name (case-insensitive)
            const alreadyResolved = resolved.some(c =>
              c.name?.toLowerCase() === name.toLowerCase()
            );
            if (alreadyResolved) {
              console.log(`[CALENDAR:CONTACTS] Removing already-resolved contact from to-resolve list: ${name}`);
            }
            return !alreadyResolved;
          });

          const unresolved = state.unresolved_contacts || [];
          unresolved.push({
            query: originalQuery,
            type: 'user_skipped',
            message: `Skipped adding "${originalQuery}" (name not found)`
          });

          return {
            ...state,
            contacts_to_resolve: remainingContacts,
            unresolved_contacts: unresolved,
            contact_clarification_response: null
          };
        }
      }
    }

    if (!state.contacts_to_resolve || state.contacts_to_resolve.length === 0) {
      return state;
    }

    try {
      const passKey = await config.configurable.getPassKey();
      const resolved = state.resolved_contacts || [];
      const unresolved = [];

      for (const contactName of state.contacts_to_resolve) {
        // Search for contact
        const candidates = await this.contactResolver.search(
          contactName,
          5,
          passKey,
          config.configurable.org_id
        );

        if (candidates.length === 0) {
          console.warn(`[CALENDAR:CONTACTS] No matches for: ${contactName}`);

          // Before giving up, try fuzzy search to get suggestions
          console.log(`[CALENDAR:CONTACTS] Attempting fuzzy search for suggestions`);
          const fuzzyResults = await this.contactResolver.search(
            contactName.substring(0, Math.min(contactName.length, 4)),
            10,
            passKey,
            config.configurable.org_id,
            false // Don't recurse fuzzy search
          );

          // Filter for reasonable matches
          const suggestions = fuzzyResults
            .filter(c => {
              const similarity = this.contactResolver.calculateNameSimilarity(contactName, c.name);
              return similarity > 0.3;
            })
            .sort((a, b) => {
              const simA = this.contactResolver.calculateNameSimilarity(contactName, a.name);
              const simB = this.contactResolver.calculateNameSimilarity(contactName, b.name);
              return simB - simA;
            })
            .slice(0, 3)
            .map(c => c.name);

          // Return state indicating clarification is needed
          // Don't throw interrupt - let coordinator handle it (subgraphs are stateless)
          console.log(`[CALENDAR:CONTACTS] Needs clarification for: ${contactName}`);
          return {
            ...state,
            needsClarification: true,
            clarificationType: 'contact_clarification',
            clarificationData: {
              type: 'contact_clarification',
              message: `I couldn't find anyone named "${contactName}".`,
              suggestions: suggestions,
              original_query: contactName,
              prompt: suggestions.length > 0
                ? `Did you mean one of these: ${suggestions.join(', ')}? Or please type the correct name:`
                : `Could you please check the spelling and provide the correct name?`,
              allow_skip: true
            }
          };
        }

        // Check if we have only fuzzy matches (no exact matches)
        const fuzzyMatches = candidates.filter(c => c.fuzzyMatch);
        if (fuzzyMatches.length > 0 && fuzzyMatches.length === candidates.length) {
          console.log(`[CALENDAR:CONTACTS] Only fuzzy matches found for "${contactName}"`);

          const topSuggestions = fuzzyMatches
            .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
            .slice(0, 3)
            .map(c => c.name);

          // Return state for fuzzy match confirmation
          console.log(`[CALENDAR:CONTACTS] Needs clarification for fuzzy matches: ${contactName}`);
          return {
            ...state,
            needsClarification: true,
            clarificationType: 'contact_clarification',
            clarificationData: {
              type: 'contact_clarification',
              message: `No exact match for "${contactName}".`,
              suggestions: topSuggestions,
              original_query: contactName,
              prompt: `Did you mean: ${topSuggestions[0]}? Or select from: ${topSuggestions.join(', ')}`,
              fuzzy_candidates: fuzzyMatches.slice(0, 3),
              allow_skip: true
            }
          };
        }

        // Disambiguate if multiple matches
        const selected = await this.contactResolver.disambiguate(
          candidates,
          {
            query: contactName,
            memoryContext: state.memory_context || {},
            orgId: config.configurable.org_id,
            userId: config.configurable.user_id
          }
        );

        // Handle disambiguation that requires user input
        if (selected.needsDisambiguation) {
          // Save partial progress before interrupt
          if (resolved.length > 0) {
            state.resolved_contacts = resolved;
          }

          // Use interrupt for user selection
          throw interrupt({
            value: {
              type: 'contact_disambiguation',
              message: `Multiple contacts found for "${contactName}". Please select:`,
              candidates: selected.alternatives,
              original_query: contactName
            }
          });
        }

        // If auto-selected, use the contact directly
        const contactToAdd = selected.topCandidate || selected;

        // Deduplicate: Only add if not already in resolved array (check by ID)
        const contactId = contactToAdd.id || contactToAdd.Id;
        if (!resolved.some(c => (c.id || c.Id) === contactId)) {
          resolved.push(contactToAdd);
        } else {
          console.log(`[CALENDAR:CONTACTS] Contact already resolved, skipping: ${contactToAdd.name}`);
        }
      }

      console.log(`[CALENDAR:CONTACTS] Resolved ${resolved.length} contacts, ${unresolved.length} unresolved`);

      // Clear contacts_to_resolve to make this function idempotent
      // This prevents re-resolving the same contacts on subsequent invocations
      return {
        ...state,
        resolved_contacts: resolved,
        unresolved_contacts: unresolved,
        contacts_to_resolve: []
      };

    } catch (error) {
      if (error.name === 'GraphInterrupt') throw error;

      console.error("[CALENDAR:CONTACTS] Error resolving contacts:", error);
      // Continue without contacts rather than failing
      // Clear contacts_to_resolve to prevent retry loops on persistent errors
      return {
        ...state,
        resolved_contacts: [],
        contacts_to_resolve: []
      };
    }
  }

  /**
   * Fetch existing appointments
   */
  async fetchAppointments(state, config) {
    console.log("[CALENDAR:FETCH] Fetching appointments");

    if (!state.date_range?.start) {
      // Default to today
      const today = new Date();
      state.date_range = {
        start: today.toISOString().split('T')[0],
        end: today.toISOString().split('T')[0]
      };
    }

    try {
      // Validate config exists
      if (!config?.configurable) {
        console.error("[CALENDAR:FETCH] Missing config or configurable");
        return {
          ...state,
          error: "Authentication configuration missing"
        };
      }

      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;

      // Validate required fields
      if (!passKey) {
        console.error("[CALENDAR:FETCH] No valid PassKey available");
        return {
          ...state,
          error: "Authentication failed - no valid PassKey"
        };
      }

      if (!orgId) {
        console.error("[CALENDAR:FETCH] No organization ID available");
        return {
          ...state,
          error: "Organization ID missing"
        };
      }
      
      const result = await getAppointments({
        startDate: state.date_range.start,
        endDate: state.date_range.end,
        includeExtendedProperties: true
      }, passKey, orgId);
      
      console.log(`[CALENDAR:FETCH] Found ${result.count} appointments`);
      
      return {
        ...state,
        appointments: result.appointments
      };
      
    } catch (error) {
      console.error("[CALENDAR:FETCH] Error fetching appointments:", error);
      return {
        ...state,
        error: `Failed to fetch appointments: ${error.message}`
      };
    }
  }

  /**
   * Check for conflicts when creating appointments
   */
  async checkConflicts(state, config) {
    console.log("[CALENDAR:CONFLICTS] Checking for conflicts");
    
    if (!state.appointment_data || state.action !== "create") {
      return state;
    }

    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      // Fetch appointments for the same day
      const appointmentDate = state.appointment_data.startTime.split('T')[0];
      const existing = await getAppointments({
        startDate: appointmentDate,
        endDate: appointmentDate
      }, passKey, orgId);
      
      // Check for time overlaps
      const conflicts = [];
      const newStart = new Date(state.appointment_data.startTime);
      const newEnd = new Date(state.appointment_data.endTime);
      
      for (const appt of existing.appointments || []) {
        const existingStart = new Date(appt.StartTime);
        const existingEnd = new Date(appt.EndTime);
        
        // Check if times overlap
        if (newStart < existingEnd && newEnd > existingStart) {
          conflicts.push({
            subject: appt.Subject,
            time: `${existingStart.toLocaleTimeString()} - ${existingEnd.toLocaleTimeString()}`
          });
        }
      }
      
      if (conflicts.length > 0) {
        console.log(`[CALENDAR:CONFLICTS] Found ${conflicts.length} conflicts`);
      }
      
      return {
        ...state,
        conflicts
      };
      
    } catch (error) {
      console.error("[CALENDAR:CONFLICTS] Error checking conflicts:", error);
      // Continue without conflict check
      return state;
    }
  }

  /**
   * Generate preview for approval
   */
  async generatePreview(state) {
    console.log("[CALENDAR:PREVIEW] Generating preview");
    
    if (state.action === "view") {
      return state;
    }

    const preview = {
      type: 'appointment',
      action: state.action,
      title: state.appointment_data?.subject || "Appointment",
      details: []
    };

    if (state.appointment_data) {
      const userTz = state.timezone || 'UTC';
      const start = dayjs(state.appointment_data.startTime).tz(userTz);
      const end = dayjs(state.appointment_data.endTime).tz(userTz);
      
      preview.details.push({
        label: "Date",
        value: start.format('M/D/YYYY')
      });
      
      if (!state.appointment_data.isAllDay) {
        preview.details.push({
          label: "Time",
          value: `${start.format('h:mm A')} - ${end.format('h:mm A')}`
        });
      }
      
      if (state.appointment_data.location) {
        preview.details.push({
          label: "Location",
          value: state.appointment_data.location
        });
      }
      
      if (state.resolved_users?.length > 0) {
        preview.details.push({
          label: "Team Members",
          value: state.resolved_users.map(u => u.name).join(", ")
        });
      }

      if (state.resolved_contacts?.length > 0) {
        preview.details.push({
          label: "External Attendees",
          value: state.resolved_contacts.map(c => c.name).join(", ")
        });
      }
    }
    
    // Add warnings for conflicts and unresolved attendees
    const warnings = [];

    if (state.conflicts?.length > 0) {
      warnings.push(`Conflicts with: ${state.conflicts.map(c => c.subject).join(", ")}`);
    }

    // Add warnings for unresolved/skipped attendees
    if (state.unresolved_contacts?.length > 0) {
      for (const unresolved of state.unresolved_contacts) {
        if (unresolved.type === 'user_skipped') {
          warnings.push(`⚠️ Skipped: ${unresolved.query} (not found)`);
        } else {
          warnings.push(`⚠️ Could not add: ${unresolved.query}`);
        }
      }
    }

    if (state.unresolved_users?.length > 0) {
      for (const unresolved of state.unresolved_users) {
        if (unresolved.type === 'user_skipped') {
          warnings.push(`⚠️ Skipped: ${unresolved.query} (not found)`);
        } else {
          warnings.push(`⚠️ Could not add: ${unresolved.query}`);
        }
      }
    }

    if (warnings.length > 0) {
      preview.warnings = warnings;
    }

    return {
      ...state,
      preview
    };
  }

  /**
   * Request approval from user
   */
  async approvalNode(state) {
    console.log("[CALENDAR:APPROVAL] Processing approval");

    // Check if we're resuming from an approval decision
    if (state.approval_decision) {
      console.log(`[CALENDAR:APPROVAL] Resuming with decision: ${state.approval_decision}`);
      return {
        ...state,
        approved: state.approval_decision === 'approve',
        rejected: state.approval_decision === 'reject',
        requiresApproval: false  // Clear the flag
      };
    }

    if (!state.preview) {
      return { ...state, approved: true };
    }

    // Return approval request structure instead of throwing interrupt
    console.log("[CALENDAR:APPROVAL] Returning approval request for coordinator to handle");

    // Customize message based on unresolved attendees
    let message = `Please review this ${state.action} action:`;
    if (state.unresolved_contacts?.length > 0 || state.unresolved_users?.length > 0) {
      const unresolvedCount = (state.unresolved_contacts?.length || 0) + (state.unresolved_users?.length || 0);
      if (unresolvedCount === 1) {
        message = `⚠️ Note: 1 attendee could not be found. Please review:`;
      } else {
        message = `⚠️ Note: ${unresolvedCount} attendees could not be found. Please review:`;
      }
    }

    return {
      ...state,
      requiresApproval: true,
      approvalRequest: {
        domain: 'calendar',
        type: 'approval_required',
        actionId: `calendar_${Date.now()}`,
        action: state.action,
        preview: state.preview,
        data: state.appointment_data,
        message: message,
        thread_id: state.thread_id || null
      },
      // Don't set approved yet - waiting for decision
      approved: false
    };
  }

  /**
   * Create appointment in BSA
   */
  async createAppointmentNode(state, config) {
    console.log("[CALENDAR:CREATE] Creating appointment");
    
    if (!state.approved || !state.appointment_data) {
      return state;
    }

    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      const appointment = await createAppointment(
        state.appointment_data,
        passKey,
        orgId
      );
      
      console.log("[CALENDAR:CREATE] Created appointment:", appointment.id);
      
      // Register entity for cross-domain reference
      const entity = {
        type: 'appointment',
        id: appointment.id,
        name: appointment.subject,
        time: appointment.startTime
      };
      
      return {
        ...state,
        appointments: [appointment],
        entities: {
          ...state.entities,
          appointment: entity
        }
      };
      
    } catch (error) {
      console.error("[CALENDAR:CREATE] Error creating appointment:", error);
      return {
        ...state,
        error: `Failed to create appointment: ${error.message}`
      };
    }
  }

  /**
   * Update existing appointment
   */
  async updateAppointmentNode(state, config) {
    console.log("[CALENDAR:UPDATE] Updating appointment");
    
    // Implementation would be similar to create
    // For now, returning state as-is
    return state;
  }

  /**
   * Link attendees to appointment
   */
  async linkAttendees(state, config) {
    console.log("[CALENDAR:ATTENDEES] Linking attendees");

    const hasContacts = state.resolved_contacts && state.resolved_contacts.length > 0;
    const hasUsers = state.resolved_users && state.resolved_users.length > 0;

    if (!hasContacts && !hasUsers) {
      return state;
    }

    if (!state.appointments || state.appointments.length === 0) {
      return state;
    }

    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      const appointmentId = state.appointments[0].id || state.appointments[0].Id;

      // Link contacts (external people)
      if (hasContacts) {
        let linkedContactsCount = 0;
        for (const contact of state.resolved_contacts) {
          try {
            // Validate contact has an ID before attempting to link
            const contactId = contact.id || contact.Id;
            if (!contactId) {
              console.warn(`[CALENDAR:ATTENDEES] Skipping contact without ID: ${contact.name || 'Unknown'}`);
              continue;
            }

            await this.contactResolver.linkActivity(
              'appointment',
              appointmentId,
              contactId,
              passKey,
              orgId
            );
            linkedContactsCount++;
          } catch (error) {
            console.error(`[CALENDAR:ATTENDEES] Failed to link contact ${contact.name || contact.id}: ${error.message}`);
            // Continue with other attendees instead of failing completely
          }
        }
        console.log(`[CALENDAR:ATTENDEES] Linked ${linkedContactsCount} of ${state.resolved_contacts.length} contacts`);
      }

      // Link users (internal team members)
      if (hasUsers) {
        let linkedUsersCount = 0;
        for (const user of state.resolved_users) {
          try {
            // Validate user has an ID before attempting to link
            const userId = user.id || user.Id;
            if (!userId) {
              console.warn(`[CALENDAR:ATTENDEES] Skipping user without ID: ${user.name || 'Unknown'}`);
              continue;
            }

            await this.userResolver.linkActivity(
              'appointment',
              appointmentId,
              userId,
              passKey,
              orgId
            );
            linkedUsersCount++;
          } catch (error) {
            console.error(`[CALENDAR:ATTENDEES] Failed to link user ${user.name || user.id}: ${error.message}`);
            // Continue with other attendees instead of failing completely
          }
        }
        console.log(`[CALENDAR:ATTENDEES] Linked ${linkedUsersCount} of ${state.resolved_users.length} users`);
      }

      const totalAttendees = (state.resolved_contacts?.length || 0) + (state.resolved_users?.length || 0);
      console.log(`[CALENDAR:ATTENDEES] Total ${totalAttendees} attendees linked`);

      // Enrich appointment entity with participants for follow-up questions
      try {
        const contactNames = (state.resolved_contacts || []).map(c => c.name).filter(Boolean);
        const userNames = (state.resolved_users || []).map(u => u.name).filter(Boolean);
        const participants = [...contactNames, ...userNames];

        if (!state.entities) state.entities = {};

        // Extract ID with fallback - generate temporary ID if BSA doesn't provide one
        const rawId = state.appointments?.[0]?.Id || state.appointments?.[0]?.id;
        const appointmentId = rawId || `temp_appt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        if (!rawId) {
          console.warn('[CALENDAR:ATTENDEES] No ID found in appointment response - using generated ID:', appointmentId);
        }

        const existing = state.entities.appointment || {
          type: 'appointment',
          id: appointmentId,
          name: state.appointments?.[0]?.Subject || state.appointments?.[0]?.subject,
          time: state.appointments?.[0]?.StartTime || state.appointments?.[0]?.startTime
        };
        state.entities.appointment = {
          ...existing,
          participants,
          participantCount: participants.length,
          externalAttendees: contactNames,
          internalAttendees: userNames
        };

        console.log('[CALENDAR:ATTENDEES] Stored appointment entity:', {
          id: state.entities.appointment.id,
          name: state.entities.appointment.name,
          participantCount: participants.length
        });
      } catch (e) {
        console.warn('[CALENDAR:ATTENDEES] Failed to enrich entities with participants:', e?.message);
      }

      return state;
      
    } catch (error) {
      console.error("[CALENDAR:ATTENDEES] Error linking attendees:", error);
      // Continue without linking
      return state;
    }
  }

  /**
   * Store interaction in memory
   */
  async synthesizeMemory(state, config) {
    console.log("[CALENDAR:MEMORY] Synthesizing memory");
    
    if (!this.mem0.client) {
      return state;
    }

    try {
      const orgId = config.configurable.org_id;
      const userId = config.configurable.user_id || "default";
      
      // Build conversation for memory
      let assistantContent = '';
      const subject = state.appointment_data?.subject || 'Appointment';
      const participants = (state.resolved_contacts || []).map(c => c.name).filter(Boolean);
      const teamMembers = (state.resolved_users || []).map(u => u.name).filter(Boolean);

      // Base message
      if (state.action === 'create' && state.appointments?.[0]) {
        assistantContent = `Created appointment: ${subject}`;
        if (participants.length) assistantContent += ` with ${participants.join(', ')}`;
        if (teamMembers.length) assistantContent += ` and team members: ${teamMembers.join(', ')}`;
      } else {
        assistantContent = `${state.action} appointment: ${subject}`;
      }

      // Add unresolved context for future reference
      const unresolvedInfo = [];
      if (state.unresolved_contacts?.length > 0) {
        for (const unresolved of state.unresolved_contacts) {
          unresolvedInfo.push(`Could not find contact "${unresolved.query}"`);
          if (unresolved.suggestions?.length > 0) {
            unresolvedInfo.push(`Possible matches: ${unresolved.suggestions.join(', ')}`);
          }
        }
      }
      if (state.unresolved_users?.length > 0) {
        for (const unresolved of state.unresolved_users) {
          unresolvedInfo.push(`Could not find user "${unresolved.query}"`);
        }
      }

      if (unresolvedInfo.length > 0) {
        assistantContent += '. ' + unresolvedInfo.join('. ');
      }

      const messages = [
        ...state.messages,
        {
          role: "assistant",
          content: assistantContent
        }
      ];
      
      await this.mem0.synthesize(
        messages,
        orgId,
        userId,
        {
          domain: 'calendar',
          action: state.action,
          appointmentId: state.appointments?.[0]?.id || state.appointments?.[0]?.Id,
          participants: (state.resolved_contacts || []).map(c => ({ id: c.id, name: c.name }))
        }
      );
      
      return state;
      
    } catch (error) {
      console.error("[CALENDAR:MEMORY] Error synthesizing memory:", error);
      // Continue without memory
      return state;
    }
  }

  /**
   * Tool-Calling Handler (Phases 1-2: Read + Preview/Approval)
   *
   * ReAct loop for calendar operations with approval flow support.
   * Handles both normal queries and resumption after approval.
   */
  async handleQueryToolCalling(state) {
    console.log("[CALENDAR:TOOL_CALLING] Processing query with tool-calling");

    const {
      query,
      messages = [],
      session_id,
      org_id,
      timezone,
      memory_context,
      entities,
      approval_decision,  // ✅ Check if resuming from approval (IN STATE!)
      _pendingData        // ✅ Pending data from preview
    } = state;

    try {
      // Build runtime context for tools
      const passKey = await this.passKeyManager.getPassKey(session_id);
      const context = {
        session_id,
        org_id,
        passKey,
        timezone: timezone || 'UTC',
        memory_context: memory_context || {},
        entities: entities || {}
      };

      // ===== RESUMPTION PATH (After Approval) =====
      if (approval_decision && _pendingData) {
        console.log(`[CALENDAR:TOOL_CALLING] Resuming after approval: ${approval_decision}`);

        if (approval_decision === 'approve') {
          // Call create_appointment tool with pending data
          try {
            const result = await createAppointmentTool.invoke(
              {
                appointmentData: _pendingData.appointmentData,
                resolvedAttendees: _pendingData.resolvedAttendees || []
              },
              { context }
            );

            const parsed = JSON.parse(result);

            if (parsed.success) {
              return {
                ...state,
                response: `Created appointment: ${parsed.appointment.subject} on ${dayjs(parsed.appointment.startTime).format('MMM D, YYYY [at] h:mm A')}`,
                appointments: [parsed.appointment],
                entities: {
                  ...state.entities,
                  appointment: parsed.entity
                },
                _pendingData: null,
                approval_decision: null,
                requiresApproval: false
              };
            } else {
              return {
                ...state,
                response: `Failed to create appointment: ${parsed.error}`,
                error: parsed.error,
                _pendingData: null,
                approval_decision: null,
                requiresApproval: false
              };
            }
          } catch (error) {
            console.error("[CALENDAR:TOOL_CALLING] Error during creation:", error);
            return {
              ...state,
              response: `Error creating appointment: ${error.message}`,
              error: error.message,
              _pendingData: null,
              approval_decision: null,
              requiresApproval: false
            };
          }
        } else {
          // Rejected
          return {
            ...state,
            response: "Appointment creation cancelled.",
            _pendingData: null,
            approval_decision: null,
            requiresApproval: false
          };
        }
      }

      // ===== NORMAL PATH (First Invocation) =====

      // Bind tools to LLM
      const llmWithTools = this.llm.bindTools(this.tools);

      // Build conversation
      const conversationMessages = [
        {
          role: "system",
          content: this.getSystemPromptForToolCalling()
        },
        ...messages
      ];

      // Only add query if it's not empty and not already the last user message
      if (query && query.trim()) {
        const lastMessage = messages[messages.length - 1];
        if (!lastMessage || lastMessage.role !== "user" || lastMessage.content !== query) {
          conversationMessages.push({
            role: "user",
            content: query
          });
        }
      }

      console.log("[CALENDAR:TOOL_CALLING] Starting ReAct loop with", conversationMessages.length, "messages");

      // ReAct agent loop
      let currentMessages = conversationMessages;
      let response;
      let loopCount = 0;
      const MAX_LOOPS = 5;

      while (loopCount < MAX_LOOPS) {
        response = await llmWithTools.invoke(currentMessages);

        // Check if LLM has final answer
        if (!response.tool_calls || response.tool_calls.length === 0) {
          console.log("[CALENDAR:TOOL_CALLING] LLM provided final answer");
          break;
        }

        console.log(`[CALENDAR:TOOL_CALLING] LLM requested ${response.tool_calls.length} tool call(s)`);

        // Execute tool calls
        const toolMessages = [];
        for (const toolCall of response.tool_calls) {
          try {
            console.log(`[CALENDAR:TOOL_CALLING] Executing: ${toolCall.name}`);

            const toolResult = await this.executeTool(toolCall, context);

            // ===== CRITICAL: Detect approval requirement =====
            try {
              const parsed = JSON.parse(toolResult);

              if (parsed.requiresApproval) {
                console.log("[CALENDAR:TOOL_CALLING] Preview generated, returning approval request");

                // ✅ Return state with approval request (Coordinator will handle interrupt)
                return {
                  ...state,
                  requiresApproval: true,
                  approvalRequest: {
                    domain: 'calendar',
                    type: 'approval_required',
                    actionId: `calendar_${Date.now()}`,
                    action: parsed.action,
                    preview: parsed.preview,
                    data: parsed.appointmentData,
                    message: "Please review this appointment:",
                    thread_id: state.thread_id
                  },
                  // ✅ Store pending data for resumption
                  _pendingData: {
                    appointmentData: parsed.appointmentData,
                    resolvedAttendees: parsed.resolvedAttendees
                  },
                  // Don't set approved yet - waiting for decision
                  approved: false
                };
              }
            } catch (e) {
              // Not JSON or doesn't have requiresApproval, continue normally
            }

            toolMessages.push({
              role: "tool",
              content: toolResult,
              tool_call_id: toolCall.id
            });

            console.log(`[CALENDAR:TOOL_CALLING] Tool ${toolCall.name} completed`);

          } catch (error) {
            console.error(`[CALENDAR:TOOL_CALLING] Tool ${toolCall.name} error:`, error.message);
            toolMessages.push({
              role: "tool",
              content: JSON.stringify({ error: error.message }),
              tool_call_id: toolCall.id
            });
          }
        }

        // Add assistant message + tool results to conversation
        currentMessages.push({
          role: "assistant",
          content: response.content || "",
          tool_calls: response.tool_calls
        });
        currentMessages.push(...toolMessages);

        loopCount++;
      }

      if (loopCount >= MAX_LOOPS) {
        console.warn("[CALENDAR:TOOL_CALLING] Hit max loops - returning current response");
      }

      // Extract final answer
      const finalAnswer = response.content || "I couldn't process your request.";

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
      console.error("[CALENDAR:TOOL_CALLING] Error:", error);
      return {
        ...state,
        error: error.message,
        response: `Error: ${error.message}`
      };
    }
  }

  /**
   * Execute a tool call
   */
  async executeTool(toolCall, context) {
    const tool = this.tools.find(t => t.name === toolCall.name);

    if (!tool) {
      throw new Error(`Tool not found: ${toolCall.name}`);
    }

    // Invoke tool with context
    const result = await tool.invoke(toolCall.args, { context });
    return result;
  }

  /**
   * System prompt for tool-calling mode (Phase 1-2)
   */
  getSystemPromptForToolCalling() {
    return `You are a calendar assistant that helps users manage their appointments.

You have access to tools that can:
- List appointments in date ranges (use natural language like "this week", "today", "next month")
- Parse date/time expressions (like "tomorrow at 3pm", "next Tuesday 2pm")
- Check for scheduling conflicts
- Generate appointment previews for user approval

For viewing appointments:
1. Use the list_appointments tool with natural language dates
2. Provide a clear, conversational summary of the appointments

For creating appointments:
1. Parse the date/time first using parse_datetime tool
2. Check for conflicts if desired using check_conflicts tool
3. Generate a preview using preview_appointment tool (REQUIRED BEFORE CREATING)
4. The preview will be shown to the user for approval
5. You will be notified when the user approves/rejects

IMPORTANT:
- ALWAYS use preview_appointment BEFORE creating any appointment
- The preview tool will automatically check for conflicts
- Wait for user approval after preview (the system will handle this)
- In Phase 3, you'll be able to actually create appointments after approval

Be conversational and helpful. Format times in a user-friendly way.`;
  }

  /**
   * Format final response
   */
  async formatResponse(state) {
    console.log("[CALENDAR:RESPONSE] Formatting response");

    // If clarification is needed, preserve that state and return early
    if (state.needsClarification) {
      console.log("[CALENDAR:RESPONSE] Clarification needed - preserving state for coordinator");
      return {
        ...state,
        response: "Awaiting clarification..."
      };
    }

    if (state.error) {
      return {
        ...state,
        response: `Error: ${state.error}`
      };
    }

    // If approval is required, don't generate a final response yet
    if (state.requiresApproval) {
      console.log("[CALENDAR:RESPONSE] Approval pending - returning partial state");
      return {
        ...state,
        response: "Awaiting approval..."
      };
    }

    let response = "";

    if (state.action === "view") {
      if (!state.appointments || state.appointments.length === 0) {
        response = "No appointments found for the specified date range.";
      } else {
        response = `Found ${state.appointments.length} appointment(s):\n\n`;
        state.appointments.forEach(appt => {
          const start = new Date(appt.StartTime || appt.startTime);
          response += `• ${appt.Subject || appt.subject} - ${start.toLocaleString()}\n`;
          if (appt.Location) response += `  Location: ${appt.Location}\n`;
        });
      }
    } else if (state.action === "create" && state.approved) {
      const appt = state.appointments?.[0];
      if (appt) {
        response = `✅ Successfully created appointment "${appt.subject || appt.Subject}"`;

        const attendeesParts = [];
        if (state.resolved_users?.length > 0) {
          attendeesParts.push(`${state.resolved_users.length} team member(s)`);
        }
        if (state.resolved_contacts?.length > 0) {
          attendeesParts.push(`${state.resolved_contacts.length} external attendee(s)`);
        }

        if (attendeesParts.length > 0) {
          response += ` with ${attendeesParts.join(' and ')}`;
        }

        // Add warnings for unresolved attendees
        const warnings = [];
        if (state.unresolved_users?.length > 0) {
          for (const unresolved of state.unresolved_users) {
            warnings.push(`⚠️ ${unresolved.message}`);
          }
        }
        if (state.unresolved_contacts?.length > 0) {
          for (const unresolved of state.unresolved_contacts) {
            warnings.push(`⚠️ ${unresolved.message}`);

            // Add suggestions if available
            if (unresolved.suggestions?.length > 0) {
              warnings.push(`   Suggestions: ${unresolved.suggestions.join(', ')}`);
            }
          }
        }

        if (warnings.length > 0) {
          response += "\n\n" + warnings.join("\n");
          response += "\n\n💡 The appointment was created without these attendees. Please check the spelling and try adding them again if needed.";
        }
      } else {
        response = "Appointment creation was processed.";
      }
    } else if (state.approved === false && !state.requiresApproval) {
      // Only show cancelled if explicitly rejected, not when pending approval
      response = "Action cancelled by user.";
    }
    
    return {
      ...state,
      response
    };
  }
}

/**
 * Factory function to create calendar subgraph
 * @param {Object} checkpointer - The checkpointer (propagated from parent)
 */
async function createSubgraph(checkpointer = null) {
  const subgraph = new CalendarSubgraph(checkpointer);
  return subgraph.graph;
}

module.exports = {
  createSubgraph,
  CalendarSubgraph
};

// Export graph for LangGraph Studio (async initialization)
module.exports.graph = (async () => {
  const { getCheckpointer } = require('../../../core/state');
  const checkpointer = await getCheckpointer();
  const subgraph = new CalendarSubgraph(checkpointer);
  return subgraph.graph;
})();
