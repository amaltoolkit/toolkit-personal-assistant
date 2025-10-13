/**
 * Calendar Agent Tools - Tool-Calling Architecture
 *
 * Phase 1: Read-Only Operations
 * - list_appointments: View appointments in date range
 * - parse_datetime: Parse natural language dates/times
 *
 * Future Phases:
 * - preview_appointment: Generate preview for approval
 * - create_appointment: Create appointment after approval
 * - check_conflicts: Check for scheduling conflicts
 * - update_appointment: Modify existing appointments
 */

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { getAppointments } = require("../../../integrations/bsa/tools/appointments");
const { parseDateQuery, parseDateTimeQuery, calculateEndTime } = require("../../../utils/chronoParser");
const { getContactLinker } = require("../../../services/entities/contactLinker");
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

// Import BSA integration for appointment creation
const axios = require('axios');
const bsaConfig = require('../../../integrations/bsa/config');
const { normalizeBSAResponse } = require('../../../integrations/bsa/tools/common');

/**
 * Tool 1: List Appointments
 *
 * View appointments in a date range using natural language.
 * Examples: "this week", "today", "next month", "October 2025"
 */
const listAppointmentsTool = tool(
  async ({ dateRange, timezone: userTimezone }, config) => {
    console.log("[TOOL:LIST] Listing appointments for:", dateRange);

    try {
      const context = config.context;

      // Parse date range using natural language parser
      const parsed = parseDateQuery(dateRange, userTimezone || 'UTC');

      if (!parsed) {
        return JSON.stringify({
          error: "Could not parse date range",
          suggestion: "Try: 'this week', 'today', 'next month', 'October 2025'"
        });
      }

      console.log("[TOOL:LIST] Parsed dates:", {
        query: dateRange,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        interpreted: parsed.interpreted
      });

      // Fetch appointments from BSA
      const result = await getAppointments({
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        includeAttendees: true,
        timeZone: userTimezone || 'UTC'
      }, context.passKey, context.org_id);

      // Handle different response formats (normalized vs raw BSA)
      const appointments = result?.appointments || result?.Results || [];

      console.log(`[TOOL:LIST] Found ${appointments.length} appointment(s)`);

      // Format appointments for LLM consumption
      const formatted = appointments.map(appt => ({
        id: appt.Id,
        subject: appt.Subject,
        startTime: appt.StartTime,
        endTime: appt.EndTime,
        location: appt.Location || "",
        isAllDay: appt.IsAllDay || false,
        attendeeCount: appt.Attendees ? appt.Attendees.length : 0,
        // Include human-readable time
        displayTime: formatAppointmentTime(appt, userTimezone || 'UTC')
      }));

      // Register appointments as entities for potential cross-domain use
      const entities = formatted.map(appt => ({
        type: 'appointment',
        id: appt.id,
        name: appt.subject,
        time: appt.startTime
      }));

      return JSON.stringify({
        count: formatted.length,
        dateRange: {
          start: parsed.startDate,
          end: parsed.endDate,
          interpreted: parsed.interpreted
        },
        appointments: formatted,
        entities: entities
      });

    } catch (error) {
      console.error("[TOOL:LIST] Error listing appointments:", error);
      return JSON.stringify({
        error: error.message,
        code: error.code || 'LIST_FAILED'
      });
    }
  },
  {
    name: "list_appointments",
    description: "View appointments in a date range. Use natural language like 'this week', 'today', 'next month', or specific dates like 'October 2025'. Returns list of appointments with times, locations, and attendee counts.",
    schema: z.object({
      dateRange: z.string().describe("Natural language date range (e.g., 'this week', 'today', 'next month', 'October 14-20')"),
      timezone: z.string().optional().describe("User's timezone (e.g., 'America/Los_Angeles'). Defaults to UTC if not provided.")
    })
  }
);

/**
 * Tool 2: Parse Date/Time
 *
 * Parse natural language date/time expressions into ISO timestamps.
 * Handles expressions like "tomorrow at 3pm", "next Tuesday 2pm", "Oct 14 at 9am"
 */
