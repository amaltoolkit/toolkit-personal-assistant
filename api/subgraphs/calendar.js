/**
 * Calendar Subgraph - Domain-specific graph for calendar operations
 * 
 * Handles all calendar-related queries including:
 * - Viewing appointments
 * - Creating new appointments
 * - Updating existing appointments
 * - Managing attendees
 */

const { StateGraph, END } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { z } = require("zod");
const { parseDateQuery, parseDateTimeQuery, calculateEndTime } = require("../lib/chronoParser");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);
const { getAppointments, createAppointment, updateAppointment } = require("../tools/bsa/appointments");
const { getContactResolver } = require("../services/contactResolver");
const { getApprovalBatcher } = require("../services/approvalBatcher");
const { getMem0Service } = require("../services/mem0Service");

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
  response: {
    value: (x, y) => y ? y : x,
    default: () => ""
  },
  error: {
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
    this.approvalBatcher = getApprovalBatcher();
    this.mem0 = getMem0Service();
    this.checkpointer = checkpointer;

    this.graph = this.buildGraph();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: CalendarStateChannels  // Use state channels instead of Zod schema
    });

    // Add nodes
    workflow.addNode("parse_request", this.parseRequest.bind(this));
    workflow.addNode("resolve_contacts", this.resolveContacts.bind(this));
    workflow.addNode("fetch_appointments", this.fetchAppointments.bind(this));
    workflow.addNode("check_conflicts", this.checkConflicts.bind(this));
    workflow.addNode("generate_preview", this.generatePreview.bind(this));
    workflow.addNode("approval", this.approvalNode.bind(this));
    workflow.addNode("create_appointment", this.createAppointmentNode.bind(this));
    workflow.addNode("update_appointment", this.updateAppointmentNode.bind(this));
    workflow.addNode("link_attendees", this.linkAttendees.bind(this));
    workflow.addNode("synthesize_memory", this.synthesizeMemory.bind(this));
    workflow.addNode("format_response", this.formatResponse.bind(this));

    // Define flow
    workflow.setEntryPoint("parse_request");
    
    // Route based on action
    workflow.addConditionalEdges(
      "parse_request",
      (state) => {
        console.log("[CALENDAR:ROUTER] After parse_request:", {
          hasError: !!state.error,
          action: state.action,
          contactsToResolve: state.contacts_to_resolve?.length || 0
        });

        if (state.error) return "format_response";
        if (state.action === "view") return "fetch_appointments";
        if (state.action === "create") {
          const nextNode = state.contacts_to_resolve?.length > 0 ?
            "resolve_contacts" : "check_conflicts";
          console.log(`[CALENDAR:ROUTER] Create action routing to: ${nextNode}`);
          return nextNode;
        }
        if (state.action === "update") return "fetch_appointments";
        return "format_response";
      },
      {
        "fetch_appointments": "fetch_appointments",
        "resolve_contacts": "resolve_contacts",
        "check_conflicts": "check_conflicts",
        "format_response": "format_response"
      }
    );
    
    // Contact resolution flow
    workflow.addEdge("resolve_contacts", "check_conflicts");
    
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
      // First, try to parse date/time directly from the query
      const dateTimeResult = parseDateTimeQuery(userQuery, userTimezone);

      // Use LLM to extract other details
      const parsePrompt = `
        Analyze this calendar-related query and extract:
        1. Action: view, create, update, or delete
        2. Appointment details (if creating/updating)
        3. Contact names mentioned
        4. Keep the EXACT date/time expression as the user stated it

        Query: "${userQuery}"
        ${state.memory_context?.recalled_memories ?
          `Context: ${JSON.stringify(state.memory_context.recalled_memories[0]?.content || '')}` : ''}

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
          "contacts": ["name1", "name2"]
        }

        IMPORTANT: For date_query, preserve EXACTLY what the user said, including the time.
        Examples:
        - User says "tomorrow at 8am" → date_query: "tomorrow at 8am"
        - User says "next Monday at 2:30pm" → date_query: "next Monday at 2:30pm"
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

      const result = {
        ...state,
        action: parsed.action,
        date_range: dateRange,
        appointment_data: appointmentData,
        contacts_to_resolve: parsed.contacts || []
      };

      console.log("[CALENDAR:PARSE] Returning state:", {
        action: result.action,
        hasDateRange: !!result.date_range,
        hasAppointmentData: !!result.appointment_data,
        contactsToResolve: result.contacts_to_resolve?.length || 0,
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

    if (!state.contacts_to_resolve || state.contacts_to_resolve.length === 0) {
      return state;
    }

    try {
      const passKey = await config.configurable.getPassKey();
      const resolved = state.resolved_contacts || [];

      for (const contactName of state.contacts_to_resolve) {
        // Skip if we already have this contact resolved (from resume)
        if (resolved.some(c => c.name === contactName)) {
          continue;
        }

        // Search for contact
        const candidates = await this.contactResolver.search(
          contactName,
          5,
          passKey,
          config.configurable.org_id
        );

        if (candidates.length === 0) {
          console.warn(`[CALENDAR:CONTACTS] No matches for: ${contactName}`);
          continue;
        }

        // Disambiguate if multiple matches
        const selected = await this.contactResolver.disambiguate(
          candidates,
          state.messages[state.messages.length - 1].content
        );

        // Handle disambiguation that requires user input
        if (selected.requiresConfirmation) {
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

        resolved.push(selected);
      }

      console.log(`[CALENDAR:CONTACTS] Resolved ${resolved.length} contacts`);

      return {
        ...state,
        resolved_contacts: resolved
      };

    } catch (error) {
      if (error.name === 'GraphInterrupt') throw error;

      console.error("[CALENDAR:CONTACTS] Error resolving contacts:", error);
      // Continue without contacts rather than failing
      return {
        ...state,
        resolved_contacts: []
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
      
      if (state.resolved_contacts?.length > 0) {
        preview.details.push({
          label: "Attendees",
          value: state.resolved_contacts.map(c => c.name).join(", ")
        });
      }
    }
    
    // Add warnings for conflicts
    if (state.conflicts?.length > 0) {
      preview.warnings = [
        `Conflicts with: ${state.conflicts.map(c => c.subject).join(", ")}`
      ];
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
        message: `Please review this ${state.action} action:`,
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
    
    if (!state.resolved_contacts || state.resolved_contacts.length === 0) {
      return state;
    }
    
    if (!state.appointments || state.appointments.length === 0) {
      return state;
    }

    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      const appointmentId = state.appointments[0].id || state.appointments[0].Id;
      
      for (const contact of state.resolved_contacts) {
        await this.contactResolver.linkActivity(
          'appointment',
          appointmentId,
          contact.id,
          passKey,
          orgId
        );
      }
      
      console.log(`[CALENDAR:ATTENDEES] Linked ${state.resolved_contacts.length} attendees`);

      // Enrich appointment entity with participants for follow-up questions
      try {
        const participants = state.resolved_contacts.map(c => c.name).filter(Boolean);
        if (!state.entities) state.entities = {};
        const existing = state.entities.appointment || {
          type: 'appointment',
          id: state.appointments?.[0]?.Id || state.appointments?.[0]?.id,
          name: state.appointments?.[0]?.Subject || state.appointments?.[0]?.subject,
          time: state.appointments?.[0]?.StartTime || state.appointments?.[0]?.startTime
        };
        state.entities.appointment = {
          ...existing,
          participants,
          participantCount: participants.length
        };
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
      const messages = [
        ...state.messages,
        {
          role: "assistant",
          content: (() => {
            const subject = state.appointment_data?.subject || 'Appointment';
            const participants = (state.resolved_contacts || []).map(c => c.name).filter(Boolean);
            const withStr = participants.length ? ` with ${participants.join(', ')}` : '';
            return `${state.action} appointment: ${subject}${withStr}`;
          })()
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
   * Format final response
   */
  async formatResponse(state) {
    console.log("[CALENDAR:RESPONSE] Formatting response");

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
        if (state.resolved_contacts?.length > 0) {
          response += ` with ${state.resolved_contacts.length} attendee(s)`;
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
