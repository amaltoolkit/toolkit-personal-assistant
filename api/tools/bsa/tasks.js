/**
 * BSA Tasks Tools
 * Extracted from activitiesAgent.js for modular architecture
 */

const axios = require('axios');
const { normalizeBSAResponse, buildBSAHeaders, formatBSADateTime } = require('./common');
const { parseDateQuery } = require('../../lib/dateParser');
const bsaConfig = require('../../config/bsa');

/**
 * Get tasks from BSA
 * @param {Object} params - Query parameters
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Tasks data
 */
async function getTasks(params, passKey, orgId) {
  const {
    startDate,
    endDate,
    dateQuery,
    includeCompleted = false,
    includeExtendedProperties = false,
    timeZone = 'UTC'
  } = params;
  
  // Handle natural language date queries
  let effectiveFrom = startDate;
  let effectiveTo = endDate;
  
  if (dateQuery && !startDate && !endDate) {
    const parsed = parseDateQuery(dateQuery, timeZone);
    if (parsed) {
      console.log("[BSA:TASKS] Parsed date query:", dateQuery, "=>", parsed);
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
  
  console.log("[BSA:TASKS] Fetching with date range:", { effectiveFrom, effectiveTo });
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivities.json';
  const payload = {
    OrganizationId: orgId,  // Changed from orgId to OrganizationId
    PassKey: passKey,        // Added PassKey to payload
    ObjectName: "task",      // Added ObjectName
    IncludeAppointments: false,
    IncludeTasks: true,
    From: effectiveFrom,
    To: effectiveTo,
    IncludeCompleted: includeCompleted,
    IncludeExtendedProperties: includeExtendedProperties
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Invalid BSA response');
    }
    
    // Filter out completed tasks if not requested
    let tasks = normalized.activities || [];
    if (!includeCompleted) {
      tasks = tasks.filter(task => task.StatusCode !== 'completed');
    }
    
    return {
      tasks,
      count: tasks.length
    };
  } catch (error) {
    console.error('[BSA:TASKS] Error fetching:', error.message);
    throw error;
  }
}

/**
 * Create a task in BSA
 * @param {Object} data - Task data
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Created task
 */
async function createTask(data, passKey, orgId) {
  const {
    subject,
    dueTime,
    description,
    priority = 'normal',
    contactId = null,
    reminder = null
  } = data;
  
  console.log("[BSA:TASKS] Creating task:", subject);
  
  // Format due time
  const formattedDueTime = dueTime ? formatBSADateTime(dueTime) : null;
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/updateActivity.json';
  const payload = {
    OrgId: orgId,
    Activity: {
      EntityName: "Activity",
      Subject: subject,
      Description: description || "",
      TypeCode: "task",
      Priority: priority,
      StatusCode: "notstarted",
      DueTime: formattedDueTime,
      // BSA uses DueTime for tasks instead of StartTime/EndTime
      StartTime: formattedDueTime, // Set same as DueTime for compatibility
      EndTime: formattedDueTime,
      ReminderMinutesBeforeStart: reminder
    }
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to create task');
    }
    
    const task = normalized.Activity;
    console.log("[BSA:TASKS] Created task ID:", task.Id);
    
    // Link contact if provided
    if (contactId && task.Id) {
      await linkToTask(task.Id, contactId, passKey, orgId);
    }
    
    return task;
  } catch (error) {
    console.error('[BSA:TASKS] Error creating:', error.message);
    throw error;
  }
}

/**
 * Update an existing task
 * @param {string} taskId - Task ID to update
 * @param {Object} updates - Fields to update
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Updated task
 */
async function updateTask(taskId, updates, passKey, orgId) {
  console.log("[BSA:TASKS] Updating task:", taskId);
  
  // First fetch the existing task
  const existing = await getTaskById(taskId, passKey, orgId);
  if (!existing) {
    throw new Error(`Task ${taskId} not found`);
  }
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/updateActivity.json';
  
  // Handle status updates
  if (updates.status) {
    const statusMap = {
      'completed': 'completed',
      'complete': 'completed',
      'done': 'completed',
      'in progress': 'inprogress',
      'started': 'inprogress',
      'not started': 'notstarted',
      'pending': 'notstarted',
      'cancelled': 'cancelled',
      'canceled': 'cancelled'
    };
    
    updates.StatusCode = statusMap[updates.status.toLowerCase()] || updates.status;
    delete updates.status;
  }
  
  // Handle due date updates
  if (updates.dueTime) {
    updates.DueTime = formatBSADateTime(updates.dueTime);
    updates.StartTime = updates.DueTime;
    updates.EndTime = updates.DueTime;
  }
  
  const payload = {
    OrgId: orgId,
    Activity: {
      ...existing,
      ...updates,
      Id: taskId,
      EntityName: "Activity",
      TypeCode: "task"
    }
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to update task');
    }
    
    return normalized.Activity;
  } catch (error) {
    console.error('[BSA:TASKS] Error updating:', error.message);
    throw error;
  }
}

/**
 * Get a single task by ID
 * @param {string} taskId - Task ID
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object|null>} Task or null if not found
 */
async function getTaskById(taskId, passKey, orgId) {
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivity.json';
  const payload = {
    OrgId: orgId,
    ActivityId: taskId
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      return null;
    }
    
    return normalized.Activity;
  } catch (error) {
    console.error('[BSA:TASKS] Error fetching by ID:', error.message);
    return null;
  }
}

/**
 * Link a contact to a task
 * @param {string} taskId - Task ID
 * @param {string} contactId - Contact ID to link
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Link result
 */
async function linkToTask(taskId, contactId, passKey, orgId) {
  console.log(`[BSA:TASKS] Linking contact ${contactId} to task ${taskId}`);
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/updateActivityLinks.json';
  const payload = {
    OrgId: orgId,
    Id: taskId,
    TypeCode: "task",
    LinkerName: "ActivityContactLinker",
    LinkedEntitySchemaName: "Contact",
    Action: 1, // Add link
    ItemIds: [contactId]
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to link contact to task');
    }
    
    console.log("[BSA:TASKS] Successfully linked contact");
    return { linked: true, taskId, contactId };
  } catch (error) {
    console.error('[BSA:TASKS] Error linking contact:', error.message);
    throw error;
  }
}

/**
 * Mark a task as complete
 * @param {string} taskId - Task ID to complete
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Updated task
 */
async function completeTask(taskId, passKey, orgId) {
  return updateTask(taskId, { StatusCode: 'completed' }, passKey, orgId);
}

/**
 * Delete a task
 * @param {string} taskId - Task ID to delete
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Deletion result
 */
async function deleteTask(taskId, passKey, orgId) {
  console.log("[BSA:TASKS] Deleting task:", taskId);
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/deleteActivity.json';
  const payload = {
    OrgId: orgId,
    ActivityId: taskId
  };
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to delete task');
    }
    
    console.log("[BSA:TASKS] Successfully deleted");
    return { deleted: true, taskId };
  } catch (error) {
    console.error('[BSA:TASKS] Error deleting:', error.message);
    throw error;
  }
}

module.exports = {
  getTasks,
  createTask,
  updateTask,
  getTaskById,
  linkToTask,
  completeTask,
  deleteTask
};