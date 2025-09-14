/**
 * Workflow Subgraph - Domain-specific graph for workflow creation
 * 
 * Supports three workflow creation modes:
 * - Agent-led: Full best practices control
 * - User-specified: Parse explicit steps from user
 * - Hybrid: Merge best practices with custom steps
 */

const { StateGraph, END, interrupt } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { createWorkflow, addWorkflowSteps } = require("../tools/bsa/workflows");
const { getMem0Service } = require("../services/mem0Service");
const { getErrorHandler } = require("../services/errorHandler");
const { getPerformanceMetrics } = require("../coordinator/metrics");
const { getContactLinker } = require("../services/contactLinker");

// State channels for workflow operations
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
  
  // Guidance detection
  guidanceMode: {
    value: (x, y) => y || x,
    default: () => null
  },
  userSteps: {
    value: (x, y) => y || x,
    default: () => []
  },
  bestPractices: {
    value: (x, y) => y || x,
    default: () => []
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
  refinementAttempts: {
    value: (x, y) => y || 0,
    default: () => 0
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
      modelName: "gpt-4o-mini",
      temperature: 0.4
    });

    this.mem0 = getMem0Service();
    this.errorHandler = getErrorHandler();
    this.metrics = getPerformanceMetrics();
    this.checkpointer = checkpointer;
    this.contactLinker = getContactLinker();
    
    this.maxSteps = 22; // BSA constraint
    this.maxRefinements = 3;
    
    this.graph = this.buildGraph();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: WorkflowStateChannels
    });

    // Add nodes
    workflow.addNode("detect_guidance", this.detectGuidance.bind(this));
    workflow.addNode("recall_patterns", this.recallPatterns.bind(this));
    workflow.addNode("design_agent_led", this.designAgentLed.bind(this));
    workflow.addNode("parse_user_steps", this.parseUserSteps.bind(this));
    workflow.addNode("merge_hybrid", this.mergeHybrid.bind(this));
    workflow.addNode("validate_workflow", this.validateWorkflow.bind(this));
    workflow.addNode("generate_preview", this.generatePreview.bind(this));
    workflow.addNode("wait_approval", this.waitForApproval.bind(this));
    workflow.addNode("create_workflow", this.createWorkflow.bind(this));
    workflow.addNode("link_contacts", this.linkContacts.bind(this));
    workflow.addNode("synthesize_memory", this.synthesizeMemory.bind(this));
    workflow.addNode("format_response", this.formatResponse.bind(this));

    // Define flow
    workflow.setEntryPoint("detect_guidance");
    workflow.addEdge("detect_guidance", "recall_patterns");
    
    // Route based on guidance mode
    workflow.addConditionalEdges(
      "recall_patterns",
      (state) => {
        if (state.error) return "format_response";
        if (state.guidanceMode === "agent-led") return "design_agent_led";
        if (state.guidanceMode === "user-specified") return "parse_user_steps";
        if (state.guidanceMode === "hybrid") return "parse_user_steps";
        return "design_agent_led"; // Default
      },
      {
        "format_response": "format_response",
        "design_agent_led": "design_agent_led",
        "parse_user_steps": "parse_user_steps"
      }
    );
    
    workflow.addEdge("design_agent_led", "validate_workflow");
    workflow.addEdge("parse_user_steps", "validate_workflow");
    
    // Route from parse_user_steps for hybrid mode
    workflow.addConditionalEdges(
      "validate_workflow",
      (state) => {
        if (state.error) return "format_response";
        if (state.guidanceMode === "hybrid" && !state.bestPractices?.length) {
          return "design_agent_led";
        }
        if (state.guidanceMode === "hybrid" && state.userSteps?.length && state.bestPractices?.length) {
          return "merge_hybrid";
        }
        if (state.validationErrors?.length > 0) return "generate_preview";
        return "generate_preview";
      },
      {
        "format_response": "format_response",
        "design_agent_led": "design_agent_led",
        "merge_hybrid": "merge_hybrid",
        "generate_preview": "generate_preview"
      }
    );
    
    workflow.addEdge("merge_hybrid", "validate_workflow");
    workflow.addEdge("generate_preview", "wait_approval");
    
    // Route from approval
    workflow.addConditionalEdges(
      "wait_approval",
      (state) => {
        if (state.approved) return "create_workflow";
        if (state.refinementAttempts < this.maxRefinements) return "generate_preview";
        return "format_response";
      },
      {
        "create_workflow": "create_workflow",
        "generate_preview": "generate_preview",
        "format_response": "format_response"
      }
    );
    
    workflow.addEdge("create_workflow", "link_contacts");
    workflow.addEdge("link_contacts", "synthesize_memory");
    workflow.addEdge("synthesize_memory", "format_response");
    workflow.addEdge("format_response", END);

    // Compile with checkpointer if available
    const compileOptions = {};
    if (this.checkpointer) {
      compileOptions.checkpointer = this.checkpointer;
      const checkpointerType = this.checkpointer.constructor?.name || 'Unknown';
      console.log(`[WORKFLOW] Compiling graph WITH checkpointer (${checkpointerType})`);
    } else {
      console.log("[WORKFLOW] Compiling graph WITHOUT checkpointer (interrupts disabled)");
    }

    return workflow.compile(compileOptions);
  }

  /**
   * Detect guidance mode from user input
   */
  async detectGuidance(state) {
    console.log("[WORKFLOW:GUIDANCE] Detecting guidance mode");
    
    try {
      const lastMessage = state.messages?.[state.messages.length - 1];
      if (!lastMessage) {
        return {
          ...state,
          error: "No message provided"
        };
      }
      
      const prompt = `
        Analyze this request and determine the workflow creation mode:
        
        Request: "${lastMessage.content}"
        
        Modes:
        1. "agent-led" - User wants best practices, no specific steps provided
        2. "user-specified" - User provides explicit steps or process
        3. "hybrid" - User provides some steps but wants enhancement
        
        Look for:
        - Explicit step lists (numbered, bulleted)
        - Phrases like "with these steps", "following this process", "my workflow"
        - Requests for best practices or recommendations
        
        Also extract:
        - Domain/purpose of the workflow
        - Any specific requirements mentioned
        
        Return JSON:
        {
          "mode": "agent-led|user-specified|hybrid",
          "domain": "extracted domain",
          "hasExplicitSteps": boolean,
          "requirements": ["requirement1", "requirement2"]
        }
      `;
      
      const response = await this.llm.invoke(prompt);
      const analysis = JSON.parse(response.content);
      
      console.log("[WORKFLOW:GUIDANCE] Mode detected:", analysis.mode);
      
      return {
        ...state,
        guidanceMode: analysis.mode,
        workflowDomain: analysis.domain,
        requirements: analysis.requirements
      };
      
    } catch (error) {
      console.error("[WORKFLOW:GUIDANCE] Error detecting guidance:", error);
      return {
        ...state,
        guidanceMode: "agent-led", // Default to agent-led
        error: null // Continue with default
      };
    }
  }

  /**
   * Recall workflow patterns from memory
   */
  async recallPatterns(state) {
    console.log("[WORKFLOW:PATTERNS] Recalling workflow patterns");
    this.metrics.startTimer("workflow_pattern_recall");
    
    try {
      if (!this.mem0.client) {
        console.log("[WORKFLOW:PATTERNS] Mem0 not configured, skipping");
        this.metrics.endTimer("workflow_pattern_recall", true, { skipped: true });
        return state;
      }
      
      const domain = state.workflowDomain || "general";
      const orgId = state.org_id || "default-org";
      const userId = state.user_id || "default-user";
      
      // Search for similar workflows
      const patterns = await this.mem0.recall(
        `workflow ${domain} process steps best practices`,
        orgId,
        userId,
        { limit: 3, threshold: 0.6 }
      );
      
      if (patterns && patterns.length > 0) {
        console.log(`[WORKFLOW:PATTERNS] Found ${patterns.length} relevant patterns`);
        this.metrics.recordCacheHit("workflow_patterns");
      } else {
        this.metrics.recordCacheMiss("workflow_patterns");
      }
      
      this.metrics.endTimer("workflow_pattern_recall", true, { count: patterns?.length || 0 });
      
      return {
        ...state,
        memory_context: {
          ...state.memory_context,
          workflow_patterns: patterns
        }
      };
      
    } catch (error) {
      console.error("[WORKFLOW:PATTERNS] Error recalling patterns:", error);
      this.metrics.endTimer("workflow_pattern_recall", false, { error: error.message });
      // Continue without patterns
      return state;
    }
  }

  /**
   * Design workflow using best practices
   */
  async designAgentLed(state) {
    console.log("[WORKFLOW:DESIGN] Creating agent-led workflow");
    
    try {
      const domain = state.workflowDomain || "general business";
      const requirements = state.requirements || [];
      const patterns = state.memory_context?.workflow_patterns || [];
      
      const prompt = `
        Design a best-practice workflow for: ${domain}
        
        Requirements:
        ${requirements.map(r => `- ${r}`).join('\n')}
        
        ${patterns.length > 0 ? `
        Reference patterns from memory:
        ${patterns.map(p => p.content).join('\n')}
        ` : ''}
        
        Create a professional workflow with these constraints:
        - Maximum ${this.maxSteps} steps
        - Include compliance and quality checks
        - Focus on US/Canadian financial advisory best practices if applicable
        - Each step should have: name, description, type (task/decision/approval), duration
        
        Return JSON:
        {
          "name": "Workflow Name",
          "description": "Brief description",
          "steps": [
            {
              "name": "Step Name",
              "description": "What happens in this step",
              "type": "task|decision|approval",
              "duration": "estimated time",
              "assignee": "role or person"
            }
          ],
          "totalDuration": "estimated total time"
        }
      `;
      
      const response = await this.llm.invoke(prompt);
      let design = JSON.parse(response.content);
      
      // Store best practices if in hybrid mode
      if (state.guidanceMode === "hybrid") {
        return {
          ...state,
          bestPractices: design.steps
        };
      }
      
      console.log(`[WORKFLOW:DESIGN] Created workflow with ${design.steps.length} steps`);
      
      return {
        ...state,
        workflowDesign: design
      };
      
    } catch (error) {
      console.error("[WORKFLOW:DESIGN] Error designing workflow:", error);
      return {
        ...state,
        error: `Failed to design workflow: ${error.message}`
      };
    }
  }

  /**
   * Parse user-specified steps
   */
  async parseUserSteps(state) {
    console.log("[WORKFLOW:PARSE] Parsing user-specified steps");
    
    try {
      const lastMessage = state.messages?.[state.messages.length - 1];
      if (!lastMessage) {
        return {
          ...state,
          error: "No message to parse"
        };
      }
      
      const prompt = `
        Extract workflow steps from this user message:
        "${lastMessage.content}"
        
        Look for:
        - Numbered lists (1., 2., 3.)
        - Bullet points (-, *, •)
        - Sequential phrases ("first", "then", "next", "finally")
        - Action verbs indicating steps
        
        For each step, determine:
        - Name (brief title)
        - Description (what happens)
        - Type (task, decision, or approval)
        - Any mentioned assignee or duration
        
        Return JSON:
        {
          "extractedSteps": [
            {
              "name": "Step Name",
              "description": "Description",
              "type": "task|decision|approval",
              "duration": "if mentioned",
              "assignee": "if mentioned"
            }
          ],
          "workflowName": "inferred name or null",
          "workflowDescription": "inferred description or null"
        }
      `;
      
      const response = await this.llm.invoke(prompt);
      const parsed = JSON.parse(response.content);
      
      console.log(`[WORKFLOW:PARSE] Extracted ${parsed.extractedSteps.length} steps`);
      
      // Store for hybrid mode
      if (state.guidanceMode === "hybrid") {
        return {
          ...state,
          userSteps: parsed.extractedSteps
        };
      }
      
      // Create workflow design for user-specified mode
      return {
        ...state,
        workflowDesign: {
          name: parsed.workflowName || "Custom Workflow",
          description: parsed.workflowDescription || "User-defined workflow",
          steps: parsed.extractedSteps
        }
      };
      
    } catch (error) {
      console.error("[WORKFLOW:PARSE] Error parsing steps:", error);
      return {
        ...state,
        error: `Failed to parse steps: ${error.message}`
      };
    }
  }

  /**
   * Merge user steps with best practices
   */
  async mergeHybrid(state) {
    console.log("[WORKFLOW:MERGE] Merging user steps with best practices");
    
    try {
      const userSteps = state.userSteps || [];
      const bestPractices = state.bestPractices || [];
      
      const prompt = `
        Merge these user-defined steps with best practices:
        
        User Steps (preserve these):
        ${JSON.stringify(userSteps, null, 2)}
        
        Best Practice Steps (enhance with these):
        ${JSON.stringify(bestPractices, null, 2)}
        
        Rules:
        1. Keep all user steps in their original order
        2. Add missing best practice steps where appropriate
        3. Don't duplicate similar steps
        4. Add compliance/safety steps if missing
        5. Maximum ${this.maxSteps} total steps
        6. Mark which steps are user-defined vs added
        
        Return JSON:
        {
          "name": "Merged Workflow Name",
          "description": "Description",
          "steps": [
            {
              "name": "Step Name",
              "description": "Description",
              "type": "task|decision|approval",
              "duration": "time",
              "assignee": "role",
              "source": "user|bestpractice|merged"
            }
          ],
          "enhancements": ["list of enhancements made"]
        }
      `;
      
      const response = await this.llm.invoke(prompt);
      const merged = JSON.parse(response.content);
      
      console.log(`[WORKFLOW:MERGE] Merged to ${merged.steps.length} steps`);
      console.log("[WORKFLOW:MERGE] Enhancements:", merged.enhancements);
      
      return {
        ...state,
        workflowDesign: merged
      };
      
    } catch (error) {
      console.error("[WORKFLOW:MERGE] Error merging workflows:", error);
      return {
        ...state,
        error: `Failed to merge workflows: ${error.message}`
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
      if (!step.type || !['task', 'decision', 'approval'].includes(step.type)) {
        errors.push(`Step ${index + 1} has invalid type: ${step.type}`);
      }
    });
    
    // Check for required compliance steps (if financial domain)
    if (state.workflowDomain?.toLowerCase().includes('financial')) {
      const hasCompliance = design.steps?.some(s => 
        s.name?.toLowerCase().includes('compliance') ||
        s.name?.toLowerCase().includes('regulatory')
      );
      if (!hasCompliance) {
        console.log("[WORKFLOW:VALIDATE] Adding compliance step for financial workflow");
        // Auto-add compliance step
        design.steps.push({
          name: "Compliance Review",
          description: "Ensure regulatory compliance",
          type: "approval",
          duration: "1 day",
          assignee: "Compliance Officer",
          source: "bestpractice"
        });
      }
    }
    
    if (errors.length > 0) {
      console.log("[WORKFLOW:VALIDATE] Validation errors:", errors);
    } else {
      console.log("[WORKFLOW:VALIDATE] Validation passed");
    }
    
    return {
      ...state,
      validationErrors: errors,
      workflowDesign: design
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
          assignee: step.assignee,
          source: step.source // Shows if user-defined or added
        })),
        validationErrors: state.validationErrors,
        guidanceMode: state.guidanceMode,
        enhancements: design.enhancements
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
    if (design.steps?.length > 15) {
      preview.warnings.push(`Workflow has ${design.steps.length} steps (consider simplifying)`);
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
    
    try {
      // Increment refinement attempts
      const attempts = (state.refinementAttempts || 0) + 1;
      
      // Throw interrupt for approval
      throw interrupt({
        value: {
          type: "workflow_approval",
          message: `Please review the ${state.guidanceMode} workflow:`,
          previews: [state.preview],
          refinementAttempt: attempts,
          maxRefinements: this.maxRefinements
        }
      });
      
    } catch (error) {
      // If it's an interrupt, re-throw it
      if (error.name === "Interrupt") {
        throw error;
      }
      
      console.error("[WORKFLOW:APPROVAL] Error:", error);
      return {
        ...state,
        error: `Approval failed: ${error.message}`
      };
    }
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
      const workflowData = {
        name: design.name,
        description: design.description,
        type: "standard",
        status: "active"
      };
      
      const workflowResult = await this.errorHandler.executeWithRetry(
        async () => await createWorkflow(workflowData, passKey),
        {
          operation: "create_workflow",
          maxRetries: 2,
          circuitBreakerKey: "bsa_workflow"
        }
      );
      
      const workflowId = workflowResult.id || workflowResult.Id;
      console.log(`[WORKFLOW:CREATE] Created workflow ${workflowId}`);
      
      // Add steps
      if (design.steps?.length > 0) {
        const stepsResult = await this.errorHandler.executeWithRetry(
          async () => await addWorkflowSteps(workflowId, design.steps, passKey),
          {
            operation: "add_workflow_steps",
            maxRetries: 2,
            circuitBreakerKey: "bsa_workflow"
          }
        );
        
        console.log(`[WORKFLOW:CREATE] Added ${design.steps.length} steps`);
      }
      
      this.metrics.endTimer("workflow_creation", true, { 
        steps: design.steps?.length || 0 
      });
      
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
   * Link contacts to workflow if any
   */
  async linkContacts(state, config) {
    console.log("[WORKFLOW:LINK] Checking for contacts to link");
    
    if (!state.workflowId || !state.entities) {
      return state;
    }
    
    try {
      const passKey = await config.configurable.getPassKey();
      
      // Find contact entities
      const contactIds = [];
      for (const [key, entity] of Object.entries(state.entities)) {
        if (entity.type === "contact" && entity.data?.id) {
          contactIds.push(entity.data.id);
        }
      }
      
      if (contactIds.length > 0) {
        console.log(`[WORKFLOW:LINK] Linking ${contactIds.length} contacts`);
        
        const result = await this.contactLinker.linkMultipleContacts(
          "workflow",
          state.workflowId,
          contactIds,
          passKey
        );
        
        console.log(`[WORKFLOW:LINK] Linked ${result.successful} contacts`);
      }
      
      return state;
      
    } catch (error) {
      console.error("[WORKFLOW:LINK] Error linking contacts:", error);
      // Continue without linking
      return state;
    }
  }

  /**
   * Store successful workflow pattern in memory
   */
  async synthesizeMemory(state) {
    console.log("[WORKFLOW:MEMORY] Synthesizing workflow memory");
    
    if (!state.workflowId || !state.workflowDesign || !this.mem0.client) {
      return state;
    }
    
    try {
      const orgId = state.org_id || "default-org";
      const userId = state.user_id || "default-user";
      
      // Create memory content
      const memoryContent = `
        Created ${state.guidanceMode} workflow: ${state.workflowDesign.name}
        Domain: ${state.workflowDomain}
        Steps: ${state.workflowDesign.steps?.map(s => s.name).join(', ')}
        Total steps: ${state.workflowDesign.steps?.length}
      `;
      
      await this.mem0.synthesize(
        memoryContent,
        orgId,
        userId,
        {
          type: "workflow_pattern",
          domain: state.workflowDomain,
          guidanceMode: state.guidanceMode,
          stepCount: state.workflowDesign.steps?.length
        }
      );
      
      console.log("[WORKFLOW:MEMORY] Pattern stored in memory");
      
      return state;
      
    } catch (error) {
      console.error("[WORKFLOW:MEMORY] Error synthesizing memory:", error);
      // Continue without storing
      return state;
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
    
    if (state.workflowId) {
      const design = state.workflowDesign;
      return {
        ...state,
        response: `Successfully created ${state.guidanceMode} workflow "${design.name}" with ${design.steps?.length || 0} steps. Workflow ID: ${state.workflowId}`
      };
    }
    
    if (!state.approved && state.refinementAttempts >= this.maxRefinements) {
      return {
        ...state,
        response: "Workflow creation cancelled after maximum refinement attempts"
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
      user_id: context.user_id
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