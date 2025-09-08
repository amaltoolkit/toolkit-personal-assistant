/**
 * Appointment Designer Agent
 * 
 * Designs calendar appointments based on user requests.
 * Generates financial advisor-focused meeting specifications.
 */

const { baseDesigner, promptPatterns, validateDesignerConfig } = require('./baseDesigner');
const { AppointmentSpec } = require('./agentSchemas');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

// Load dayjs plugins for timezone support
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Prompt template for appointment generation
 */
function generateAppointmentPrompt(params) {
  const { userMessage, userContext, memoryContext } = params;
  
  return `You are an appointment scheduling specialist for financial advisors. Create a well-structured appointment based on the user's request.

${promptPatterns.getUserContext(userContext)}
${promptPatterns.getMemoryContext(memoryContext)}

IMPORTANT - Current Date and Time Context:
- Current Date/Time: ${userContext.currentDateTime}
- User Timezone: ${userContext.timezone}
- Business Hours: ${userContext.businessHoursStart} to ${userContext.businessHoursEnd}

User Request: ${userMessage}

IMPORTANT DATE/TIME HANDLING:
- If the user specifies a natural language date/time (like "next Monday at 8 AM" or "tomorrow at 2pm"), 
  set the dateQuery field with the exact phrase and leave startTime/endTime empty.
- If the user provides specific dates/times in ISO format, use startTime and endTime fields.
- When using dateQuery, also set duration (in minutes) if the user specifies a duration.
- Default duration is 60 minutes if not specified.
- The system will automatically parse natural language dates based on the current date shown above.

Create a professional appointment with the following requirements:

1. Subject Guidelines:
   - Clear, professional meeting title
   - Include client/participant names when known
   - Specify meeting type (e.g., "Quarterly Portfolio Review - Smith Family")
   - Keep concise but informative

2. Time Scheduling:
   - ALWAYS use dates relative to the Current Date/Time shown above
   - Default to the provided Default Start/End Times if user doesn't specify
   - Business hours: 9:00 AM - 5:00 PM (unless specified otherwise)
   - Standard durations:
     * Initial consultations: 90 minutes
     * Portfolio reviews: 60 minutes
     * Quick check-ins: 30 minutes
     * Team meetings: 45-60 minutes
     * Compliance reviews: 60-90 minutes
   - Buffer time: Allow 15 minutes between appointments
   - Avoid scheduling during typical lunch hours (12-1 PM) unless necessary

3. Location Handling:
   - Physical meetings: Include full address
   - Virtual meetings: Include video link (e.g., "Zoom: [link]" or "Teams: [link]")
   - Phone calls: Include dial-in number
   - Set locationType appropriately

4. Meeting Duration Guidelines:
   - Quick check-ins: 30 minutes
   - Standard meetings: 60 minutes (default)
   - Portfolio reviews: 60-90 minutes
   - Annual reviews: 90-120 minutes
   - Training sessions: 120+ minutes
   - First-time consultations: 90 minutes

5. Common Appointment Patterns:
   - "Annual review" - 90 min, in-person preferred
   - "Quarterly portfolio review" - 60 min, Physical location
   - "Team planning meeting" - 60 min, conference room
   - "New client consultation" - 90 min, office meeting
   - "Compliance training" - 120 min, Virtual option
   - "Quick call" - 30 min, Phone or virtual

6. Description Content:
   - Meeting agenda or key discussion points
   - Preparation requirements
   - Documents to bring/review
   - Special instructions
   - Follow-up items from previous meetings

7. Best Practices:
   - Morning meetings (9-11 AM) for important decisions
   - Afternoon slots (2-4 PM) for routine reviews
   - Virtual meetings for quick updates
   - In-person for significant discussions
   - Allow extra time for first-time client meetings
   - Schedule prep time before important presentations

8. Special Considerations:
   - All-day events: Set allDay=true for conferences, training days
   - Back-to-back meetings: Avoid when possible, add buffer time
   - Time zones: Ensure clarity for remote participants
   - Recurring meetings: Note pattern in description (actual recurrence handled separately)

${promptPatterns.getQualityInstructions()}

FINAL REMINDER: The current date is ${userContext.currentDateTime}. Generate appointments with dates that are in the future relative to this date. If the user says "tomorrow", add 1 day to the current date. If they say "next week", calculate dates accordingly from the current date shown above.

Generate an appointment that is professional, well-organized, and follows financial advisory best practices.`;
}