const parseDateTimeTool = tool(
  async ({ expression, duration, timezone: userTimezone }, config) => {
    console.log("[TOOL:PARSE] Parsing datetime:", expression);

    try {
      const tz = userTimezone || 'UTC';

      // Use chronoParser to parse the expression
      const result = parseDateTimeQuery(expression, tz);

      if (!result) {
        return JSON.stringify({
          error: "Could not parse date/time expression",
          suggestion: "Try: 'tomorrow at 3pm', 'next Tuesday 2pm', 'October 14 at 9am'",
          expression: expression
        });
      }

      // Check if time was specified
      if (!result.hasTime) {
        return JSON.stringify({
          error: "No time specified in expression",
          suggestion: "Please include a time (e.g., 'tomorrow at 3pm' instead of just 'tomorrow')",
          expression: expression
        });
      }

      // Calculate end time based on duration
      const durationMinutes = duration || 60; // Default to 1 hour
      const endTime = calculateEndTime(result.startDateTime, durationMinutes);

      console.log("[TOOL:PARSE] Parsed datetime:", {
        expression,
        startTime: result.startDateTime,
        endTime: endTime,
        duration: durationMinutes,
        interpreted: result.interpreted,
        timezone: tz
      });

      return JSON.stringify({
        startTime: result.startDateTime,
        endTime: endTime,
        duration: durationMinutes,
        expression: expression,
        interpreted: result.interpreted,
        timezone: tz
      });

    } catch (error) {
      console.error("[TOOL:PARSE] Error parsing datetime:", error);
      return JSON.stringify({
        error: error.message,
        expression: expression
      });
    }
  },
  {
    name: "parse_datetime",
    description: "Parse natural language date/time expressions into ISO timestamps. Use this to convert user-friendly times like 'tomorrow at 3pm' or 'next Tuesday 2pm' into exact start and end times. Always use this when the user specifies a time for an appointment.",
    schema: z.object({
      expression: z.string().describe("Natural language date/time expression (e.g., 'tomorrow at 3pm', 'next Tuesday 2pm', 'Oct 14 at 9am')"),
      duration: z.number().optional().describe("Duration in minutes (default: 60). How long the appointment should last."),
      timezone: z.string().optional().describe("User's timezone (e.g., 'America/Los_Angeles'). Defaults to UTC if not provided.")
    })
  }
);

/**
 * Tool 3: Check Conflicts
 *
 * Check if a proposed appointment time conflicts with existing appointments.
 * Returns list of conflicting appointments with overlap details.
 */
const checkConflictsTool = tool(
  async ({ startTime, endTime, timezone: userTimezone }, config) => {
    console.log("[TOOL:CONFLICTS] Checking conflicts:", { startTime, endTime });

    try {
      const context = config.context;
      const tz = userTimezone || 'UTC';

      // Get the date for the appointment
      const appointmentDate = startTime.split('T')[0];

      // Fetch all appointments for that day
      const result = await getAppointments({
        startDate: appointmentDate,
        endDate: appointmentDate,
        includeAttendees: false,
        timeZone: tz
      }, context.passKey, context.org_id);

      const appointments = result?.appointments || result?.Results || [];

      // Check for time overlaps
      const conflicts = [];
      const newStart = new Date(startTime);
      const newEnd = new Date(endTime);

      for (const appt of appointments) {
        const existingStart = new Date(appt.StartTime);
        const existingEnd = new Date(appt.EndTime);

        // Check if times overlap: newStart < existingEnd AND newEnd > existingStart
        if (newStart < existingEnd && newEnd > existingStart) {
          // Calculate overlap duration in minutes
          const overlapStart = new Date(Math.max(newStart.getTime(), existingStart.getTime()));
          const overlapEnd = new Date(Math.min(newEnd.getTime(), existingEnd.getTime()));
          const overlapMinutes = Math.round((overlapEnd - overlapStart) / (1000 * 60));

          conflicts.push({
            id: appt.Id,
            subject: appt.Subject,
            startTime: appt.StartTime,
            endTime: appt.EndTime,
            location: appt.Location || "",
            overlapMinutes: overlapMinutes,
            displayTime: formatAppointmentTime(appt, tz)
          });
        }
      }

      console.log(`[TOOL:CONFLICTS] Found ${conflicts.length} conflict(s)`);

      return JSON.stringify({
        hasConflicts: conflicts.length > 0,
        conflictCount: conflicts.length,
        conflicts: conflicts
      });

    } catch (error) {
      console.error("[TOOL:CONFLICTS] Error checking conflicts:", error);
      return JSON.stringify({
        error: error.message,
        code: error.code || 'CONFLICT_CHECK_FAILED'
      });
    }
  },
  {
    name: "check_conflicts",
    description: "Check if a proposed appointment time conflicts with existing appointments. Use this before creating an appointment to warn the user about scheduling conflicts. Returns list of conflicting appointments with overlap details.",
    schema: z.object({
      startTime: z.string().describe("ISO timestamp for proposed appointment start (e.g., '2025-10-14T22:00:00Z')"),
      endTime: z.string().describe("ISO timestamp for proposed appointment end (e.g., '2025-10-14T23:00:00Z')"),
      timezone: z.string().optional().describe("User's timezone for formatting conflict times")
    })
  }
);

/**
 * Tool 4: Preview Appointment
 *
 * Generate a preview of the appointment for user approval.
 * This tool does NOT create anything - it just prepares a preview.
 * Returns requiresApproval flag that handleQuery will detect.
 */
