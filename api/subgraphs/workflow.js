/**
 * Workflow Subgraph - Simplified domain-specific graph for workflow creation
 *
 * Simple flow: Generate → Validate → Preview → Approve → Create
 * The LLM intelligently adapts complexity based on the user's request
 */

const { StateGraph, END } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { createWorkflow, addWorkflowStep } = require("../tools/bsa/workflows");
const { getMem0Service } = require("../services/mem0Service");
const { getErrorHandler } = require("../services/errorHandler");
const { getPerformanceMetrics } = require("../coordinator/metrics");
const { getEntityManager } = require("../services/entityManager");

// Simplified state channels for workflow operations
const WorkflowStateChannels = {
  // Input
  messages: {
    value: (x, y) => y || x,
    default: () => []
  },
  memory_context: {
    value: (x, y) => y || x,
    default: () => ({})
  },
  entities: {
    value: (x, y) => ({ ...x, ...y }),
    default: () => ({})
  },

  // Processing
  workflowDesign: {
    value: (x, y) => y || x,
    default: () => null
  },
  validationErrors: {
    value: (x, y) => y || x,
    default: () => []
  },
  preview: {
    value: (x, y) => y || x,
    default: () => null
  },

  // Output
  workflowId: {
    value: (x, y) => y || x,
    default: () => null
  },
  approved: {
    value: (x, y) => y,
    default: () => false
  },
  rejected: {
    value: (x, y) => y,
    default: () => false
  },
  approval_decision: {
    value: (x, y) => y || x,
    default: () => null
  },
  requiresApproval: {
    value: (x, y) => y !== undefined ? y : x,
    default: () => false
  },
  approvalRequest: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  response: {
    value: (x, y) => y || x,
    default: () => ""
  },
  error: {
    value: (x, y) => y || x,
    default: () => null
  },

  // Context fields (required for authentication and state management)
  session_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  org_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  user_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  thread_id: {
    value: (x, y) => y || x,
    default: () => null
  },
  timezone: {
    value: (x, y) => y || x,
    default: () => 'UTC'
  }
};

class WorkflowSubgraph {
  constructor(checkpointer = null) {
    this.llm = new ChatOpenAI({
      modelName: "gpt-5"
      // Temperature removed - gpt-5 only supports default (1)
    });

    this.mem0 = getMem0Service();
    this.errorHandler = getErrorHandler();
    this.metrics = getPerformanceMetrics();
    this.entityManager = getEntityManager();
    this.checkpointer = checkpointer;

    this.maxSteps = 22; // BSA constraint

    this.graph = this.buildGraph();
  }

  /**
   * Clean JSON response from LLM by removing markdown code blocks
   */
  cleanJsonResponse(content) {
    if (!content) return '';

    // Remove markdown code blocks
    let cleaned = content.trim();

    // Remove ```json or ``` from the start
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.substring(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.substring(3);
    }

    // Remove ``` from the end
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }

