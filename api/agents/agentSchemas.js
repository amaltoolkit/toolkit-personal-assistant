/**
 * Agent Schemas - Zod schemas for all designer/applier agents
 * 
 * Defines structured output schemas for:
 * - Workflow creation
 * - Task management
 * - Appointment scheduling
 */

const { z } = require("zod");

/**
 * Workflow Schema - For creating advocate processes
 * Maps to BSA advocate_process and advocate_process_template objects
 */
const WorkflowSpec = z.object({
  name: z.string().min(3).max(100).describe("Name of the advocate process"),
  description: z.string().optional().describe("Description of the process purpose"),
  steps: z.array(z.object({
    subject: z.string().min(3).max(200).describe("Brief title for the step"),
    description: z.string().optional().describe("Detailed description of what needs to be done"),
    sequence: z.number().int().min(1).describe("Order number of this step in the process (1, 2, 3, etc.)"),
    activityType: z.enum(["Task", "Appointment"]).default("Task").describe("Either Task or Appointment"),
    dayOffset: z.number().int().min(0).default(1).describe("Number of days allocated for completing this step"),
    
    // Time-related fields (for appointments or scheduled tasks)
    startTime: z.string().nullable().optional().describe("ISO 8601 datetime for start time"),
    endTime: z.string().nullable().optional().describe("ISO 8601 datetime for end time"),
    allDay: z.boolean().default(true).describe("Whether this is an all-day activity"),
    
    // Assignment fields - specific to advocate_process
    assigneeType: z.enum(["ContactsOwner", "ContactsOwnersAssistant"]).default("ContactsOwner")
      .describe("ContactsOwner assigns to advisor, ContactsOwnersAssistant to assistant"),
    assigneeId: z.string().nullable().optional().describe("Specific user ID (null uses assigneeType logic)"),
    
    // Additional settings
    rollOver: z.boolean().default(true).describe("If true, uncompleted steps auto-move to next day"),
    location: z.string().nullable().optional().describe("Physical location for appointments"),
    appointmentTypeId: z.string().nullable().optional().describe("ID for specific appointment type")
  })).min(1).max(20).describe("Steps in the workflow (minimum 1, maximum 20)")
});

/**
 * Task Schema - For creating individual tasks
 * Aligned with BSA task API structure
 */
const TaskSpec = z.object({
  subject: z.string().min(3).max(200).describe("Subject/title of the task"),
  description: z.string().optional().describe("Detailed description of the task"),
  
  // Timing - Using BSA field names
  dueTime: z.string().describe("Due date/time in ISO format"),
  startTime: z.string().nullable().optional().describe("Start date/time in ISO format"),
  
  // Priority and status - BSA supported values only
  priority: z.enum(["Low", "Normal", "High"]).default("Normal").describe("Task priority"),
  status: z.enum(["NotStarted", "InProgress", "Completed", "WaitingOnSomeoneElse", "Deferred"])
    .default("NotStarted").describe("Task status"),
  percentComplete: z.number().min(0).max(100).default(0).describe("Completion percentage"),
  
  // Assignment - Similar to workflow pattern
  assigneeType: z.enum(["ContactsOwner", "ContactsOwnersAssistant", "SpecificUser"])
    .default("ContactsOwner").describe("Who should be assigned the task"),
  assigneeId: z.string().nullable().optional().describe("Specific user ID if assigneeType is SpecificUser"),
  
  // BSA specific fields
  location: z.string().nullable().optional().describe("Location for the task"),
  rollOver: z.boolean().default(false).describe("Auto-rollover incomplete tasks to next day"),
  
  // Linking to BSA entities
  contactId: z.string().nullable().optional().describe("Associated contact ID"),
  accountId: z.string().nullable().optional().describe("Associated account ID"),
  opportunityId: z.string().nullable().optional().describe("Associated opportunity ID"),
  
  // Categories for organization
  category: z.string().nullable().optional().describe("Task category (e.g., 'Follow-up', 'Administrative', 'Compliance')")
});

/**
 * Appointment Schema - For creating appointments/meetings
 * Aligned with BSA appointment API structure
 */