const previewAppointmentTool = tool(
  async ({ subject, startTime, endTime, attendees, location, description, timezone: userTimezone }, config) => {
    console.log("[TOOL:PREVIEW] Generating preview for:", subject);

    try {
      const tz = userTimezone || 'UTC';

      // Format the date/time for display
      const start = dayjs(startTime).tz(tz);
      const end = dayjs(endTime).tz(tz);

      const dateDisplay = start.format('MMM D, YYYY');
      const timeDisplay = `${start.format('h:mm A')} - ${end.format('h:mm A')} ${start.format('z')}`;
      const durationMinutes = Math.round((new Date(endTime) - new Date(startTime)) / (1000 * 60));

      // Build preview details
      const details = [
        { label: "Subject", value: subject },
        { label: "Date", value: dateDisplay },
        { label: "Time", value: timeDisplay },
        { label: "Duration", value: `${durationMinutes} minutes` }
      ];

      if (location && location.trim()) {
        details.push({ label: "Location", value: location });
      }

      if (description && description.trim()) {
        details.push({ label: "Description", value: description });
      }

      // Format attendees if provided
      if (attendees && attendees.length > 0) {
        const contacts = attendees.filter(a => a.type === 'contact');
        const users = attendees.filter(a => a.type === 'user');

        if (contacts.length > 0) {
          details.push({
            label: "External Attendees",
            value: contacts.map(c => c.name).join(", ")
          });
        }

        if (users.length > 0) {
          details.push({
            label: "Team Members",
            value: users.map(u => u.name).join(", ")
          });
        }
      }

      // Check for conflicts
      const context = config.context;
      const conflictResult = await checkConflictsTool.invoke(
        { startTime, endTime, timezone: tz },
        { context }
      );

      const conflictData = JSON.parse(conflictResult);
      const warnings = [];

      if (conflictData.hasConflicts) {
        for (const conflict of conflictData.conflicts) {
          warnings.push(`Conflicts with: "${conflict.subject}" (${conflict.overlapMinutes} min overlap)`);
        }
      }

      // Build the preview object
      const preview = {
        type: 'appointment',
        action: 'create',
        title: subject,
        details: details
      };

      if (warnings.length > 0) {
        preview.warnings = warnings;
      }

      console.log("[TOOL:PREVIEW] Preview generated with", details.length, "details");

      // Return with requiresApproval marker
      // handleQuery will detect this and return interrupt state to Coordinator
      return JSON.stringify({
        requiresApproval: true,
        action: 'create',
        preview: preview,
        // Store appointment data for later creation (Phase 3)
        appointmentData: {
          subject: subject || "New Appointment",
          startTime,
          endTime,
          location: location || "",
          description: description || "",
          isAllDay: false
        },
        // Store resolved attendees for later linking (Phase 3)
        resolvedAttendees: attendees || []
      });

    } catch (error) {
      console.error("[TOOL:PREVIEW] Error generating preview:", error);
      return JSON.stringify({
        error: error.message,
        code: error.code || 'PREVIEW_FAILED'
      });
    }
  },
  {
    name: "preview_appointment",
    description: "Generate a preview of an appointment before creating it. This will show the user what will be created and request approval. ALWAYS call this BEFORE attempting to create any appointment. This tool does not create anything - it only prepares a preview for user review.",
    schema: z.object({
      subject: z.string().describe("Appointment subject/title"),
      startTime: z.string().describe("ISO timestamp for start (from parse_datetime tool)"),
      endTime: z.string().describe("ISO timestamp for end (from parse_datetime tool)"),
      attendees: z.array(z.object({
        id: z.string(),
        name: z.string(),
        type: z.enum(['contact', 'user'])
      })).optional().describe("List of resolved attendees with their IDs, names, and types"),
      location: z.string().optional().describe("Location of the appointment"),
      description: z.string().optional().describe("Description or notes about the appointment"),
      timezone: z.string().optional().describe("User's timezone for formatting times")
    })
  }
);

/**
 * Tool 5: Create Appointment
 *
 * Creates an appointment in BSA with attendee linking.
 * This tool bundles the creation and linking operations.
 * Should only be called after preview approval.
 */