    // Final trim to remove any whitespace
    return cleaned.trim();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: WorkflowStateChannels
    });

    // Simplified node structure
    workflow.addNode("generate_workflow", this.generateWorkflow.bind(this));
    workflow.addNode("validate_workflow", this.validateWorkflow.bind(this));
    workflow.addNode("generate_preview", this.generatePreview.bind(this));
    workflow.addNode("wait_approval", this.waitForApproval.bind(this));
    workflow.addNode("create_workflow", this.createWorkflow.bind(this));
    workflow.addNode("format_response", this.formatResponse.bind(this));

    // Simple linear flow
    workflow.setEntryPoint("generate_workflow");

    // Route after generate: if we answered a question, skip to format_response
    workflow.addConditionalEdges(
      "generate_workflow",
      (state) => {
        // If we already have a response (from answering a question), skip workflow creation
        if (state.response && !state.workflowDesign) {
          return "format_response";
        }
        // Otherwise proceed to validation
        return "validate_workflow";
      },
      {
        "format_response": "format_response",
        "validate_workflow": "validate_workflow"
      }
    );

    // Route based on validation
    workflow.addConditionalEdges(
      "validate_workflow",
      (state) => {
        if (state.error) return "format_response";
        return "generate_preview";
      },
      {
        "format_response": "format_response",
        "generate_preview": "generate_preview"
      }
    );

    workflow.addEdge("generate_preview", "wait_approval");

    // Route from approval
    workflow.addConditionalEdges(
      "wait_approval",
      (state) => {
        // If we have requiresApproval true, we're waiting for coordinator to handle
        if (state.requiresApproval) {
          return "format_response";  // Return to coordinator for approval handling
        }
        // After approval decision is processed
        if (state.approved) return "create_workflow";
        if (state.rejected) return "format_response";
        return "format_response";
      },
      {
        "create_workflow": "create_workflow",
        "format_response": "format_response"
      }
    );

    workflow.addEdge("create_workflow", "format_response");
    workflow.addEdge("format_response", END);

    // Always compile WITHOUT checkpointer - subgraphs are stateless
    const compileOptions = {};
    console.log("[WORKFLOW] Compiling graph in STATELESS mode (no checkpointer)");

    return workflow.compile(compileOptions);
  }

  /**
   * Generate workflow based on user request - single smart LLM call
   */
  async generateWorkflow(state) {
    console.log("[WORKFLOW:GENERATE] Creating workflow from user request");

    try {
      const lastMessage = state.messages?.[state.messages.length - 1];
      if (!lastMessage) {
        return {
          ...state,
          error: "No message provided"
        };
      }

      const userRequest = lastMessage.content.toLowerCase();

      // Workflow creation flow - questions about existing workflows are now handled by general agent
      const prompt = `
        You are an assistant at a financial advisory firm, expert in creating workflows for financial advisors and their teams.

        Create a workflow based on this user request: "${userRequest}"

        CONTEXT:
        - Each step is executed by either the "Advisor" (the financial advisor) or the "Assistant" (the advisor's assistant)
        - Consider financial industry best practices, compliance requirements, and client experience
        - Steps should flow logically with appropriate timing between them

        CRITICAL INSTRUCTIONS:
        1. If the user specifies a number of steps (e.g., "2 step", "two-step", "3 steps"), create EXACTLY that many steps
        2. If the user asks for "simple" or "basic", keep it minimal (2-4 steps)
        3. If the user asks for "comprehensive" or "detailed", include necessary detail (8-15 steps)
        4. Otherwise, use your judgment for appropriate complexity based on the domain
        5. Maximum ${this.maxSteps} steps allowed

        For each step, provide:
        - name: Clear, action-oriented name
        - description: What happens in this step
        - type: "task" (action item/to-do) or "appointment" (scheduled meeting/call)
        - assignee: "Advisor" (for strategic/client-facing work) or "Assistant" (for administrative/preparation work)
        - dayOffset: Number of days this individual step takes to complete (determines when the next step will appear):
          * Use 0 if the step takes less than a day or happens same day
          * Use 1 if it takes a full day to complete
          * Use appropriate number for multi-day tasks (e.g., 3 for "3 days", 7 for "1 week")
          * Each step's dayOffset is independent - it's the duration of that specific step

        Return JSON format:
        {
          "name": "Workflow Name (be specific to the request)",
          "description": "One-line description of the workflow's purpose",
          "steps": [
            {
              "name": "Step Name",
              "description": "What happens in this step",
              "type": "task|appointment",
              "assignee": "Advisor|Assistant",
              "dayOffset": 0
            }
          ],
          "totalDuration": "e.g., 3 days",
          "reasoning": "Brief explanation of why this structure was chosen"
        }

        Examples:
        - "2 step client outreach" → Step 1: Assistant prepares materials (dayOffset: 1 - takes 1 day), Step 2: Advisor calls client (dayOffset: 0 - same day)
        - "simple onboarding" → 3-4 essential steps, each with appropriate dayOffset based on task duration
        - "comprehensive financial planning" → 10-12 detailed steps with varying dayOffsets per step complexity
      `;

      const response = await this.llm.invoke(prompt);
      const cleanedContent = this.cleanJsonResponse(response.content);
      const design = JSON.parse(cleanedContent);

      console.log(`[WORKFLOW:GENERATE] Created workflow with ${design.steps.length} steps`);
      console.log(`[WORKFLOW:GENERATE] Reasoning: ${design.reasoning}`);

      return {
        ...state,
        workflowDesign: design
      };

    } catch (error) {
      console.error("[WORKFLOW:GENERATE] Error generating workflow:", error);
      return {
        ...state,
        error: `Failed to generate workflow: ${error.message}`
      };
    }
  }

  /**
   * Validate workflow against constraints
   */
  async validateWorkflow(state) {
    console.log("[WORKFLOW:VALIDATE] Validating workflow");

    if (!state.workflowDesign) {
      return {
        ...state,
        error: "No workflow design to validate"
      };
    }

    const errors = [];
    const design = state.workflowDesign;

    // Check step count
    if (!design.steps || design.steps.length === 0) {
      errors.push("Workflow must have at least one step");
    } else if (design.steps.length > this.maxSteps) {
      errors.push(`Workflow exceeds maximum of ${this.maxSteps} steps`);
    }

    // Validate each step
    design.steps?.forEach((step, index) => {
      if (!step.name) {
        errors.push(`Step ${index + 1} is missing a name`);
      }
      if (!step.type || !['task', 'appointment'].includes(step.type.toLowerCase())) {
        errors.push(`Step ${index + 1} has invalid type: ${step.type}. Must be 'task' or 'appointment'`);
      }
    });

    if (errors.length > 0) {
      console.log("[WORKFLOW:VALIDATE] Validation errors:", errors);
    } else {
      console.log("[WORKFLOW:VALIDATE] Validation passed");
    }

    return {
      ...state,
      validationErrors: errors
    };
  }

  /**
   * Generate preview for approval
   */
  async generatePreview(state) {
    console.log("[WORKFLOW:PREVIEW] Generating workflow preview");

    if (!state.workflowDesign) {
      return {
        ...state,
        error: "No workflow to preview"
      };
    }

    const design = state.workflowDesign;

    // Create preview structure
    const preview = {
      type: "workflow",
      action: "create",
      title: design.name,
      subject: design.name,
      details: {
        description: design.description,
        stepCount: design.steps?.length || 0,
        totalDuration: design.totalDuration || "Variable",
        steps: design.steps?.map((step, index) => ({
          number: index + 1,
          name: step.name,
          type: step.type,
          duration: step.duration,
          assignee: step.assignee
        })),
        validationErrors: state.validationErrors,
        reasoning: design.reasoning
      },
      // Add spec for UI rendering
      spec: {
        name: design.name,
        description: design.description,
        steps: design.steps?.map(s => ({
          name: s.name,
          subject: s.name
        }))
      }
    };

    // Add warnings if any
    preview.warnings = [];
    if (state.validationErrors?.length > 0) {
      preview.warnings.push(...state.validationErrors);
    }

    console.log("[WORKFLOW:PREVIEW] Preview generated");

    return {
      ...state,
      preview
    };
  }

  /**
   * Wait for user approval
   */
  async waitForApproval(state) {
    console.log("[WORKFLOW:APPROVAL] Requesting user approval");

    // Check if we're resuming from an approval decision
    if (state.approval_decision) {
      console.log(`[WORKFLOW:APPROVAL] Resuming with decision: ${state.approval_decision}`);
      return {
        ...state,
        approved: state.approval_decision === 'approve',
        rejected: state.approval_decision === 'reject',
        requiresApproval: false  // Clear the flag
      };
    }

    if (!state.preview) {
      console.log("[WORKFLOW:APPROVAL] No preview available, auto-approving");
      return { ...state, approved: true };
    }

    // Return approval request structure
    console.log("[WORKFLOW:APPROVAL] Returning approval request for coordinator to handle");

    return {
      ...state,
      requiresApproval: true,
      approvalRequest: {
        domain: 'workflow',
        type: 'approval_required',
        actionId: `workflow_${Date.now()}`,
        action: 'create',
        preview: state.preview,
        data: state.workflowDesign,
        message: `Please review the workflow:`,
        thread_id: state.thread_id || null
      },
      approved: false
    };
  }

  /**
   * Create workflow in BSA
   */
  async createWorkflow(state, config) {
    console.log("[WORKFLOW:CREATE] Creating workflow in BSA");
    this.metrics.startTimer("workflow_creation");

    try {
      const passKey = await config.configurable.getPassKey();
      const design = state.workflowDesign;

      // Create main workflow
      const workflowResult = await this.errorHandler.executeWithRetry(
        async () => await createWorkflow(
          design.name,
          design.description,
          passKey,
          state.org_id || config.configurable.org_id
        ),
        {
          operation: "create_workflow",
          maxRetries: 2,
          circuitBreakerKey: "bsa_workflow"
        }
      );

      const workflowId = workflowResult.id || workflowResult.Id;
      console.log(`[WORKFLOW:CREATE] Created workflow ${workflowId}`);

      // Add steps sequentially
      if (design.steps?.length > 0) {
        const orgId = state.org_id || config.configurable.org_id;
        let addedCount = 0;
        for (let i = 0; i < design.steps.length; i++) {
          const step = design.steps[i];
          const stepData = {
            sequence: i + 1,
            subject: step.name || `Step ${i + 1}`,
            description: step.description || "",
            activityType: (step.type && step.type.toLowerCase().includes('appointment')) ? 'Appointment' : 'Task',
            dayOffset: typeof step.dayOffset === 'number' ? step.dayOffset : 0,
            assigneeType: (step.assignee && /assistant/i.test(step.assignee)) ? 'ContactsOwnersAssistant' : 'ContactsOwner',
            rollOver: true,
            allDay: ((step.type || '').toLowerCase() === 'task')
          };

          try {
            await this.errorHandler.executeWithRetry(
              async () => await addWorkflowStep(workflowId, stepData, passKey, orgId),
              {
                operation: 'add_workflow_step',
                maxRetries: 2,
                circuitBreakerKey: 'bsa_workflow'
              }
            );
            addedCount += 1;
          } catch (e) {
            console.error(`[WORKFLOW:CREATE] Failed to add step ${i + 1}:`, e.message);
          }
        }
        console.log(`[WORKFLOW:CREATE] Added ${addedCount}/${design.steps.length} steps`);
      }

      this.metrics.endTimer("workflow_creation", true, {
        steps: design.steps?.length || 0
      });

      // Store workflow info for memory
      if (this.mem0.client) {
        try {
          const memoryContent = `
            Created workflow: ${design.name}
            Description: ${design.description}
            Steps: ${design.steps?.map(s => s.name).join(', ')}
            Total steps: ${design.steps?.length}
          `;

          await this.mem0.synthesize(
            memoryContent,
            state.org_id || "default-org",
            state.user_id || "default-user",
            {
              type: "workflow_created",
              workflowId: workflowId,
              stepCount: design.steps?.length
            }
          );
        } catch (error) {
          console.error("[WORKFLOW:CREATE] Error storing memory:", error);
          // Continue without storing
        }
      }

      return {
        ...state,
        workflowId,
        entities: {
          ...state.entities,
          [`workflow_${workflowId}`]: {
            id: `workflow_${workflowId}`,
            type: "workflow",
            name: design.name,
            data: {
              id: workflowId,
              name: design.name,
              description: design.description,
              stepCount: design.steps?.length || 0
            },
            references: [
              design.name,
              `workflow ${workflowId}`,
              "the workflow",
              "this workflow"
            ],
            createdAt: Date.now()
          }
        }
      };

    } catch (error) {
      console.error("[WORKFLOW:CREATE] Error creating workflow:", error);
      this.metrics.endTimer("workflow_creation", false, { error: error.message });

      return {
        ...state,
        error: `Failed to create workflow: ${error.message}`
      };
    }
  }

  /**
   * Format final response
   */
  async formatResponse(state) {
    console.log("[WORKFLOW:RESPONSE] Formatting response");

    if (state.error) {
      return {
        ...state,
        response: `Error: ${state.error}`
      };
    }

    // If we already have a response without a workflow design, preserve it
    if (state.response && !state.workflowDesign) {
      console.log("[WORKFLOW:RESPONSE] Preserving existing response");
      return {
        ...state
        // Keep existing response and all other state
      };
    }

    // If approval is required, preserve the approval request
    if (state.requiresApproval && state.approvalRequest) {
      console.log("[WORKFLOW:RESPONSE] Approval pending - preserving approval request");
      return {
        ...state,
        response: "Awaiting approval...",
        requiresApproval: true,
        approvalRequest: state.approvalRequest
      };
    }

    if (state.workflowId) {
      const design = state.workflowDesign;

      // Store workflow entity for context continuity using EntityManager
      const workflowEntity = {
        id: state.workflowId,
        name: design.name,
        description: design.description,
        stepCount: design.steps?.length || 0,
        steps: design.steps || [],
        createdAt: new Date().toISOString()
      };

      console.log("[WORKFLOW:RESPONSE] Storing workflow entity via EntityManager:", {
        id: workflowEntity.id,
        name: workflowEntity.name,
        stepCount: workflowEntity.stepCount
      });

      // Use EntityManager to store with history and indexing
      const updatedEntities = this.entityManager.store(
        state.entities || {},
        'workflow',
        workflowEntity
      );

      return {
        ...state,
        entities: updatedEntities,
        response: `Successfully created workflow "${design.name}" with ${design.steps?.length || 0} steps. Workflow ID: ${state.workflowId}`
      };
    }

    if (state.rejected) {
      return {
        ...state,
        response: "Workflow creation cancelled by user"
      };
    }

    return {
      ...state,
      response: "Workflow creation was not completed"
    };
  }

  /**
   * Main entry point for workflow creation
   */
  async create(messages, context = {}) {
    console.log("[WORKFLOW] Creating workflow");

    const initialState = {
      messages,
      memory_context: context.memory_context || {},
      entities: context.entities || {},
      org_id: context.org_id,
      user_id: context.user_id,
      session_id: context.session_id,
      thread_id: context.thread_id,
      timezone: context.timezone
    };

    try {
      const result = await this.graph.invoke(initialState, {
        configurable: context.configurable || {}
      });

      return result;

    } catch (error) {
      console.error("[WORKFLOW] Error creating workflow:", error);
      return {
        ...initialState,
        error: error.message,
        response: `Failed to create workflow: ${error.message}`
      };
    }
  }
}

// Export factory function for coordinator
/**
 * Factory function to create workflow subgraph
 * @param {Object} checkpointer - The checkpointer (propagated from parent)
 */
async function createSubgraph(checkpointer = null) {
  const subgraph = new WorkflowSubgraph(checkpointer);
  return subgraph.graph;
}

// Export singleton instance (for backward compatibility)
let instance = null;

module.exports = {
  createSubgraph,
  getWorkflowSubgraph: () => {
    if (!instance) {
      instance = new WorkflowSubgraph();
    }
    return instance;
  },
  WorkflowSubgraph
};