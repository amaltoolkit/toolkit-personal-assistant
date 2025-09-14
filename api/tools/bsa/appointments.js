/**
 * BSA Appointments Tools
 * Extracted from activitiesAgent.js for modular architecture
 */

const axios = require('axios');
const { normalizeBSAResponse } = require('./common');
const { parseDateQuery } = require('../../lib/chronoParser');
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
  
  // Convert date strings to ISO 8601 format with time
  // BSA expects full timestamps, not just dates
  const toISODateTime = (dateStr, isEndOfDay = false) => {
    if (!dateStr) return null;

    // If already has time component, return as-is
    if (dateStr.includes('T')) {
      return dateStr;
    }

    // Convert YYYY-MM-DD to full ISO format
    // For start of day: YYYY-MM-DDT00:00:00.000Z
    // For end of day: YYYY-MM-DDT23:59:59.999Z
    const date = new Date(dateStr + 'T00:00:00Z');
    if (isEndOfDay) {
      date.setUTCHours(23, 59, 59, 999);
    }
    return date.toISOString();
  };

  // Convert dates to ISO format
  if (effectiveFrom) {
    effectiveFrom = toISODateTime(effectiveFrom, false); // Start of day
  }
  if (effectiveTo) {
    effectiveTo = toISODateTime(effectiveTo, true); // End of day
  }

  // If only one date provided, use full day range
  if (effectiveFrom && !effectiveTo) {
    effectiveTo = effectiveFrom.replace('T00:00:00.000Z', 'T23:59:59.999Z');
  } else if (!effectiveFrom && effectiveTo) {
    effectiveFrom = effectiveTo.replace('T23:59:59.999Z', 'T00:00:00.000Z');
  }
  
  console.log("[BSA:APPOINTMENTS] Fetching with date range:", { effectiveFrom, effectiveTo });
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivities.json';
  const payload = {
    OrganizationId: orgId,  // Changed from orgId to OrganizationId
    PassKey: passKey,        // Added PassKey to payload
    ObjectName: "appointment", // Added ObjectName
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

  // Use the correct OrgData endpoint for creation
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json';
  const payload = {
    IncludeExtendedProperties: false,
    DataObject: {
      Subject: subject,
      StartTime: startTime,
      EndTime: endTime,
      Location: location || "",
      Description: description || "",
      AllDay: isAllDay,
      RollOver: false,
      Complete: false
    },
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "appointment"
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

    // Response contains DataObject, not Activity
    const appointment = normalized.DataObject;
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

  // Use the OrgData endpoint for updates
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/update.json';
  const payload = {
    IncludeExtendedProperties: false,
    DataObject: {
      ...existing,
      ...updates,
      Id: appointmentId
    },
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "appointment"
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

    // Response contains DataObject, not Activity
    return normalized.DataObject;
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
 * Link attendees to an appointment using the correct BSA linker pattern
 * @param {string} appointmentId - Appointment ID
 * @param {Array<string>} contactIds - Array of contact IDs
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Link result
 */
async function linkAttendees(appointmentId, contactIds, passKey, orgId) {
  console.log(`[BSA:APPOINTMENTS] Linking ${contactIds.length} attendees to appointment ${appointmentId}`);

  // Use the correct OrgData link endpoint
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/link.json';
  const linkerName = 'linker_appointments_contacts';

  // Track results for each contact
  const linkResults = [];
  const errors = [];

  // Link each contact individually (BSA link endpoint doesn't support batch)
  for (const contactId of contactIds) {
    const payload = {
      LeftObjectName: 'appointment',
      LeftId: appointmentId,
      ObjectName: linkerName,
      RightObjectName: 'contact',
      RightId: contactId,
      OrganizationId: orgId,
      PassKey: passKey
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
        errors.push({ contactId, error: normalized.error || 'Failed to link' });
        console.error(`[BSA:APPOINTMENTS] Failed to link contact ${contactId}`);
      } else {
        linkResults.push({ contactId, linked: true });
        console.log(`[BSA:APPOINTMENTS] Successfully linked contact ${contactId}`);
      }
    } catch (error) {
      console.error(`[BSA:APPOINTMENTS] Error linking contact ${contactId}:`, error.message);
      errors.push({ contactId, error: error.message });
    }
  }

  // Return summary of results
  const result = {
    linked: linkResults.length > 0,
    appointmentId,
    successful: linkResults,
    failed: errors,
    totalContacts: contactIds.length,
    successCount: linkResults.length,
    failureCount: errors.length
  };

  if (errors.length > 0) {
    console.warn(`[BSA:APPOINTMENTS] Linked ${linkResults.length}/${contactIds.length} contacts, ${errors.length} failed`);
  } else {
    console.log(`[BSA:APPOINTMENTS] Successfully linked all ${linkResults.length} attendees`);
  }

  return result;
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

  // Use the OrgData endpoint for deletion
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/delete.json';
  const payload = {
    DataObjectId: appointmentId,
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "appointment"
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