/**
 * Workflow Designer Agent
 * 
 * Designs advocate_process workflows based on user requests.
 * Generates comprehensive financial advisor workflows with 5-12 meaningful steps.
 */

const { baseDesigner, promptPatterns, validateDesignerConfig } = require('./baseDesigner');
const { WorkflowSpec } = require('./agentSchemas');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

// Load dayjs plugins for timezone support
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Prompt template for workflow generation
 */
function generateWorkflowPrompt(params) {
  const { userMessage, userContext, memoryContext } = params;
  
  return `You are a workflow design specialist for financial advisors. Create a comprehensive advocate process workflow.

${promptPatterns.getUserContext(userContext)}
${promptPatterns.getMemoryContext(memoryContext)}

Current Date and Time Context:
- Current Date/Time: ${userContext.currentDateTime}
- Today's Date: ${userContext.currentDate} (${userContext.dayOfWeek})
- Timezone: ${userContext.timezone}

User Request: ${userMessage}

IMPORTANT: When setting dayOffset values, calculate them relative to the current date shown above. For example:
- dayOffset: 0 = Today (${userContext.currentDate})
- dayOffset: 1 = Tomorrow
- dayOffset: 7 = One week from today

Create a professional financial advisor workflow with the following requirements:

1. Generate 5-12 meaningful steps that form a complete process
2. Each step should have:
   - A clear, action-oriented subject (what needs to be done)
   - A detailed description explaining the step
   - Logical sequencing (1, 2, 3, etc.)
   - Appropriate dayOffset (time allocated for the step)
   - Correct assignment (ContactsOwner for advisor tasks, ContactsOwnersAssistant for admin tasks)

3. Step Types:
   - Use "Task" for work items, documents, analysis, preparation
   - Use "Appointment" for meetings, calls, presentations
   - Mix both types naturally based on the workflow needs

4. Timeline Considerations:
   - Simple tasks: 1 day offset
   - Complex analysis: 3-5 days
   - Document preparation: 2-3 days
   - Client response time: 3-7 days
   - Meeting scheduling: 1-2 days buffer

5. Assignment Logic:
   - ContactsOwner: Strategic tasks, analysis, client meetings, decisions
   - ContactsOwnersAssistant: Administrative tasks, scheduling, document sending, follow-ups

6. Common Workflow Patterns for Financial Advisors:
   - Client Onboarding: Discovery → Documentation → Account Setup → Initial Planning
   - Financial Planning: Data Gathering → Analysis → Strategy → Presentation → Implementation
   - Portfolio Review: Performance Analysis → Risk Assessment → Rebalancing → Client Review
   - Annual Review: Preparation → Meeting → Action Items → Follow-up

7. Best Practices:
   - Start with information gathering or preparation
   - Include client touchpoints (meetings/calls)
   - Add quality checks or review steps
   - End with follow-up or next steps
   - Set rollOver=true for critical steps

${promptPatterns.getQualityInstructions()}

Generate a workflow that is practical, comprehensive, and follows financial industry best practices.`;
}

/**
 * Extract parameters from state for the designer
 */
function extractWorkflowParams(state, config) {
  const userMessage = state.messages?.at(-1)?.content || "";
  
  // Look for memory context in state
  const memoryContext = state.messages?.find(m => 
    m.role === "system" && m.content?.includes("Relevant context:")
  );
  
  // Get user's timezone and current date/time
  const userTimezone = config?.configurable?.user_tz || "UTC";
  const now = dayjs().tz(userTimezone);
  
  return {
    userMessage,
    userContext: {
      ...config,
      currentDateTime: now.toISOString(),
      timezone: userTimezone,
      currentDate: now.format('YYYY-MM-DD'),
      dayOfWeek: now.format('dddd')
    },
    memoryContext: memoryContext || state
  };
}

/**
 * Main workflow designer function
 * Creates advocate_process workflow specifications
 */
async function design_build_workflow(state, config) {
  const designerConfig = {
    schema: WorkflowSpec,
    promptTemplate: generateWorkflowPrompt,
    previewType: "workflow",
    extractParams: extractWorkflowParams,
    model: "gpt-4o-mini",
    temperature: 0.1  // Low temperature for consistent structure
  };
  
  // Validate configuration
  validateDesignerConfig(designerConfig);
  
  console.log("[WORKFLOW:DESIGNER] Generating workflow specification...");
  
  try {
    // Use base designer to generate the workflow spec
    const result = await baseDesigner(state, config, designerConfig);
    
    // Add additional metadata
    if (result.previews && result.previews[0]) {
      const preview = result.previews[0];
      
      // Validate step count
      if (preview.spec && preview.spec.steps) {
        const stepCount = preview.spec.steps.length;
        console.log(`[WORKFLOW:DESIGNER] Generated workflow with ${stepCount} steps`);
        
        if (stepCount < 5) {
          console.warn("[WORKFLOW:DESIGNER] Warning: Workflow has fewer than 5 steps");
        } else if (stepCount > 12) {
          console.warn("[WORKFLOW:DESIGNER] Warning: Workflow has more than 12 steps");
        }
        
        // Log step summary
        preview.spec.steps.forEach(step => {
          console.log(`[WORKFLOW:DESIGNER] Step ${step.sequence}: ${step.subject} (${step.activityType}, ${step.dayOffset} days, ${step.assigneeType})`);
        });
      }
      
      // Add workflow metadata
      preview.metadata = {
        type: "advocate_process",
        stepCount: preview.spec?.steps?.length || 0,
        totalDays: preview.spec?.steps?.reduce((sum, step) => sum + (step.dayOffset || 1), 0) || 0,
        taskCount: preview.spec?.steps?.filter(s => s.activityType === "Task").length || 0,
        appointmentCount: preview.spec?.steps?.filter(s => s.activityType === "Appointment").length || 0
      };
    }
    
    return result;
    
  } catch (error) {
    console.error("[WORKFLOW:DESIGNER:ERROR]", error);
    throw error;
  }
}

/**
 * Standalone function to generate workflow spec (for testing)
 */
async function generateWorkflowSpec(request, options = {}) {
  const state = {
    messages: [{ role: "user", content: request }],
    action: { id: `workflow_${Date.now()}` }
  };
  
  const config = {
    configurable: {
      userId: options.userId || "test",
      orgId: options.orgId || "test",
      user_tz: options.timezone || "UTC"
    }
  };
  
  const result = await design_build_workflow(state, config);
  return result.previews?.[0]?.spec;
}

module.exports = {
  design_build_workflow,
  generateWorkflowSpec,
  generateWorkflowPrompt,
  extractWorkflowParams
};