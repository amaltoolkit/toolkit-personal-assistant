// BSA Tools with dedupe wrapper for preventing duplicate API calls
// All tools use closures to access PassKey securely (never in prompts)

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const axios = require("axios");
const { withDedupe } = require("../lib/dedupe");
const bsaConfig = require('../config/bsa');

const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Creates a function to make BSA API POST requests with dedupe
 * @param {string} passKey - BSA PassKey (added to payload)
 * @param {string} orgId - Organization ID (required for all BSA calls)
 * @returns {Function} Poster function that makes deduped API calls
 */
function makePoster(passKey, orgId) {
  if (!passKey) {
    throw new Error("[BSA:TOOLS] PassKey is required to create poster");
  }
  if (!orgId) {
    throw new Error("[BSA:TOOLS] Organization ID is required to create poster");
  }
  
  return async function poster(endpoint, payload) {
    // Add PassKey and OrgId to payload (BSA standard)
    const fullPayload = {
      PassKey: passKey,
      OrganizationId: orgId,
      ...payload
    };
    
    // Never log the PassKey
    console.log(`[BSA:POST] Calling ${endpoint}`);
    console.log(`[BSA:POST] Payload keys:`, Object.keys(payload));
    
    // Wrap the API call with dedupe (exclude PassKey from hash)
    const dedupePayload = { ...payload }; // Don't include PassKey in dedupe hash
    const result = await withDedupe(
      { endpoint, ...dedupePayload },
      DEDUPE_WINDOW_MS,
      async () => {
        try {
          const response = await axios.post(
            bsaConfig.buildEndpoint(endpoint),
            fullPayload,
            {
              headers: {
                "Content-Type": "application/json"
                // No Authorization header - PassKey is in body
              },
              timeout: 10000 // 10 second timeout
            }
          );
          
          // Normalize BSA response format
          if (Array.isArray(response.data) && response.data[0]) {
            const data = response.data[0];
            if (data.Valid === false) {
              throw new Error(data.ResponseMessage || data.StackMessage || "BSA API returned invalid response");
            }
            return {
              success: true,
              data: data.DataObject || data.Results || data
            };
          }
          
          return {
            success: true,
            data: response.data
          };
          
        } catch (error) {
          console.error(`[BSA:POST] Error calling ${endpoint}:`, error.message);
          throw error;
        }
      }
    );
    
    if (result.skipped) {
      console.log(`[BSA:POST] Skipped duplicate call to ${endpoint}`);
    }
    
    return result;
  };
}

/**
 * Creates workflow-related tools
 * @param {string} passKey - BSA PassKey
 * @param {string} orgId - Organization ID
 * @returns {Array} Array of workflow tools
 */
function makeWorkflowTools(passKey, orgId) {
  const poster = makePoster(passKey, orgId);
  
  const createWorkflowShell = tool(
    async (input) => {
      console.log("[WORKFLOW:CREATE] Creating advocate_process shell");
      
      const payload = {
        ObjectName: "advocate_process",
        DataObject: {
          Name: input.name,
          Description: input.description || ""
        },
        IncludeExtendedProperties: false
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        workflowId: result.data?.Id,
        message: result.skipped ? "Duplicate workflow creation prevented" : "Workflow created"
      });
    },
    {
      name: "createWorkflowShell",
      description: "Create a new empty workflow in BSA",
      schema: z.object({
        name: z.string().describe("Name of the workflow"),
        description: z.string().optional().describe("Description of the workflow"),
        performImmediately: z.boolean().optional().describe("Execute workflow immediately after creation")
      })
    }
  );
  
  const addWorkflowStep = tool(
    async (input) => {
      console.log("[WORKFLOW:STEP] Adding advocate_process_template step");
      
      // Generate default times for the step (9 AM - 10 AM in UTC)
      const now = new Date();
      const startTime = input.startTime ? new Date(input.startTime) : 
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
      const endTime = input.endTime ? new Date(input.endTime) :
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0));
      
      const payload = {
        ObjectName: "advocate_process_template",
        DataObject: {
          AdvocateProcessId: input.workflowId,
          Subject: input.stepName,
          Description: input.stepDescription || "",
          ActivityType: input.activityType || "Task",
          Sequence: input.sequence || 1,
          DayOffset: input.dayOffset || 1,
          StartTime: startTime.toISOString(),
          EndTime: endTime.toISOString(),
          AllDay: input.activityType !== "Appointment",
          AssigneeType: input.assigneeType || "ContactsOwner",
          AssigneeId: input.assignedTo || null,
          RollOver: input.rollOver !== false
        },
        IncludeExtendedProperties: false
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        stepId: result.data?.Id,
        message: result.skipped ? "Duplicate step addition prevented" : "Step added to workflow"
      });
    },
    {
      name: "addWorkflowStep",
      description: "Add a step to an existing workflow",
      schema: z.object({
        workflowId: z.string().describe("ID of the workflow"),
        activityType: z.enum(["Task", "Appointment"]).optional().describe("Type of activity (default: Task)"),
        sequence: z.number().optional().describe("Order number of this step (default: 1)"),
        dayOffset: z.number().optional().describe("Days allocated for this step (default: 1)"),
        assigneeType: z.enum(["ContactsOwner", "ContactsOwnersAssistant"]).optional().describe("Who should do this step"),
        rollOver: z.boolean().optional().describe("Should incomplete steps move to next day (default: true)"),
        stepName: z.string().describe("Name of the step"),
        stepDescription: z.string().optional().describe("Description of the step"),
        startTime: z.string().optional().describe("ISO datetime when step should start"),
        assignedTo: z.string().optional().describe("User ID to assign step to"),
        duration: z.number().optional().describe("Duration in minutes")
      })
    }
  );
  
  return [createWorkflowShell, addWorkflowStep];
}