const createAppointmentTool = tool(
  async ({ appointmentData, resolvedAttendees }, config) => {
    console.log("[TOOL:CREATE] Creating appointment:", appointmentData.subject);

    try {
      const context = config.context;

      // Step 1: Create appointment via BSA API
      const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json';
      const payload = {
        IncludeExtendedProperties: false,
        DataObject: {
          Subject: appointmentData.subject,
          StartTime: appointmentData.startTime,
          EndTime: appointmentData.endTime,
          Location: appointmentData.location || "",
          Description: appointmentData.description || "",
          AllDay: appointmentData.isAllDay || false,
          RollOver: false,
          Complete: false
        },
        OrganizationId: context.org_id,
        PassKey: context.passKey,
        ObjectName: "appointment"
      };

      console.log("[TOOL:CREATE] Calling BSA create endpoint");

      const response = await axios.post(
        bsaConfig.buildEndpoint(endpoint),
        payload,
        {
          headers: {
            'Authorization': `Bearer ${context.passKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      const normalized = normalizeBSAResponse(response.data);
      if (!normalized.valid) {
        throw new Error(normalized.error || 'Failed to create appointment');
      }

      const appointment = normalized.DataObject;
      console.log("[TOOL:CREATE] Appointment created:", appointment.Id);

      // Step 2: Link attendees if provided
      let linkedContacts = 0;
      let linkedUsers = 0;

      if (resolvedAttendees && resolvedAttendees.length > 0) {
        console.log(`[TOOL:CREATE] Linking ${resolvedAttendees.length} attendees`);

        const contactLinker = getContactLinker();

        for (const attendee of resolvedAttendees) {
          try {
            if (attendee.type === 'contact') {
              await contactLinker.linkContact(
                'appointment',
                appointment.Id,
                attendee.id,
                context.passKey
              );
              linkedContacts++;
              console.log(`[TOOL:CREATE] Linked contact: ${attendee.name}`);
            } else if (attendee.type === 'user') {
              // For users, use the same linker with a different linker type
              await contactLinker.linkContact(
                'appointment',
                appointment.Id,
                attendee.id,
                context.passKey
              );
              linkedUsers++;
              console.log(`[TOOL:CREATE] Linked user: ${attendee.name}`);
            }
          } catch (linkError) {
            console.error(`[TOOL:CREATE] Failed to link ${attendee.name}:`, linkError.message);
            // Continue with other attendees
          }
        }

        console.log(`[TOOL:CREATE] Linked ${linkedContacts} contacts and ${linkedUsers} users`);
      }

      // Step 3: Register entity for cross-domain use
      const entity = {
        type: 'appointment',
        id: appointment.Id,
        name: appointment.Subject,
        time: appointment.StartTime,
        attendees: {
          total: resolvedAttendees ? resolvedAttendees.length : 0,
          linked: linkedContacts + linkedUsers
        }
      };

      // Return success with entity registration
      return JSON.stringify({
        success: true,
        appointment: {
          id: appointment.Id,
          subject: appointment.Subject,
          startTime: appointment.StartTime,
          endTime: appointment.EndTime,
          location: appointment.Location
        },
        entity: entity,
        attendees: {
          total: resolvedAttendees ? resolvedAttendees.length : 0,
          linked: linkedContacts + linkedUsers,
          contacts: linkedContacts,
          users: linkedUsers
        }
      });

    } catch (error) {
      console.error("[TOOL:CREATE] Error creating appointment:", error);
      return JSON.stringify({
        success: false,
        error: error.message,
        code: error.code || 'CREATE_FAILED'
      });
    }
  },
  {
    name: "create_appointment",
    description: "Create an appointment in the calendar. This should ONLY be called after the user has approved the preview. The tool creates the appointment and links all attendees automatically.",
    schema: z.object({
      appointmentData: z.object({
        subject: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        location: z.string().optional(),
        description: z.string().optional(),
        isAllDay: z.boolean().optional()
      }),
      resolvedAttendees: z.array(z.object({
        id: z.string(),
        name: z.string(),
        type: z.enum(['contact', 'user'])
      })).optional()
    })
  }
);

/**
 * Helper: Format appointment time for human readability
 */
function formatAppointmentTime(appt, timezone) {
  if (appt.IsAllDay) {
    return "All day";
  }

  const start = dayjs(appt.StartTime).tz(timezone);
  const end = dayjs(appt.EndTime).tz(timezone);

  // Same day: "Oct 14, 2025 • 3:00 PM - 4:00 PM PDT"
  if (start.format('YYYY-MM-DD') === end.format('YYYY-MM-DD')) {
    return `${start.format('MMM D, YYYY')} • ${start.format('h:mm A')} - ${end.format('h:mm A')} ${start.format('z')}`;
  }

  // Multi-day: "Oct 14, 3:00 PM - Oct 15, 4:00 PM PDT"
  return `${start.format('MMM D, h:mm A')} - ${end.format('MMM D, h:mm A')} ${start.format('z')}`;
}

/**
 * Export tools for use in Calendar agent
 */
function getCalendarTools() {
  return [
    listAppointmentsTool,
    parseDateTimeTool,
    checkConflictsTool,
    previewAppointmentTool,
    createAppointmentTool
  ];
}

module.exports = {
  getCalendarTools,
  listAppointmentsTool,
  parseDateTimeTool,
  checkConflictsTool,
  previewAppointmentTool,
  createAppointmentTool
};
