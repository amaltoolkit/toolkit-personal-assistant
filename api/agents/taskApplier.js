/**
 * Task Applier Agent
 * 
 * Applies approved task specifications to BSA by creating tasks
 * using the VCOrgDataEndpoint/create.json endpoint
 */

const { baseApplier, findPreviewForAction, responsePatterns, withRetry, validateApplierConfig } = require('./baseApplier');
const axios = require('axios');

/**
 * Create a task in BSA
 */
async function createTaskInBSA(taskSpec, bsaConfig) {
  const url = `${bsaConfig.BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;
  
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
      StartTime: taskSpec.startTime || null,
      DueTime: taskSpec.dueTime,
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
  console.log(`[TASK:APPLY] Priority: ${payload.DataObject.Priority}, Due: ${payload.DataObject.DueTime}`);
  
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000
  });
  
  // BSA responses are wrapped in arrays
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  
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