/**
 * Extract parameters from state for the designer
 */
function extractAppointmentParams(state, config) {
  const userMessage = state.messages?.at(-1)?.content || "";
  
  // Look for memory context in state
  const memoryContext = state.messages?.find(m => 
    m.role === "system" && m.content?.includes("Relevant context:")
  );
  
  // Get user's timezone
  const userTimezone = config?.configurable?.user_tz || "UTC";
  
  // Get current time in user's timezone
  const now = dayjs().tz(userTimezone);
  
  return {
    userMessage, // Pass full message without extracting dates
    userContext: {
      ...config,
      currentDateTime: now.toISOString(),
      businessHoursStart: "09:00",
      businessHoursEnd: "17:00",
      timezone: userTimezone
    },
    memoryContext: memoryContext || state
  };
}

/**
 * Main appointment designer function
 * Creates appointment specifications for BSA
 */
async function design_create_appointment(state, config) {
  const designerConfig = {
    schema: AppointmentSpec,
    promptTemplate: generateAppointmentPrompt,
    previewType: "appointment",
    extractParams: extractAppointmentParams,
    model: "gpt-4o-mini",
    temperature: 0.2  // Low temperature for consistent scheduling
  };
  
  // Validate configuration
  validateDesignerConfig(designerConfig);
  
  console.log("[APPOINTMENT:DESIGNER] Generating appointment specification...");
  
  try {
    // Use base designer to generate the appointment spec
    const result = await baseDesigner(state, config, designerConfig);
    
    // Add additional metadata and validation
    if (result.previews && result.previews[0]) {
      const preview = result.previews[0];
      
      // Log appointment summary
      if (preview.spec) {
        console.log(`[APPOINTMENT:DESIGNER] Generated appointment: "${preview.spec.subject}"`);
        
        if (preview.spec.dateQuery) {
          console.log(`[APPOINTMENT:DESIGNER] Natural language date: "${preview.spec.dateQuery}"`);
          if (preview.spec.duration) {
            console.log(`[APPOINTMENT:DESIGNER] Duration: ${preview.spec.duration} minutes`);
          }
        } else if (preview.spec.startTime && preview.spec.endTime) {
          console.log(`[APPOINTMENT:DESIGNER] Time: ${preview.spec.startTime} to ${preview.spec.endTime}`);
        }
        
        console.log(`[APPOINTMENT:DESIGNER] Location: ${preview.spec.location || "Not specified"} (${preview.spec.locationType || "TBD"})`);
        
        // Add appointment metadata
        preview.metadata = {
          type: "appointment",
          hasDateQuery: !!preview.spec.dateQuery,
          hasExactTimes: !!(preview.spec.startTime && preview.spec.endTime),
          locationType: preview.spec.locationType,
          hasLocation: !!preview.spec.location,
          isAllDay: preview.spec.allDay || false
        };
      }
    }
    
    return result;
    
  } catch (error) {
    console.error("[APPOINTMENT:DESIGNER:ERROR]", error);
    throw error;
  }
}

/**
 * Standalone function to generate appointment spec (for testing)
 */
async function generateAppointmentSpec(request, options = {}) {
  const state = {
    messages: [{ role: "user", content: request }],
    action: { id: `appointment_${Date.now()}` }
  };
  
  const config = {
    configurable: {
      userId: options.userId || "test",
      orgId: options.orgId || "test",
      user_tz: options.timezone || "UTC"
    }
  };
  
  const result = await design_create_appointment(state, config);
  return result.previews?.[0]?.spec;
}

module.exports = {
  design_create_appointment,
  generateAppointmentSpec,
  generateAppointmentPrompt,
  extractAppointmentParams
};