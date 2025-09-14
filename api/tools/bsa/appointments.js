/**
 * BSA Appointments Tools
 * Extracted from activitiesAgent.js for modular architecture
 */

const axios = require('axios');
const { normalizeBSAResponse } = require('./common');
const { parseDateQuery } = require('../../lib/dateParser');
const bsaConfig = require('../../config/bsa');

/**
 * Get appointments from BSA
 * @param {Object} params - Query parameters
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Appointments data
 */
async function getAppointments(params, passKey, orgId) {
  const {
    startDate,
    endDate,
    dateQuery,
    includeAttendees = true,
    includeExtendedProperties = false,
    timeZone = 'UTC'
  } = params;
  
  // Handle natural language date queries
  let effectiveFrom = startDate;
  let effectiveTo = endDate;
  
  if (dateQuery && !startDate && !endDate) {
    const parsed = parseDateQuery(dateQuery, timeZone);
    if (parsed) {
      console.log("[BSA:APPOINTMENTS] Parsed date query:", dateQuery, "=>", parsed);
      effectiveFrom = parsed.startDate;
      effectiveTo = parsed.endDate;
    }
  }
  
  // BSA API quirk: Same From/To date returns empty results
  // Must use From = date-1, To = date for single-day queries
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const addDays = (ymd, days) => {
    const d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  
  if (effectiveFrom && effectiveTo && effectiveFrom === effectiveTo) {
    effectiveFrom = addDays(effectiveFrom, -1);
  } else if (effectiveFrom && !effectiveTo) {
    effectiveTo = effectiveFrom;
    effectiveFrom = addDays(effectiveFrom, -1);
  } else if (!effectiveFrom && effectiveTo) {
    effectiveFrom = addDays(effectiveTo, -1);
  }
  
  console.log("[BSA:APPOINTMENTS] Fetching with date range:", { effectiveFrom, effectiveTo });
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivities.json';
  const payload = {
    orgId,
    IncludeAppointments: true,
    IncludeTasks: false,
    From: effectiveFrom,
    To: effectiveTo,
    IncludeAttendees: includeAttendees,
    IncludeExtendedProperties: includeExtendedProperties
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: {
          'Authorization': `Bearer ${passKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Invalid BSA response');
    }
    
    return {
      appointments: normalized.activities || [],
      count: normalized.activities?.length || 0
    };
  } catch (error) {
    console.error('[BSA:APPOINTMENTS] Error fetching:', error.message);
    throw error;
  }
}

/**
 * Create an appointment in BSA
 * @param {Object} data - Appointment data
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Created appointment
 */
async function createAppointment(data, passKey, orgId) {
  const {
    subject,
    startTime,
    endTime,
    location,
    description,
    isAllDay = false,
    reminder = 15,
    contactIds = []
  } = data;
  
  console.log("[BSA:APPOINTMENTS] Creating appointment:", subject);
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/updateAppointment.json';
  const payload = {
    OrgId: orgId,
    Activity: {
      EntityName: "Activity",
      Subject: subject,
      StartTime: startTime,
      EndTime: endTime,
      Location: location || "",
      Description: description || "",
      TypeCode: "appointment",
      IsAllDayEvent: isAllDay,
      AppointmentBookId: "default",
      ReminderMinutesBeforeStart: reminder,
      Priority: "normal",
      ShowAs: "busy"
    }
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: {
          'Authorization': `Bearer ${passKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to create appointment');
    }
    
    const appointment = normalized.Activity;
    console.log("[BSA:APPOINTMENTS] Created appointment ID:", appointment.Id);
    
    // Link contacts if provided
    if (contactIds.length > 0 && appointment.Id) {
      await linkAttendees(appointment.Id, contactIds, passKey, orgId);
    }
    
    return appointment;
  } catch (error) {
    console.error('[BSA:APPOINTMENTS] Error creating:', error.message);
    throw error;
  }
}

/**
 * Update an existing appointment
 * @param {string} appointmentId - Appointment ID to update
 * @param {Object} updates - Fields to update
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Updated appointment
 */
async function updateAppointment(appointmentId, updates, passKey, orgId) {
  console.log("[BSA:APPOINTMENTS] Updating appointment:", appointmentId);
  
  // First fetch the existing appointment
  const existing = await getAppointmentById(appointmentId, passKey, orgId);
  if (!existing) {
    throw new Error(`Appointment ${appointmentId} not found`);
  }
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/updateAppointment.json';
  const payload = {
    OrgId: orgId,
    Activity: {
      ...existing,
      ...updates,
      Id: appointmentId,
      EntityName: "Activity",
      TypeCode: "appointment"
    }
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: {
          'Authorization': `Bearer ${passKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to update appointment');
    }
    
    return normalized.Activity;
  } catch (error) {
    console.error('[BSA:APPOINTMENTS] Error updating:', error.message);
    throw error;
  }
}

/**
 * Get a single appointment by ID
 * @param {string} appointmentId - Appointment ID
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object|null>} Appointment or null if not found
 */
async function getAppointmentById(appointmentId, passKey, orgId) {
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivity.json';
  const payload = {
    OrgId: orgId,
    ActivityId: appointmentId
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: {
          'Authorization': `Bearer ${passKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      return null;
    }
    
    return normalized.Activity;
  } catch (error) {
    console.error('[BSA:APPOINTMENTS] Error fetching by ID:', error.message);
    return null;
  }
}

/**
 * Link attendees to an appointment
 * @param {string} appointmentId - Appointment ID
 * @param {Array<string>} contactIds - Array of contact IDs
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Link result
 */
async function linkAttendees(appointmentId, contactIds, passKey, orgId) {
  console.log(`[BSA:APPOINTMENTS] Linking ${contactIds.length} attendees to appointment ${appointmentId}`);
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/updateActivityLinks.json';
  const payload = {
    OrgId: orgId,
    Id: appointmentId,
    TypeCode: "appointment",
    LinkerName: "ActivityContactLinker",
    LinkedEntitySchemaName: "Contact",
    Action: 1, // Add links
    ItemIds: contactIds
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: {
          'Authorization': `Bearer ${passKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to link attendees');
    }
    
    console.log("[BSA:APPOINTMENTS] Successfully linked attendees");
    return { linked: true, appointmentId, contactIds };
  } catch (error) {
    console.error('[BSA:APPOINTMENTS] Error linking attendees:', error.message);
    throw error;
  }
}

/**
 * Delete an appointment
 * @param {string} appointmentId - Appointment ID to delete
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Deletion result
 */
async function deleteAppointment(appointmentId, passKey, orgId) {
  console.log("[BSA:APPOINTMENTS] Deleting appointment:", appointmentId);
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/deleteActivity.json';
  const payload = {
    OrgId: orgId,
    ActivityId: appointmentId
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: {
          'Authorization': `Bearer ${passKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to delete appointment');
    }
    
    console.log("[BSA:APPOINTMENTS] Successfully deleted");
    return { deleted: true, appointmentId };
  } catch (error) {
    console.error('[BSA:APPOINTMENTS] Error deleting:', error.message);
    throw error;
  }
}

module.exports = {
  getAppointments,
  createAppointment,
  updateAppointment,
  getAppointmentById,
  linkAttendees,
  deleteAppointment
};