const AppointmentSpec = z.object({
  subject: z.string().min(3).max(200).describe("Subject/title of the appointment"),
  description: z.string().optional().describe("Detailed description or agenda"),
  
  // Time fields - Using BSA field names
  startTime: z.string().describe("Start date/time in ISO format"),
  endTime: z.string().describe("End date/time in ISO format"),
  allDay: z.boolean().default(false).describe("Is this an all-day event?"),
  
  // Location
  location: z.string().nullable().optional().describe("Meeting location, address, or video link"),
  locationType: z.enum(["Physical", "Virtual", "Phone"]).default("Physical")
    .describe("Type of meeting location"),
  
  // Attendees - Simplified to match BSA supported types
  attendees: z.array(z.object({
    type: z.enum(["Contact", "Company", "User"]).describe("Type of BSA entity"),
    id: z.string().describe("BSA ID of the attendee"),
    role: z.enum(["Organizer", "Required", "Optional"]).default("Required")
      .describe("Attendee's role in the meeting")
  })).optional().default([]).describe("List of meeting attendees"),
  
  // Meeting categorization
  appointmentTypeId: z.string().nullable().optional()
    .describe("BSA appointment type ID for categorization"),
  appointmentCategory: z.enum([
    "ClientMeeting",
    "InternalMeeting", 
    "PhoneCall",
    "VideoConference",
    "SiteVisit",
    "Other"
  ]).default("ClientMeeting").describe("Category of appointment for context"),
  
  // Status - BSA doesn't use status on create, but useful for designer
  complete: z.boolean().default(false).describe("Is the appointment completed?"),
  
  // Linking to BSA entities
  contactId: z.string().nullable().optional().describe("Primary contact for this appointment"),
  accountId: z.string().nullable().optional().describe("Associated account"),
  opportunityId: z.string().nullable().optional().describe("Associated opportunity")
});

/**
 * Memory Batch Schema - For memory synthesis
 */
const MemoryBatch = z.object({
  memories: z.array(z.object({
    kind: z.enum(["user_pref", "team_info", "client_note", "fact"]).describe("Type of memory"),
    text: z.string().min(8).max(500).describe("The memory text to store"),
    subjectId: z.string().nullable().optional().describe("ID of related entity (contact, account, etc.)"),
    importance: z.number().min(1).max(5).default(3).describe("Importance level (1-5)"),
    ttlDays: z.number().min(1).max(365).nullable().optional().describe("Time to live in days")
  })).max(5).describe("Extracted memories (max 5 per batch)")
});

/**
 * Common field schemas for reuse
 */
const CommonFields = {
  // Date/time validation helpers
  isoDateTime: z.string().refine(
    (val) => !isNaN(Date.parse(val)),
    { message: "Invalid ISO date/time format" }
  ),
  
  // BSA ID format (typically UUID)
  bsaId: z.string().uuid().nullable().optional(),
  
  // Percentage validation
  percentage: z.number().min(0).max(100),
  
  // Priority levels used across BSA
  priority: z.enum(["Low", "Normal", "High", "Urgent"]),
  
  // Common status values
  status: z.enum(["Active", "Inactive", "Pending", "Completed", "Cancelled"])
};

/**
 * Validation helpers
 */
const SchemaValidators = {
  /**
   * Validate workflow spec
   */
  validateWorkflow: (data) => {
    return WorkflowSpec.safeParse(data);
  },
  
  /**
   * Validate task spec
   */
  validateTask: (data) => {
    return TaskSpec.safeParse(data);
  },
  
  /**
   * Validate appointment spec
   */
  validateAppointment: (data) => {
    return AppointmentSpec.safeParse(data);
  },
  
  /**
   * Validate memory batch
   */
  validateMemoryBatch: (data) => {
    return MemoryBatch.safeParse(data);
  }
};

module.exports = {
  // Main schemas
  WorkflowSpec,
  TaskSpec,
  AppointmentSpec,
  MemoryBatch,
  
  // Common fields for reuse
  CommonFields,
  
  // Validators
  SchemaValidators
};