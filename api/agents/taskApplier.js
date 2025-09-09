/**
 * Task Applier Agent
 * 
 * Applies approved task specifications to BSA by creating tasks
 * using the VCOrgDataEndpoint/create.json endpoint
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
 * Create a task in BSA
 */
async function createTaskInBSA(taskSpec, bsaConfig) {
  const url = `${bsaConfig.BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;
  
  // Handle natural language date parsing if dateQuery is provided
  let dueTime = taskSpec.dueTime;
  let startTime = taskSpec.startTime;
  
  // Always prioritize dateQuery when present - it's the source of truth for natural language dates
  if (taskSpec.dateQuery && taskSpec.dateQuery !== null) {
    const userTimezone = bsaConfig.timezone || 'UTC';
    console.log(`[TASK:APPLY] Parsing natural language date: "${taskSpec.dateQuery}"`);
    
    // Extract just the date part by removing time patterns (e.g., "at 10 AM")
    const datePartOnly = taskSpec.dateQuery
      .replace(/\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)/gi, '')
      .trim();
    
    console.log(`[TASK:APPLY] Extracted date part: "${datePartOnly}"`);
    const parsed = parseDateQuery(datePartOnly, userTimezone);
    if (parsed) {
      console.log(`[TASK:APPLY] Parsed to: ${parsed.interpreted}`);
      
      // Check for keywords to determine if it's a due date or start date
      const dueKeywords = /\b(due|by|before|deadline|complete by|finish by)\b/i;
      const startKeywords = /\b(start|begin|starting)\b/i;
      
      // Parse the date IN the user's timezone (not as UTC then converted)
      const parsedDate = dayjs.tz(parsed.startDate, userTimezone);
      
      if (startKeywords.test(taskSpec.dateQuery)) {
        // It's a start date - set to beginning of business day (9 AM)
        startTime = parsedDate.hour(9).minute(0).second(0).toISOString();
        // Due date is end of same day by default
        dueTime = parsedDate.hour(17).minute(0).second(0).toISOString();
      } else {
        // Default or "due" keywords - treat as due date
        // Set due date to end of business day (5 PM)
        dueTime = parsedDate.hour(17).minute(0).second(0).toISOString();
        // Start time can be null or current time
        if (!startTime) {
          const now = dayjs().tz(userTimezone);
          startTime = now.toISOString();
        }
      }
    } else {
      // Parsing failed - fall back to provided time or error
      if (!dueTime) {
        throw new Error(`Could not parse date query: "${taskSpec.dateQuery}"`);
      }
    }
  }
  
  // Validate we have at least a due time
  if (!dueTime) {
    throw new Error("Task must have a dueTime");
  }
  
  // Convert TaskSpec to BSA format
  const payload = {
    PassKey: bsaConfig.passKey,
    OrganizationId: bsaConfig.orgId,
    ObjectName: "task",
    DataObject: {
      Subject: taskSpec.subject,
      Description: taskSpec.description || null,
      Status: taskSpec.status || "NotStarted",
      Priority: taskSpec.priority || "Normal",
      StartTime: startTime || null,
      DueTime: dueTime,
      PercentComplete: taskSpec.percentComplete || 0,
      Location: taskSpec.location || null,
      RollOver: taskSpec.rollOver || false
    },
    IncludeExtendedProperties: false
  };
  
  // Add linking fields if provided
  if (taskSpec.contactId) {
    payload.DataObject.ContactId = taskSpec.contactId;
  }
  if (taskSpec.accountId) {
    payload.DataObject.AccountId = taskSpec.accountId;
  }
  if (taskSpec.opportunityId) {
    payload.DataObject.OpportunityId = taskSpec.opportunityId;
  }
  
  // Handle assignee based on type
  // Note: BSA task assignment is typically handled through workflow rules
  // or post-creation assignment, but we'll include the pattern for reference
  if (taskSpec.assigneeType === "SpecificUser" && taskSpec.assigneeId) {
    payload.DataObject.AssignedToId = taskSpec.assigneeId;
  }
  // ContactsOwner and ContactsOwnersAssistant are typically handled by BSA rules
  
  console.log(`[TASK:APPLY] Creating task: ${taskSpec.subject}`);
  console.log(`[TASK:APPLY] Priority: ${payload.DataObject.Priority}, Due: ${dueTime}`);
  
  // Wrap the BSA call with deduplication (5 minute window)
  const result = await withDedupe(
    payload.DataObject, // Use the task data for deduplication
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
    console.log(`[TASK:APPLY] Skipped duplicate task creation: ${taskSpec.subject}`);
    throw new Error(`Duplicate task detected: ${taskSpec.subject}. This task was already created recently.`);
  }
  
  // BSA responses are wrapped in arrays
  const data = Array.isArray(result.data) ? result.data[0] : result.data;
  
  if (!data.Valid) {
    throw new Error(data.ResponseMessage || data.StackMessage || "Failed to create task");
  }
  
  const taskId = data.DataObject?.Id;
  if (!taskId) {
    throw new Error("Task created but no ID returned");
  }
  
  console.log(`[TASK:APPLY] Task created with ID: ${taskId}`);
  
  return {
    taskId,
    subject: data.DataObject.Subject,
    status: data.DataObject.Status,
    priority: data.DataObject.Priority,
    dueTime: data.DataObject.DueTime,
    createdOn: data.DataObject.CreatedOn,
    assignedTo: data.DataObject.AssignedTo || null
  };
}

/**
 * Apply the task to BSA
 */
async function applyTaskToBSA(spec, bsaConfig, config) {
  // Add timezone to bsaConfig for date parsing
  bsaConfig.timezone = config?.configurable?.user_tz || 'UTC';
  
  const results = {
    taskId: null,
    subject: null,
    errors: []
  };
  
  try {
    console.log(`[TASK:APPLY] Creating task: ${spec.subject}`);
    
    // Ensure dates are in ISO format
    const ensureISO = (dateStr) => {
      if (!dateStr) return null;
      try {
        // If it's already a valid ISO string, return as is
        if (dateStr.includes('T')) {
          return dateStr;
        }
        // Otherwise, assume it's a date and add time
        const date = new Date(dateStr);
        return date.toISOString();
      } catch (e) {
        console.warn(`[TASK:APPLY] Invalid date format: ${dateStr}`);
        return dateStr; // Return as is and let BSA handle validation
      }
    };
    
    // Prepare task spec with formatted dates
    const formattedSpec = {
      ...spec,
      dueTime: ensureISO(spec.dueTime),
      startTime: ensureISO(spec.startTime)
    };
    
    // Create the task with retry logic
    const taskResult = await withRetry(
      () => createTaskInBSA(formattedSpec, bsaConfig),
      2, // max retries
      1000 // delay between retries
    );
    
    results.taskId = taskResult.taskId;
    results.subject = taskResult.subject;
    results.status = taskResult.status;
    results.priority = taskResult.priority;
    results.dueTime = taskResult.dueTime;
    results.createdOn = taskResult.createdOn;
    results.assignedTo = taskResult.assignedTo;
    
    console.log(`[TASK:APPLY] Task creation complete: ${results.subject} (ID: ${results.taskId})`);
    
    return results;
    
  } catch (error) {
    console.error(`[TASK:APPLY] Critical error during task creation:`, error.message);
    results.errors.push({
      field: "creation",
      error: error.message
    });
    throw error;
  }
}

/**
 * Extract result data for artifacts
 */
function extractTaskResult(result) {
  return {
    taskId: result.taskId,
    subject: result.subject,
    status: result.status,
    priority: result.priority,
    dueTime: result.dueTime,
    createdOn: result.createdOn,
    assignedTo: result.assignedTo,
    errors: result.errors,
    summary: {
      created: !!result.taskId,
      hasErrors: result.errors.length > 0
    }
  };
}

/**
 * Main task applier function
 * Applies task specifications to BSA
 */
async function apply_create_task(state, config) {
  const applierConfig = {
    actionType: "create_task",
    applyFunction: applyTaskToBSA,
    extractResult: extractTaskResult
  };
  
  // Validate configuration
  validateApplierConfig(applierConfig);
  
  console.log("[TASK:APPLIER] Applying task to BSA...");
  
  try {
    // Use base applier to handle common patterns
    const result = await baseApplier(state, config, applierConfig);
    
    // Add task-specific logging
    if (result.artifacts?.create_task) {
      const task = result.artifacts.create_task;
      console.log(`[TASK:APPLIER] Task "${task.subject}" created`);
      console.log(`[TASK:APPLIER] Task ID: ${task.taskId}`);
      console.log(`[TASK:APPLIER] Due: ${task.dueTime}, Priority: ${task.priority}`);
      
      if (task.errors && task.errors.length > 0) {
        console.warn("[TASK:APPLIER] Some issues occurred:", task.errors);
      }
    }
    
    return result;
    
  } catch (error) {
    console.error("[TASK:APPLIER:ERROR]", error);
    throw error;
  }
}

/**
 * Standalone function to apply task (for testing)
 */
async function applyTask(spec, passKey, orgId, options = {}) {
  const state = {
    action: { id: `task_${Date.now()}` },
    previews: [{
      actionId: `task_${Date.now()}`,
      kind: "task",
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
  
  const result = await apply_create_task(state, config);
  return result.artifacts?.create_task;
}

module.exports = {
  apply_create_task,
  applyTask,
  createTaskInBSA,
  applyTaskToBSA,
  extractTaskResult
};