/**
 * Creates task-related tools
 * @param {string} passKey - BSA PassKey
 * @param {string} orgId - Organization ID
 * @returns {Array} Array of task tools
 */
function makeTaskTools(passKey, orgId) {
  const poster = makePoster(passKey, orgId);
  
  const createTask = tool(
    async (input) => {
      console.log("[TASK:CREATE] Creating task");
      
      // Convert dates to UTC
      const dueTimeUTC = input.dueDate ? new Date(input.dueDate).toISOString() : null;
      const startTimeUTC = input.startDate ? new Date(input.startDate).toISOString() : null;
      
      const payload = {
        ObjectName: "task",
        DataObject: {
          Subject: input.name,
          Description: input.description || null,
          Status: input.status || "NotStarted",
          Priority: input.priority || "Normal",
          StartTime: startTimeUTC,
          DueTime: dueTimeUTC,
          PercentComplete: input.percentComplete || 0,
          Location: input.location || null,
          RollOver: input.rollOver || false
        },
        IncludeExtendedProperties: false
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        taskId: result.data?.Id,
        message: result.skipped ? "Duplicate task creation prevented" : "Task created"
      });
    },
    {
      name: "createTask",
      description: "Create a new task in BSA",
      schema: z.object({
        name: z.string().describe("Name of the task"),
        description: z.string().optional().describe("Description of the task"),
        dueDate: z.string().optional().describe("ISO datetime when task is due"),
        assignedTo: z.string().optional().describe("User ID to assign task to"),
        priority: z.enum(["Low", "Normal", "High"]).optional().describe("Task priority (default: Normal)"),
        status: z.enum(["NotStarted", "InProgress", "Completed", "WaitingOnSomeoneElse", "Deferred"]).optional().describe("Task status (default: NotStarted)"),
        startDate: z.string().optional().describe("ISO datetime when task starts"),
        percentComplete: z.number().min(0).max(100).optional().describe("Completion percentage 0-100"),
        location: z.string().optional().describe("Task location"),
        rollOver: z.boolean().optional().describe("Auto-rollover incomplete tasks")
      })
    }
  );
  
  const updateTask = tool(
    async (input) => {
      console.log("[TASK:UPDATE] Updating task");
      
      // Note: BSA update requires get first, then update full object
      // This is simplified - real implementation would need to fetch first
      const payload = {
        ObjectName: "task",
        ObjectId: input.taskId,
        DataObject: {
          ...(input.name && { Subject: input.name }),
          ...(input.description !== undefined && { Description: input.description }),
          ...(input.dueDate && { DueTime: new Date(input.dueDate).toISOString() }),
          ...(input.startDate && { StartTime: new Date(input.startDate).toISOString() }),
          ...(input.priority && { Priority: input.priority }),
          ...(input.status && { Status: input.status }),
          ...(input.percentComplete !== undefined && { PercentComplete: input.percentComplete }),
          ...(input.location !== undefined && { Location: input.location }),
          ...(input.rollOver !== undefined && { RollOver: input.rollOver })
        },
        IncludeExtendedProperties: false
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/update.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        message: result.skipped ? "Duplicate task update prevented" : "Task updated"
      });
    },
    {
      name: "updateTask",
      description: "Update an existing task in BSA",
      schema: z.object({
        taskId: z.string().describe("ID of the task to update"),
        name: z.string().optional().describe("New name for the task"),
        description: z.string().optional().describe("New description"),
        dueDate: z.string().optional().describe("New ISO datetime when task is due"),
        assignedTo: z.string().optional().describe("New user ID to assign to"),
        priority: z.enum(["Low", "Normal", "High"]).optional(),
        status: z.enum(["NotStarted", "InProgress", "Completed", "WaitingOnSomeoneElse", "Deferred"]).optional(),
        startDate: z.string().optional().describe("New ISO datetime when task starts"),
        percentComplete: z.number().min(0).max(100).optional().describe("New completion percentage"),
        location: z.string().optional().describe("New task location"),
        rollOver: z.boolean().optional().describe("Change auto-rollover setting")
      })
    }
  );
  
  return [createTask, updateTask];
}

