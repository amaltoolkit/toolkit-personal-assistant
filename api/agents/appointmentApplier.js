/**
 * Appointment Applier Agent
 * 
 * Applies approved appointment specifications to BSA by:
 * 1. Creating the appointment
 * 2. Linking attendees to the appointment
 */

const { baseApplier, findPreviewForAction, responsePatterns, withRetry, validateApplierConfig } = require('./baseApplier');
const axios = require('axios');
const { withDedupe } = require('../lib/dedupe');
const { parseDateQuery } = require('../lib/dateParser');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

// Load dayjs plugins for timezone support
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Create an appointment in BSA
 */
async function createAppointmentInBSA(appointmentSpec, bsaConfig) {
  const url = `${bsaConfig.BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;
  
  // Handle natural language date parsing if dateQuery is provided
  let startTime = appointmentSpec.startTime;
  let endTime = appointmentSpec.endTime;
  
  // Always prioritize dateQuery when present - it's the source of truth for natural language dates
  if (appointmentSpec.dateQuery && appointmentSpec.dateQuery !== null) {
    const userTimezone = bsaConfig.timezone || 'UTC';
    console.log(`[APPOINTMENT:APPLY] Parsing natural language date: "${appointmentSpec.dateQuery}"`);
    
    // Extract just the date part by removing time patterns (e.g., "at 10 AM")
    const datePartOnly = appointmentSpec.dateQuery
      .replace(/\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)/gi, '')
      .trim();
    
    console.log(`[APPOINTMENT:APPLY] Extracted date part: "${datePartOnly}"`);
    const parsed = parseDateQuery(datePartOnly, userTimezone);
    if (parsed) {
      console.log(`[APPOINTMENT:APPLY] Parsed to: ${parsed.interpreted}`);
      
      // Check if the query includes a specific time
      const timeMatch = appointmentSpec.dateQuery.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)/i);
      
      if (timeMatch) {
        // User specified a time
        let hour = parseInt(timeMatch[1]);
        const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const meridiem = timeMatch[3]?.toLowerCase();
        
        // Convert to 24-hour format
        if (meridiem === 'pm' && hour !== 12) hour += 12;
        if (meridiem === 'am' && hour === 12) hour = 0;
        
        // Create start time on the parsed date IN the user's timezone
        const startDate = dayjs.tz(parsed.startDate, userTimezone)
          .hour(hour).minute(minute).second(0);
        startTime = startDate.toISOString();
        
        // Use duration or default to 60 minutes
        const duration = (appointmentSpec.duration && appointmentSpec.duration !== null) ? appointmentSpec.duration : 60;
        endTime = startDate.add(duration, 'minute').toISOString();
      } else {
        // No specific time - use business hours default (10 AM)
        const startDate = dayjs.tz(parsed.startDate, userTimezone)
          .hour(10).minute(0).second(0);
        startTime = startDate.toISOString();
        
        // Use duration or default to 60 minutes
        const duration = (appointmentSpec.duration && appointmentSpec.duration !== null) ? appointmentSpec.duration : 60;
        endTime = startDate.add(duration, 'minute').toISOString();
      }
    } else {
      // Parsing failed - fall back to provided times or error
      if (!startTime || !endTime) {
        throw new Error(`Could not parse date query: "${appointmentSpec.dateQuery}"`);
      }
    }
  }
  
  // Validate we have required times
  if (!startTime || !endTime) {
    throw new Error("Appointment must have both startTime and endTime");
  }
  
  // Convert AppointmentSpec to BSA format
  const payload = {
    PassKey: bsaConfig.passKey,
    OrganizationId: bsaConfig.orgId,
    ObjectName: "appointment",
    DataObject: {
      Subject: appointmentSpec.subject,
      Description: appointmentSpec.description || null,
      StartTime: startTime,
      EndTime: endTime,
      Location: appointmentSpec.location || null,
      AllDay: appointmentSpec.allDay || false,
      Complete: appointmentSpec.complete || false
    },
    IncludeExtendedProperties: false
  };
  
  // Add optional fields only if they have actual values (not null or empty string)
  if (appointmentSpec.appointmentTypeId && appointmentSpec.appointmentTypeId !== "") {
    payload.DataObject.AppointmentTypeId = appointmentSpec.appointmentTypeId;
  }
  if (appointmentSpec.contactId && appointmentSpec.contactId !== "") {
    payload.DataObject.ContactId = appointmentSpec.contactId;
  }
  if (appointmentSpec.accountId && appointmentSpec.accountId !== "") {
    payload.DataObject.AccountId = appointmentSpec.accountId;
  }
  if (appointmentSpec.opportunityId && appointmentSpec.opportunityId !== "") {
    payload.DataObject.OpportunityId = appointmentSpec.opportunityId;
  }
  
  console.log(`[APPOINTMENT:APPLY] Creating appointment: ${appointmentSpec.subject}`);
  console.log(`[APPOINTMENT:APPLY] Time: ${startTime} to ${endTime}`);
  
  // Wrap with deduplication (5 minute window)
  const result = await withDedupe(
    payload.DataObject, // Use the appointment data for deduplication
    5 * 60 * 1000, // 5 minute window
    async () => {
      const response = await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 10000
      });
      return response;
    }
  );
  
  // Check if this was a duplicate
  if (result.skipped) {
    console.log(`[APPOINTMENT:APPLY] Skipped duplicate appointment creation: ${appointmentSpec.subject}`);
    // Return success with the cached result from the previous attempt
    return {
      id: result.cachedResult?.id || "duplicate-detected",
      duplicate: true,
      message: `Appointment already created recently: ${appointmentSpec.subject}`
    };
  }
  
  // BSA responses are wrapped in arrays
  const data = Array.isArray(result.data) ? result.data[0] : result.data;
  
  if (!data.Valid) {
    throw new Error(data.ResponseMessage || data.StackMessage || "Failed to create appointment");
  }
  
  const appointmentId = data.DataObject?.Id;
  if (!appointmentId) {
    throw new Error("Appointment created but no ID returned");
  }
  
  console.log(`[APPOINTMENT:APPLY] Appointment created with ID: ${appointmentId}`);
  
  return {
    appointmentId,
    subject: data.DataObject.Subject,
    startTime: data.DataObject.StartTime,
    endTime: data.DataObject.EndTime,
    location: data.DataObject.Location,
    createdOn: data.DataObject.CreatedOn
  };
}

/**
 * Link a single attendee to an appointment
 */
async function linkAttendeeToAppointment(appointmentId, attendeeType, attendeeId, bsaConfig) {
  const url = `${bsaConfig.BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/link.json`;
  
  // Determine the correct linker type and right object name
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
      throw new Error(`Invalid attendee type: ${attendeeType}`);
  }
  
  const payload = {
    PassKey: bsaConfig.passKey,
    OrganizationId: bsaConfig.orgId,
    ObjectName: linkerType,
    LeftObjectName: 'appointment',
    LeftId: appointmentId,
    RightObjectName: rightObjectName,
    RightId: attendeeId
  };
  
  console.log(`[APPOINTMENT:APPLY] Linking ${attendeeType} ${attendeeId} to appointment ${appointmentId}`);
  
  // Wrap with deduplication to prevent duplicate links
  // Use composite key: linkerType + appointmentId + attendeeId
  const dedupeKey = {
    linkerType,
    appointmentId,
    attendeeId
  };
  
  const result = await withDedupe(
    dedupeKey,
    5 * 60 * 1000, // 5 minute window
    async () => {
      const response = await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 10000
      });
      return response;
    }
  );
  
  // Check if this was a duplicate
  if (result.skipped) {
    console.log(`[APPOINTMENT:APPLY] Skipped duplicate link: ${attendeeType} ${attendeeId} already linked to appointment ${appointmentId}`);
    return {
      success: true,
      attendeeType,
      attendeeId,
      linkerId: null,
      skipped: true,
      message: `Duplicate link detected: ${attendeeType} was already linked recently`
    };
  }
  
  // BSA responses are wrapped in arrays
  const data = Array.isArray(result.data) ? result.data[0] : result.data;
  
  if (!data.Valid) {
    throw new Error(data.ResponseMessage || data.StackMessage || `Failed to link ${attendeeType}`);
  }
  
  return {
    success: true,
    attendeeType,
    attendeeId,
    linkerId: data.DataObject?.Id
  };
}

/**
 * Link multiple attendees to an appointment
 */
async function linkAttendeesToAppointment(appointmentId, attendees, bsaConfig) {
  const results = [];
  const errors = [];
  
  if (!attendees || attendees.length === 0) {
    console.log("[APPOINTMENT:APPLY] No attendees to link");
    return { results, errors };
  }
  
  for (const attendee of attendees) {
    try {
      const linkResult = await linkAttendeeToAppointment(
        appointmentId,
        attendee.type,
        attendee.id,
        bsaConfig
      );
      
      results.push({
        ...linkResult,
        role: attendee.role
      });
      
    } catch (error) {
      console.error(`[APPOINTMENT:APPLY] Failed to link ${attendee.type} ${attendee.id}:`, error.message);
      errors.push({
        type: attendee.type,
        id: attendee.id,
        role: attendee.role,
        error: error.message
      });
    }
  }
  
  return { results, errors };
}

/**
 * Apply the appointment to BSA (create + link attendees)
 */
async function applyAppointmentToBSA(spec, bsaConfig, config) {
  // Add timezone to bsaConfig for date parsing
  bsaConfig.timezone = config?.configurable?.user_tz || 'UTC';
  
  const results = {
    appointmentId: null,
    subject: null,
    attendeeResults: [],
    errors: []
  };
  
  try {
    // Phase 1: Create the appointment
    console.log(`[APPOINTMENT:APPLY] Phase 1: Creating appointment "${spec.subject}"`);
    
    // Ensure dates are in ISO format
    const ensureISO = (dateStr) => {
      if (!dateStr) return null;
      try {
        // If it's already a valid ISO string, return as is
        if (dateStr.includes('T')) {
          return dateStr;
        }
        // Otherwise, parse and convert
        const date = new Date(dateStr);
        return date.toISOString();
      } catch (e) {
        console.warn(`[APPOINTMENT:APPLY] Invalid date format: ${dateStr}`);
        return dateStr; // Return as is and let BSA handle validation
      }
    };
    
    // Prepare appointment spec with formatted dates
    const formattedSpec = {
      ...spec,
      startTime: ensureISO(spec.startTime),
      endTime: ensureISO(spec.endTime)
    };
    
    // Create the appointment with retry logic
    const appointmentResult = await withRetry(
      () => createAppointmentInBSA(formattedSpec, bsaConfig),
      2, // max retries
      1000 // delay between retries
    );
    
    results.appointmentId = appointmentResult.appointmentId;
    results.subject = appointmentResult.subject;
    results.startTime = appointmentResult.startTime;
    results.endTime = appointmentResult.endTime;
    results.location = appointmentResult.location;
    results.createdOn = appointmentResult.createdOn;
    
    // Phase 2: Link attendees if any
    if (spec.attendees && spec.attendees.length > 0) {
      console.log(`[APPOINTMENT:APPLY] Phase 2: Linking ${spec.attendees.length} attendee(s)`);
      
      // Filter out primary entities that are already linked via direct fields
      const filteredAttendees = spec.attendees.filter(attendee => {
        // Skip contact if it's the primary contact
        if (attendee.type.toLowerCase() === 'contact' && attendee.id === spec.contactId) {
          console.log(`[APPOINTMENT:APPLY] Skipping primary contact ${attendee.id} - already linked via ContactId field`);
          return false;
        }
        
        // Skip company if it's the primary account
        if (attendee.type.toLowerCase() === 'company' && attendee.id === spec.accountId) {
          console.log(`[APPOINTMENT:APPLY] Skipping primary account ${attendee.id} - already linked via AccountId field`);
          return false;
        }
        
        // Note: We don't filter opportunityId as it's not typically an attendee
        return true;
      });
      
      // Log if we filtered any attendees
      const filteredCount = spec.attendees.length - filteredAttendees.length;
      if (filteredCount > 0) {
        console.log(`[APPOINTMENT:APPLY] Filtered ${filteredCount} primary entity/entities from attendees list`);
      }
      
      const attendeeResults = await linkAttendeesToAppointment(
        results.appointmentId,
        filteredAttendees,
        bsaConfig
      );
      
      results.attendeeResults = attendeeResults.results;
      results.attendeeErrors = attendeeResults.errors;
      
      const successCount = attendeeResults.results.length;
      const errorCount = attendeeResults.errors.length;
      
      console.log(`[APPOINTMENT:APPLY] Attendee linking: ${successCount} succeeded, ${errorCount} failed`);
      
      if (errorCount > 0) {
        results.errors = results.errors.concat(attendeeResults.errors);
      }
    } else {
      console.log("[APPOINTMENT:APPLY] No attendees to link");
    }
    
    console.log(`[APPOINTMENT:APPLY] Appointment creation complete: "${results.subject}" (ID: ${results.appointmentId})`);
    
    return results;
    
  } catch (error) {
    console.error(`[APPOINTMENT:APPLY] Critical error during appointment creation:`, error.message);
    results.errors.push({
      phase: "creation",
      error: error.message
    });
    throw error;
  }
}

/**
 * Extract result data for artifacts
 */
function extractAppointmentResult(result) {
  return {
    appointmentId: result.appointmentId,
    subject: result.subject,
    startTime: result.startTime,
    endTime: result.endTime,
    location: result.location,
    createdOn: result.createdOn,
    attendees: {
      linked: result.attendeeResults || [],
      errors: result.attendeeErrors || [],
      totalLinked: (result.attendeeResults || []).length,
      totalErrors: (result.attendeeErrors || []).length
    },
    errors: result.errors,
    summary: {
      appointmentCreated: !!result.appointmentId,
      attendeesLinked: (result.attendeeResults || []).length,
      attendeesFailed: (result.attendeeErrors || []).length,
      hasErrors: result.errors.length > 0
    }
  };
}

/**
 * Main appointment applier function
 * Applies appointment specifications to BSA
 */
async function apply_create_appointment(state, config) {
  const applierConfig = {
    actionType: "create_appointment",
    applyFunction: applyAppointmentToBSA,
    extractResult: extractAppointmentResult
  };
  
  // Validate configuration
  validateApplierConfig(applierConfig);
  
  console.log("[APPOINTMENT:APPLIER] Applying appointment to BSA...");
  
  try {
    // Use base applier to handle common patterns
    const result = await baseApplier(state, config, applierConfig);
    
    // Add appointment-specific logging
    if (result.artifacts?.create_appointment) {
      const appointment = result.artifacts.create_appointment;
      console.log(`[APPOINTMENT:APPLIER] Appointment "${appointment.subject}" created`);
      console.log(`[APPOINTMENT:APPLIER] ID: ${appointment.appointmentId}`);
      console.log(`[APPOINTMENT:APPLIER] Time: ${appointment.startTime} to ${appointment.endTime}`);
      
      if (appointment.attendees) {
        console.log(`[APPOINTMENT:APPLIER] Attendees: ${appointment.attendees.totalLinked} linked, ${appointment.attendees.totalErrors} failed`);
      }
      
      if (appointment.errors && appointment.errors.length > 0) {
        console.warn("[APPOINTMENT:APPLIER] Some issues occurred:", appointment.errors);
      }
    }
    
    return result;
    
  } catch (error) {
    console.error("[APPOINTMENT:APPLIER:ERROR]", error);
    throw error;
  }
}

/**
 * Standalone function to apply appointment (for testing)
 */
async function applyAppointment(spec, passKey, orgId, options = {}) {
  const state = {
    action: { id: `appointment_${Date.now()}` },
    previews: [{
      actionId: `appointment_${Date.now()}`,
      kind: "appointment",
      spec
    }]
  };
  
  const config = {
    configurable: {
      passKey,
      orgId,
      BSA_BASE: options.BSA_BASE || process.env.BSA_BASE || "https://rc.bluesquareapps.com"
    }
  };
  
  const result = await apply_create_appointment(state, config);
  return result.artifacts?.create_appointment;
}

module.exports = {
  apply_create_appointment,
  applyAppointment,
  createAppointmentInBSA,
  linkAttendeeToAppointment,
  linkAttendeesToAppointment,
  applyAppointmentToBSA,
  extractAppointmentResult
};