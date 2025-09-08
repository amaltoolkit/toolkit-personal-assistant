/**
 * Appointment Applier Agent
 * 
 * Applies approved appointment specifications to BSA by:
 * 1. Creating the appointment
 * 2. Linking attendees to the appointment
 */

const { baseApplier, findPreviewForAction, responsePatterns, withRetry, validateApplierConfig } = require('./baseApplier');
const axios = require('axios');

/**
 * Create an appointment in BSA
 */
async function createAppointmentInBSA(appointmentSpec, bsaConfig) {
  const url = `${bsaConfig.BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;
  
  // Convert AppointmentSpec to BSA format
  const payload = {
    PassKey: bsaConfig.passKey,
    OrganizationId: bsaConfig.orgId,
    ObjectName: "appointment",
    DataObject: {
      Subject: appointmentSpec.subject,
      Description: appointmentSpec.description || null,
      StartTime: appointmentSpec.startTime,
      EndTime: appointmentSpec.endTime,
      Location: appointmentSpec.location || null,
      AllDay: appointmentSpec.allDay || false,
      Complete: appointmentSpec.complete || false,
      AppointmentTypeId: appointmentSpec.appointmentTypeId || null
    },
    IncludeExtendedProperties: false
  };
  
  // Add linking fields if provided (primary contact/account)
  if (appointmentSpec.contactId) {
    payload.DataObject.ContactId = appointmentSpec.contactId;
  }
  if (appointmentSpec.accountId) {
    payload.DataObject.AccountId = appointmentSpec.accountId;
  }
  if (appointmentSpec.opportunityId) {
    payload.DataObject.OpportunityId = appointmentSpec.opportunityId;
  }
  
  console.log(`[APPOINTMENT:APPLY] Creating appointment: ${appointmentSpec.subject}`);
  console.log(`[APPOINTMENT:APPLY] Time: ${payload.DataObject.StartTime} to ${payload.DataObject.EndTime}`);
  
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000
  });
  
  // BSA responses are wrapped in arrays
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  
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
  
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000
  });
  
  // BSA responses are wrapped in arrays
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  
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
      
      const attendeeResults = await linkAttendeesToAppointment(
        results.appointmentId,
        spec.attendees,
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