/**
 * Creates appointment-related tools
 * @param {string} passKey - BSA PassKey
 * @param {string} orgId - Organization ID
 * @returns {Array} Array of appointment tools
 */
function makeAppointmentTools(passKey, orgId) {
  const poster = makePoster(passKey, orgId);
  
  const createAppointment = tool(
    async (input) => {
      console.log("[APPOINTMENT:CREATE] Creating appointment");
      
      // Convert all times to UTC
      const startTimeUTC = new Date(input.startTime).toISOString();
      const endTimeUTC = new Date(input.endTime).toISOString();
      
      console.log(`[APPOINTMENT:CREATE] Times in UTC: ${startTimeUTC} to ${endTimeUTC}`);
      
      const payload = {
        ObjectName: "appointment",
        DataObject: {
          Subject: input.title,
          Description: input.description || null,
          StartTime: startTimeUTC,
          EndTime: endTimeUTC,
          Location: input.location || null,
          AllDay: input.isAllDay || false,
          Complete: false,
          AppointmentTypeId: null
        },
        IncludeExtendedProperties: false
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        appointmentId: result.data?.Id,
        message: result.skipped ? "Duplicate appointment prevented" : "Appointment created"
      });
    },
    {
      name: "createAppointment",
      description: "Create a new appointment/calendar event in BSA",
      schema: z.object({
        title: z.string().describe("Title of the appointment"),
        description: z.string().optional().describe("Description of the appointment"),
        startTime: z.string().describe("ISO datetime when appointment starts"),
        endTime: z.string().describe("ISO datetime when appointment ends"),
        location: z.string().optional().describe("Location of the appointment"),
        attendees: z.array(z.string()).optional().describe("Array of user IDs to invite"),
        isAllDay: z.boolean().optional().describe("Is this an all-day event"),
        reminderMinutes: z.number().optional().describe("Minutes before to send reminder")
      })
    }
  );
  
  const updateAppointment = tool(
    async (input) => {
      console.log("[APPOINTMENT:UPDATE] Updating appointment");
      
      // Note: BSA update requires get first, then update full object
      // This is simplified - real implementation would need to fetch first
      const payload = {
        ObjectName: "appointment",
        ObjectId: input.appointmentId,
        DataObject: {
          ...(input.title && { Subject: input.title }),
          ...(input.description !== undefined && { Description: input.description }),
          ...(input.startTime && { StartTime: new Date(input.startTime).toISOString() }),
          ...(input.endTime && { EndTime: new Date(input.endTime).toISOString() }),
          ...(input.location !== undefined && { Location: input.location }),
          ...(input.isAllDay !== undefined && { AllDay: input.isAllDay })
        },
        IncludeExtendedProperties: false
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/update.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        message: result.skipped ? "Duplicate appointment update prevented" : "Appointment updated"
      });
    },
    {
      name: "updateAppointment",
      description: "Update an existing appointment in BSA",
      schema: z.object({
        appointmentId: z.string().describe("ID of the appointment to update"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        startTime: z.string().optional().describe("New ISO datetime when appointment starts"),
        endTime: z.string().optional().describe("New ISO datetime when appointment ends"),
        location: z.string().optional().describe("New location"),
        attendees: z.array(z.string()).optional().describe("New array of user IDs"),
        isAllDay: z.boolean().optional().describe("Change all-day status"),
        reminderMinutes: z.number().optional().describe("New reminder time in minutes")
      })
    }
  );
  
  return [createAppointment, updateAppointment];
}

/**
 * Creates all BSA tools with the given PassKey and OrgId
 * @param {string} passKey - BSA PassKey
 * @param {string} orgId - Organization ID
 * @returns {Object} Object containing all tool arrays
 */
function createBSATools(passKey, orgId) {
  if (!passKey) {
    throw new Error("[BSA:TOOLS] PassKey is required to create tools");
  }
  if (!orgId) {
    throw new Error("[BSA:TOOLS] Organization ID is required to create tools");
  }
  
  console.log("[BSA:TOOLS] Creating BSA tools with dedupe wrapper");
  console.log("[BSA:TOOLS] Dedupe window: 5 minutes");
  console.log("[BSA:TOOLS] PassKey present: true (not logging value)");
  console.log("[BSA:TOOLS] OrgId:", orgId);
  
  return {
    workflowTools: makeWorkflowTools(passKey, orgId),
    taskTools: makeTaskTools(passKey, orgId),
    appointmentTools: makeAppointmentTools(passKey, orgId)
  };
}

module.exports = {
  createBSATools,
  makePoster,
  makeWorkflowTools,
  makeTaskTools,
  makeAppointmentTools
};