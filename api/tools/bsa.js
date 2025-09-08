// BSA Tools with dedupe wrapper for preventing duplicate API calls
// All tools use closures to access PassKey securely (never in prompts)

const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const axios = require("axios");
const { withDedupe } = require("../lib/dedupe");

const BSA_BASE = process.env.BSA_BASE || "https://rc.bluesquareapps.com";
const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Creates a function to make BSA API POST requests with dedupe
 * @param {string} passKey - BSA PassKey (via closure, never in params)
 * @returns {Function} Poster function that makes deduped API calls
 */
function makePoster(passKey) {
  if (!passKey) {
    throw new Error("[BSA:TOOLS] PassKey is required to create poster");
  }
  
  return async function poster(endpoint, payload) {
    // Never log the PassKey
    console.log(`[BSA:POST] Calling ${endpoint}`);
    console.log(`[BSA:POST] Payload keys:`, Object.keys(payload));
    
    // Wrap the API call with dedupe
    const result = await withDedupe(
      { endpoint, ...payload }, // Hash includes endpoint + payload
      DEDUPE_WINDOW_MS,
      async () => {
        try {
          const response = await axios.post(
            `${BSA_BASE}${endpoint}`,
            payload,
            {
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${passKey}` // PassKey from closure
              },
              timeout: 10000 // 10 second timeout
            }
          );
          
          // Normalize BSA response format
          if (Array.isArray(response.data) && response.data[0]) {
            const data = response.data[0];
            if (data.Valid === false) {
              throw new Error(data.Message || "BSA API returned invalid response");
            }
            return {
              success: true,
              data: data.Results || data
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
 * @param {string} passKey - BSA PassKey (via closure)
 * @returns {Array} Array of workflow tools
 */
function makeWorkflowTools(passKey) {
  const poster = makePoster(passKey);
  
  const createWorkflowShell = tool(
    async (input) => {
      console.log("[WORKFLOW:CREATE] Creating workflow shell");
      
      const payload = {
        Action: "CreateWorkflowShell",
        WorkflowName: input.name,
        WorkflowDesc: input.description || "",
        PerformImmediately: input.performImmediately || false
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.workflow.VCWorkflowEndpoint/CreateWorkflowShell.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        workflowId: result.data?.WorkflowID,
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
      console.log("[WORKFLOW:STEP] Adding workflow step");
      
      // Convert datetime to UTC if provided
      let startTimeUTC = null;
      if (input.startTime) {
        startTimeUTC = new Date(input.startTime).toISOString();
        console.log(`[WORKFLOW:STEP] Converted time to UTC: ${startTimeUTC}`);
      }
      
      const payload = {
        Action: "AddWorkflowStep",
        WorkflowID: input.workflowId,
        StepType: input.stepType,
        StepName: input.stepName,
        StepDesc: input.stepDescription || "",
        StartTime: startTimeUTC,
        AssignedTo: input.assignedTo || null,
        Duration: input.duration || null
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.workflow.VCWorkflowEndpoint/AddWorkflowStep.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        stepId: result.data?.StepID,
        message: result.skipped ? "Duplicate step addition prevented" : "Step added to workflow"
      });
    },
    {
      name: "addWorkflowStep",
      description: "Add a step to an existing workflow",
      schema: z.object({
        workflowId: z.string().describe("ID of the workflow"),
        stepType: z.string().describe("Type of step (e.g., 'Task', 'Approval', 'Email')"),
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
 * @param {string} passKey - BSA PassKey (via closure)
 * @returns {Array} Array of task tools
 */
function makeTaskTools(passKey) {
  const poster = makePoster(passKey);
  
  const createTask = tool(
    async (input) => {
      console.log("[TASK:CREATE] Creating task");
      
      // Convert dates to UTC
      const dueDateUTC = input.dueDate ? new Date(input.dueDate).toISOString() : null;
      
      const payload = {
        Action: "CreateTask",
        TaskName: input.name,
        TaskDesc: input.description || "",
        DueDate: dueDateUTC,
        AssignedTo: input.assignedTo || null,
        Priority: input.priority || "Normal",
        Status: input.status || "Pending"
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.task.VCTaskEndpoint/CreateTask.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        taskId: result.data?.TaskID,
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
        priority: z.enum(["Low", "Normal", "High", "Urgent"]).optional(),
        status: z.enum(["Pending", "InProgress", "Completed", "Cancelled"]).optional()
      })
    }
  );
  
  const updateTask = tool(
    async (input) => {
      console.log("[TASK:UPDATE] Updating task");
      
      // Convert dates to UTC if provided
      const dueDateUTC = input.dueDate ? new Date(input.dueDate).toISOString() : undefined;
      
      const payload = {
        Action: "UpdateTask",
        TaskID: input.taskId,
        ...(input.name && { TaskName: input.name }),
        ...(input.description !== undefined && { TaskDesc: input.description }),
        ...(dueDateUTC && { DueDate: dueDateUTC }),
        ...(input.assignedTo !== undefined && { AssignedTo: input.assignedTo }),
        ...(input.priority && { Priority: input.priority }),
        ...(input.status && { Status: input.status })
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.task.VCTaskEndpoint/UpdateTask.json",
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
        priority: z.enum(["Low", "Normal", "High", "Urgent"]).optional(),
        status: z.enum(["Pending", "InProgress", "Completed", "Cancelled"]).optional()
      })
    }
  );
  
  return [createTask, updateTask];
}

/**
 * Creates appointment-related tools
 * @param {string} passKey - BSA PassKey (via closure)
 * @returns {Array} Array of appointment tools
 */
function makeAppointmentTools(passKey) {
  const poster = makePoster(passKey);
  
  const createAppointment = tool(
    async (input) => {
      console.log("[APPOINTMENT:CREATE] Creating appointment");
      
      // Convert all times to UTC
      const startTimeUTC = new Date(input.startTime).toISOString();
      const endTimeUTC = new Date(input.endTime).toISOString();
      
      console.log(`[APPOINTMENT:CREATE] Times in UTC: ${startTimeUTC} to ${endTimeUTC}`);
      
      const payload = {
        Action: "CreateAppointment",
        Title: input.title,
        Description: input.description || "",
        StartTime: startTimeUTC,
        EndTime: endTimeUTC,
        Location: input.location || "",
        Attendees: input.attendees || [],
        IsAllDay: input.isAllDay || false,
        ReminderMinutes: input.reminderMinutes || 15
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/CreateAppointment.json",
        payload
      );
      
      return JSON.stringify({
        success: result.success,
        appointmentId: result.data?.AppointmentID,
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
      
      // Convert times to UTC if provided
      const startTimeUTC = input.startTime ? new Date(input.startTime).toISOString() : undefined;
      const endTimeUTC = input.endTime ? new Date(input.endTime).toISOString() : undefined;
      
      const payload = {
        Action: "UpdateAppointment",
        AppointmentID: input.appointmentId,
        ...(input.title && { Title: input.title }),
        ...(input.description !== undefined && { Description: input.description }),
        ...(startTimeUTC && { StartTime: startTimeUTC }),
        ...(endTimeUTC && { EndTime: endTimeUTC }),
        ...(input.location !== undefined && { Location: input.location }),
        ...(input.attendees && { Attendees: input.attendees }),
        ...(input.isAllDay !== undefined && { IsAllDay: input.isAllDay }),
        ...(input.reminderMinutes !== undefined && { ReminderMinutes: input.reminderMinutes })
      };
      
      const result = await poster(
        "/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/UpdateAppointment.json",
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
 * Creates all BSA tools with the given PassKey
 * @param {string} passKey - BSA PassKey (secure via closure)
 * @returns {Object} Object containing all tool arrays
 */
function createBSATools(passKey) {
  if (!passKey) {
    throw new Error("[BSA:TOOLS] PassKey is required to create tools");
  }
  
  console.log("[BSA:TOOLS] Creating BSA tools with dedupe wrapper");
  console.log("[BSA:TOOLS] Dedupe window: 5 minutes");
  console.log("[BSA:TOOLS] PassKey present: true (not logging value)");
  
  return {
    workflowTools: makeWorkflowTools(passKey),
    taskTools: makeTaskTools(passKey),
    appointmentTools: makeAppointmentTools(passKey)
  };
}

module.exports = {
  createBSATools,
  makePoster,
  makeWorkflowTools,
  makeTaskTools,
  makeAppointmentTools
};