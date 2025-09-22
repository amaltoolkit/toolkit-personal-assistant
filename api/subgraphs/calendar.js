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
const { parseDateQuery, parseDateTimeQuery, calculateEndTime } = require("../lib/chronoParser");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);
const { getAppointments, createAppointment, updateAppointment } = require("../tools/bsa/appointments");
const { getContactResolver } = require("../services/contactResolver");
const { getUserResolver } = require("../services/userResolver");
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
    this.userResolver = getUserResolver();
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
        if (state.action === "view") return "fetch_appointments";
        if (state.action === "create") {
          // Determine next node based on what needs resolution
          let nextNode;
          if (state.users_to_resolve?.length > 0) {
            nextNode = "resolve_users";
          } else if (state.contacts_to_resolve?.length > 0) {
            nextNode = "resolve_contacts";
          } else {
            nextNode = "check_conflicts";
          }
          console.log(`[CALENDAR:ROUTER] Create action routing to: ${nextNode}`);
          return nextNode;
        }
        if (state.action === "update") return "fetch_appointments";
        return "format_response";
      },
      {
        "fetch_appointments": "fetch_appointments",
        "resolve_contacts": "resolve_contacts",
        "resolve_users": "resolve_users",
        "check_conflicts": "check_conflicts",
        "format_response": "format_response"
      }
    );

    // User resolution flow - check if contacts need resolution after users
    workflow.addConditionalEdges(
      "resolve_users",
      (state) => {
        if (state.contacts_to_resolve?.length > 0) {
          return "resolve_contacts";
        }
        return "check_conflicts";
      },
      {
        "resolve_contacts": "resolve_contacts",
        "check_conflicts": "check_conflicts"
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

      // Use LLM to extract other details
      const parsePrompt = `
        Analyze this calendar-related query and extract:
        1. Action: view, create, update, or delete
        2. Appointment details (if creating/updating)
        3. Contact names mentioned (external people)
        4. User names mentioned (internal team members)
        5. Self-references like "me", "myself", "I"
        6. Keep the EXACT date/time expression as the user stated it

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
          "contacts": ["external person names"],
          "users": ["internal team member names"],
          "selfReferences": ["me", "myself", "I"] // if user refers to themselves
        }

        IMPORTANT:
        - For date_query, preserve EXACTLY what the user said, including the time.
        - Distinguish between external contacts and internal team members (users)
        - Detect self-references like "me", "myself", "I" and list them

        Examples:
        - "Schedule a meeting with John and me" → contacts: ["John"], selfReferences: ["me"]
        - "Book time with Sarah and Tyler" → users: ["Sarah", "Tyler"]
        - "Meeting with client Bob and myself" → contacts: ["Bob"], selfReferences: ["myself"]
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

    // Check if we're resuming from a user clarification
    if (state.user_clarification_response) {
      console.log("[CALENDAR:USERS] Resuming with clarification:", state.user_clarification_response);

      const clarifiedName = state.user_clarification_response.clarified_name;
      const originalQuery = state.user_clarification_response.original_query;
      const skipUser = state.user_clarification_response.skip;

      if (!skipUser && clarifiedName && clarifiedName.toLowerCase() !== 'skip') {
        // Replace the original query with the clarified name in users_to_resolve
        const updatedUsers = state.users_to_resolve.map(name =>
          name === originalQuery ? clarifiedName : name
        );

        // Continue with resolution using the clarified name
        return {
          ...state,
          users_to_resolve: updatedUsers,
          user_clarification_response: null // Clear the response
        };
      } else {
        // User chose to skip this user
        console.log(`[CALENDAR:USERS] User chose to skip user: ${originalQuery}`);

        // Remove the problematic user from the list and track as unresolved
        const remainingUsers = state.users_to_resolve.filter(name => name !== originalQuery);
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

      const resolved = [];
      const unresolved = [];

      for (const userQuery of state.users_to_resolve) {
        // Check for "me" reference
        if (this.userResolver.isSelfReference(userQuery)) {
          console.log("[CALENDAR:USERS] Resolving 'me' pronoun");
          const currentUser = await this.userResolver.resolveMe(sessionId, orgId);

          if (currentUser) {
            resolved.push(currentUser);
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

          // Throw interrupt for user clarification
          console.log(`[CALENDAR:USERS] Throwing interrupt for clarification`);
          throw interrupt({
            value: {
              type: 'user_clarification',
              message: `I couldn't find a team member named "${userQuery}".`,
              suggestions: suggestions,
              original_query: userQuery,
              prompt: suggestions.length > 0
                ? `Did you mean one of these team members: ${suggestions.join(', ')}? Or please type the correct name:`
                : `Could you please check the spelling and provide the correct name?`,
              allow_skip: true
            }
          });
        }

        // Check if we have only fuzzy matches
        const fuzzyMatches = candidates.filter(c => c.fuzzyMatch);
        if (fuzzyMatches.length > 0 && fuzzyMatches.length === candidates.length) {
          console.log(`[CALENDAR:USERS] Only fuzzy matches found for "${userQuery}"`);

          const topSuggestions = fuzzyMatches
            .slice(0, 3)
            .map(u => u.name);

          // Ask user to confirm fuzzy match
          throw interrupt({
            value: {
              type: 'user_clarification',
              message: `No exact match for team member "${userQuery}".`,
              suggestions: topSuggestions,
              original_query: userQuery,
              prompt: `Did you mean: ${topSuggestions[0]}? Or select from: ${topSuggestions.join(', ')}`,
              fuzzy_candidates: fuzzyMatches.slice(0, 3),
              allow_skip: true
            }
          });
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

        resolved.push(selected);
      }

      console.log(`[CALENDAR:USERS] Resolved ${resolved.length} users, ${unresolved.length} unresolved`);

      return {
        ...state,
        resolved_users: resolved,
        unresolved_users: unresolved
      };

    } catch (error) {
      if (error.name === 'GraphInterrupt') throw error;

      console.error("[CALENDAR:USERS] Error resolving users:", error);
      // Continue without users rather than failing
      return {
        ...state,
        resolved_users: []
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

    // Check if we're resuming from a contact clarification
    if (state.contact_clarification_response) {
      console.log("[CALENDAR:CONTACTS] Resuming with clarification:", state.contact_clarification_response);

      const clarifiedName = state.contact_clarification_response.clarified_name;
      const originalQuery = state.contact_clarification_response.original_query;
      const skipContact = state.contact_clarification_response.skip;

      if (!skipContact && clarifiedName && clarifiedName.toLowerCase() !== 'skip') {
        // Replace the original query with the clarified name in contacts_to_resolve
        const updatedContacts = state.contacts_to_resolve.map(name =>
          name === originalQuery ? clarifiedName : name
        );

        // Continue with resolution using the clarified name
        return {
          ...state,
          contacts_to_resolve: updatedContacts,
          contact_clarification_response: null // Clear the response
        };
      } else {
        // User chose to skip this contact
        console.log(`[CALENDAR:CONTACTS] User chose to skip contact: ${originalQuery}`);

        // Remove the problematic contact from the list and track as unresolved
        const remainingContacts = state.contacts_to_resolve.filter(name => name !== originalQuery);
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

    if (!state.contacts_to_resolve || state.contacts_to_resolve.length === 0) {
      return state;
    }

    try {
      const passKey = await config.configurable.getPassKey();
      const resolved = state.resolved_contacts || [];
      const unresolved = [];

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

          // Throw interrupt for user clarification
          console.log(`[CALENDAR:CONTACTS] Throwing interrupt for clarification`);
          throw interrupt({
            value: {
              type: 'contact_clarification',
              message: `I couldn't find anyone named "${contactName}".`,
              suggestions: suggestions,
              original_query: contactName,
              prompt: suggestions.length > 0
                ? `Did you mean one of these: ${suggestions.join(', ')}? Or please type the correct name:`
                : `Could you please check the spelling and provide the correct name?`,
              allow_skip: true
            }
          });
        }

        // Check if we have only fuzzy matches (no exact matches)
        const fuzzyMatches = candidates.filter(c => c.fuzzyMatch);
        if (fuzzyMatches.length > 0 && fuzzyMatches.length === candidates.length) {
          console.log(`[CALENDAR:CONTACTS] Only fuzzy matches found for "${contactName}"`);

          const topSuggestions = fuzzyMatches
            .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
            .slice(0, 3)
            .map(c => c.name);

          // Ask user to confirm fuzzy match
          throw interrupt({
            value: {
              type: 'contact_clarification',
              message: `No exact match for "${contactName}".`,
              suggestions: topSuggestions,
              original_query: contactName,
              prompt: `Did you mean: ${topSuggestions[0]}? Or select from: ${topSuggestions.join(', ')}`,
              fuzzy_candidates: fuzzyMatches.slice(0, 3),
              allow_skip: true
            }
          });
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
        resolved.push(selected.topCandidate || selected);
      }

      console.log(`[CALENDAR:CONTACTS] Resolved ${resolved.length} contacts, ${unresolved.length} unresolved`);

      return {
        ...state,
        resolved_contacts: resolved,
        unresolved_contacts: unresolved
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
        for (const contact of state.resolved_contacts) {
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
        }
        console.log(`[CALENDAR:ATTENDEES] Linked ${state.resolved_contacts.length} contacts`);
      }

      // Link users (internal team members)
      if (hasUsers) {
        for (const user of state.resolved_users) {
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
        }
        console.log(`[CALENDAR:ATTENDEES] Linked ${state.resolved_users.length} users`);
      }

      const totalAttendees = (state.resolved_contacts?.length || 0) + (state.resolved_users?.length || 0);
      console.log(`[CALENDAR:ATTENDEES] Total ${totalAttendees} attendees linked`);

      // Enrich appointment entity with participants for follow-up questions
      try {
        const contactNames = (state.resolved_contacts || []).map(c => c.name).filter(Boolean);
        const userNames = (state.resolved_users || []).map(u => u.name).filter(Boolean);
        const participants = [...contactNames, ...userNames];

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
          participantCount: participants.length,
          externalAttendees: contactNames,
          internalAttendees: userNames
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
