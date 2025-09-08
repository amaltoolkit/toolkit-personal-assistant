/**
 * Task Designer Agent
 * 
 * Designs individual tasks based on user requests.
 * Generates financial advisor-focused tasks with appropriate priorities and deadlines.
 */

const { baseDesigner, promptPatterns, validateDesignerConfig } = require('./baseDesigner');
const { TaskSpec } = require('./agentSchemas');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

// Load dayjs plugins for timezone support
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Prompt template for task generation
 */
function generateTaskPrompt(params) {
  const { userMessage, userContext, memoryContext } = params;
  
  return `You are a task design specialist for financial advisors. Create a well-structured task based on the user's request.

${promptPatterns.getUserContext(userContext)}
${promptPatterns.getMemoryContext(memoryContext)}

Current Date and Time Context:
- Current Date/Time: ${userContext.currentDate}
- User Timezone: ${userContext.timezone}

User Request: ${userMessage}

IMPORTANT DATE HANDLING:
- If the user specifies a natural language date (like "tomorrow", "next Friday", "in 3 days"),
  set the dateQuery field with the exact phrase and leave dueTime/startTime empty.
- If the user provides specific dates in ISO format, use dueTime and startTime fields.
- The system will automatically parse natural language dates based on the current date shown above.
- Default behavior: dates are treated as due dates unless "start" keyword is present.

Create a professional task with the following requirements:

1. Subject Requirements:
   - Clear, action-oriented title (e.g., "Review Q3 portfolio performance for Johnson account")
   - Specific enough to understand the action needed
   - Include relevant identifiers when applicable (client names, account numbers, etc.)

2. Priority Guidelines:
   - High: Compliance deadlines, urgent client needs, time-sensitive opportunities
   - Normal: Regular reviews, standard follow-ups, routine documentation
   - Low: Nice-to-have tasks, long-term planning items, optional improvements

3. Due Date Considerations:
   - Compliance tasks: Add buffer before actual deadline
   - Client follow-ups: Within 24-48 hours for urgent, 3-5 days for standard
   - Documentation: End of business day or next morning
   - Reviews: Allow adequate preparation time (2-3 days minimum)

4. Assignment Logic:
   - ContactsOwner: Client interactions, analysis, decisions, reviews
   - ContactsOwnersAssistant: Scheduling, document preparation, data entry, follow-ups
   - SpecificUser: Only when explicitly mentioned

5. Task Categories (for internal organization):
   - Client Follow-up: Post-meeting actions, client requests
   - Compliance: Regulatory requirements, documentation
   - Portfolio Review: Performance analysis, rebalancing
   - Administrative: Internal tasks, team coordination
   - Business Development: Prospecting, marketing activities

6. Status and Completion:
   - Always start with "NotStarted" unless updating existing task
   - Set percentComplete to 0 for new tasks
   - Use rollOver=true for critical deadlines that must not be missed

7. Common Task Patterns:
   - "Follow up with [Client] regarding [Topic]" - 1-2 days, Normal priority
   - "Review and approve [Document]" - Same day or next day, High priority
   - "Prepare [Report] for [Meeting]" - 3-5 days before meeting, Normal priority
   - "Submit [Compliance Form]" - 5 days before deadline, High priority, rollOver=true
   - "Schedule [Type] meeting with [Client]" - 2-3 days, Normal priority, ContactsOwnersAssistant

8. Description Content:
   - Include context about why the task is important
   - Add any specific requirements or considerations
   - Note dependencies or related tasks if applicable
   - Include reference numbers or links if relevant

9. Time Handling:
   - Set dueTime to end of business day (5:00 PM) unless specified otherwise
   - For morning tasks, set to 9:00 AM
   - For urgent same-day tasks, set to 2:00 PM to allow completion time
   - Use startTime only for tasks with specific start requirements

${promptPatterns.getQualityInstructions()}

Generate a task that is practical, actionable, and follows financial advisory best practices.`;
}

/**
 * Extract parameters from state for the designer
 */
function extractTaskParams(state, config) {
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
      currentDate: now.toISOString(),
      timezone: userTimezone
    },
    memoryContext: memoryContext || state
  };
}

/**
 * Main task designer function
 * Creates task specifications for BSA
 */
async function design_create_task(state, config) {
  const designerConfig = {
    schema: TaskSpec,
    promptTemplate: generateTaskPrompt,
    previewType: "task",
    extractParams: extractTaskParams,
    model: "gpt-4o-mini",
    temperature: 0.2  // Slightly higher for more natural task descriptions
  };
  
  // Validate configuration
  validateDesignerConfig(designerConfig);
  
  console.log("[TASK:DESIGNER] Generating task specification...");
  
  try {
    // Use base designer to generate the task spec
    const result = await baseDesigner(state, config, designerConfig);
    
    // Add additional metadata and validation
    if (result.previews && result.previews[0]) {
      const preview = result.previews[0];
      
      // Log task summary
      if (preview.spec) {
        console.log(`[TASK:DESIGNER] Generated task: "${preview.spec.subject}"`);
        
        if (preview.spec.dateQuery) {
          console.log(`[TASK:DESIGNER] Natural language date: "${preview.spec.dateQuery}"`);
        } else if (preview.spec.dueTime) {
          console.log(`[TASK:DESIGNER] Due: ${preview.spec.dueTime}`);
        }
        
        console.log(`[TASK:DESIGNER] Priority: ${preview.spec.priority}, Assigned to: ${preview.spec.assigneeType}`);
        
        // Add task metadata
        preview.metadata = {
          type: "task",
          priority: preview.spec.priority,
          hasDateQuery: !!preview.spec.dateQuery,
          hasExactDueTime: !!preview.spec.dueTime,
          assigneeType: preview.spec.assigneeType,
          hasRollover: preview.spec.rollOver || false,
          category: preview.spec.category || "General"
        };
      }
    }
    
    return result;
    
  } catch (error) {
    console.error("[TASK:DESIGNER:ERROR]", error);
    throw error;
  }
}

/**
 * Standalone function to generate task spec (for testing)
 */
async function generateTaskSpec(request, options = {}) {
  const state = {
    messages: [{ role: "user", content: request }],
    action: { id: `task_${Date.now()}` }
  };
  
  const config = {
    configurable: {
      userId: options.userId || "test",
      orgId: options.orgId || "test",
      user_tz: options.timezone || "UTC"
    }
  };
  
  const result = await design_create_task(state, config);
  return result.previews?.[0]?.spec;
}

module.exports = {
  design_create_task,
  generateTaskSpec,
  generateTaskPrompt,
  extractTaskParams
};