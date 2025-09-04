// Workflow Builder Agent Module for BSA Integration
// Enables creation and management of automated workflows/processes
// Supports natural language workflow descriptions

// Workflow Builder Agent Prompt Template
const WORKFLOW_BUILDER_PROMPT = `You are an intelligent workflow automation assistant that helps create and manage business processes.

You help users:
1. Create new automated workflows/processes
2. Add sequential steps to workflows  
3. List existing workflows
4. View workflow steps and details
5. Build complete workflows from natural language descriptions

WORKFLOW STRUCTURE:
- Each workflow has a process shell (container) with name and description
- Steps are added sequentially to the process with:
  - Subject: Brief title
  - Description: Detailed instructions
  - ActivityType: "Task" or "Appointment" 
  - Sequence: Order number (1, 2, 3...)
  - DayOffset: Days allocated for completion
  - AssigneeType: "ContactsOwner" (advisor) or "ContactsOwnersAssistant"
  - RollOver: Whether incomplete steps move to next day

NATURAL LANGUAGE PARSING:
When users describe workflows, extract:
- Process name and overall description
- Individual steps with their properties
- Assignment logic (who should do what)
- Timeline (how many days for each step)
- Task vs Appointment determination

ACTIVITY TYPE RULES:
- "Send", "prepare", "review", "complete", "fill out" → Task
- "Meeting", "appointment", "call", "consultation" → Appointment
- Default to Task when unclear

ASSIGNEE RULES:
- "Assistant" mentioned → ContactsOwnersAssistant
- "Advisor", "owner", "senior" → ContactsOwner
- Default to ContactsOwner when unclear

TIMELINE RULES:
- "Same day", "immediately" → DayOffset: 0
- "Next day", "tomorrow" → DayOffset: 1
- "Within X days" → DayOffset: X
- Default to 1 day when unclear

TOOLS AVAILABLE (5 total):
1. create_process - Creates a new workflow process shell
2. add_process_step - Adds a single step to an existing process
3. list_processes - Lists all workflows in the organization
4. get_process_steps - Gets all steps for a specific process
5. build_complete_workflow - Orchestrates creation of complete workflow from description

IMPORTANT OUTPUT FORMATTING:
- Use clean, well-structured markdown
- Use ## for workflow names
- Use numbered lists for steps
- Show step assignments and timelines clearly
- Confirm successful creation with process ID

When building workflows:
1. First create the process shell
2. Add steps sequentially with proper Sequence numbers
3. Verify all steps were added successfully
4. Return the complete workflow structure`;

// Create a new process shell in BSA
async function createProcess(passKey, orgId, name, description, dependencies) {
  const { axios, axiosConfig, BSA_BASE, normalizeBSAResponse } = dependencies;
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process",
    DataObject: {
      Name: name,
      Description: description
    },
    IncludeExtendedProperties: false
  };

  console.log("[Workflow] Creating process:", name);
  
  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);
  
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Failed to create process');
  }
  
  const processData = normalized.data?.[0]?.DataObject || normalized.data?.DataObject;
  if (!processData?.Id) {
    throw new Error('No process ID returned');
  }
  
  return {
    id: processData.Id,
    name: processData.Name,
    description: processData.Description,
    createdOn: processData.CreatedOn,
    valid: true
  };
}

// Add a step to an existing process
async function addProcessStep(passKey, orgId, processId, stepData, dependencies) {
  const { axios, axiosConfig, BSA_BASE, normalizeBSAResponse } = dependencies;
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;

  // Generate default times for the step (9 AM - 10 AM in UTC)
  const now = new Date();
  const startTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
  const endTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0));

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process_template",
    DataObject: {
      AdvocateProcessId: processId,
      Subject: stepData.subject,
      Description: stepData.description || "",
      ActivityType: stepData.activityType || "Task",
      AppointmentTypeId: stepData.appointmentTypeId || null,
      Sequence: stepData.sequence,
      DayOffset: stepData.dayOffset || 1,
      StartTime: stepData.startTime || startTime.toISOString(),
      EndTime: stepData.endTime || endTime.toISOString(),
      AllDay: stepData.allDay !== false,
      AssigneeType: stepData.assigneeType || "ContactsOwner",
      AssigneeId: stepData.assigneeId || null,
      RollOver: stepData.rollOver !== false,
      Location: stepData.location || null
    },
    IncludeExtendedProperties: false
  };

  console.log("[Workflow] Adding step:", stepData.sequence, "-", stepData.subject);
  
  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);
  
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Failed to add process step');
  }
  
  const stepResponse = normalized.data?.[0]?.DataObject || normalized.data?.DataObject;
  
  return {
    id: stepResponse.Id,
    sequence: stepResponse.Sequence,
    subject: stepResponse.Subject,
    activityType: stepResponse.ActivityType,
    valid: true
  };
}

// List all processes in the organization
async function listProcesses(passKey, orgId, dependencies) {
  const { axios, axiosConfig, BSA_BASE, normalizeBSAResponse } = dependencies;
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json`;

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process"
  };

  console.log("[Workflow] Listing all processes");
  
  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);
  
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Failed to list processes');
  }
  
  const results = normalized.data?.Results || [];
  
  return {
    processes: results.map(p => ({
      id: p.Id,
      name: p.Name,
      description: p.Description,
      createdOn: p.CreatedOn,
      modifiedOn: p.ModifiedOn
    })),
    count: results.length,
    valid: true
  };
}

// Get all steps for a specific process
async function getProcessSteps(passKey, orgId, processId, dependencies) {
  const { axios, axiosConfig, BSA_BASE, normalizeBSAResponse } = dependencies;
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json`;

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process_template",
    ParentObjectName: "advocate_process",
    ParentId: processId
  };

  console.log("[Workflow] Getting steps for process:", processId);
  
  const resp = await axios.post(url, payload, axiosConfig);
  const normalized = normalizeBSAResponse(resp.data);
  
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Failed to get process steps');
  }
  
  const results = normalized.data?.Results || [];
  
  // Sort by sequence number
  results.sort((a, b) => (a.Sequence || 0) - (b.Sequence || 0));
  
  return {
    steps: results.map(s => ({
      id: s.Id,
      sequence: s.Sequence,
      subject: s.Subject,
      description: s.Description,
      activityType: s.ActivityType,
      dayOffset: s.DayOffset,
      assigneeType: s.AssigneeType,
      rollOver: s.RollOver,
      allDay: s.AllDay
    })),
    count: results.length,
    processId: processId,
    valid: true
  };
}

// Parse natural language workflow description into structured steps
function parseWorkflowDescription(description) {
  // Extract process name and description
  const lines = description.split('\n').filter(l => l.trim());
  let processName = "New Workflow";
  let processDescription = description;
  let steps = [];
  
  // Try to find a clear process name
  const namePatterns = [
    /create (?:a |an )?(?:new )?(?:workflow|process) (?:for|called|named) ["']?([^"']+)["']?/i,
    /["']([^"']+)["'] (?:workflow|process)/i,
    /(?:workflow|process):?\s*["']?([^"'\n]+)["']?/i
  ];
  
  for (const pattern of namePatterns) {
    const match = description.match(pattern);
    if (match) {
      processName = match[1].trim();
      break;
    }
  }
  
  // Look for numbered steps
  const stepPatterns = [
    /(?:step )?(\d+)\.?\s*:?\s*(.+)/gi,
    /(?:then|next|after that),?\s+(.+)/gi,
    /-\s+(.+)/g  // Bullet points
  ];
  
  // First try numbered steps
  const numberedSteps = [...description.matchAll(/(?:step )?(\d+)\.?\s*:?\s*(.+)/gi)];
  if (numberedSteps.length > 0) {
    steps = numberedSteps.map((match, idx) => {
      const stepText = match[2].trim();
      return parseStepText(stepText, idx + 1);
    });
  } else {
    // Try bullet points
    const bulletSteps = [...description.matchAll(/-\s+(.+)/g)];
    if (bulletSteps.length > 0) {
      steps = bulletSteps.map((match, idx) => {
        const stepText = match[1].trim();
        return parseStepText(stepText, idx + 1);
      });
    } else {
      // Try sequential keywords
      const sequentialSteps = [...description.matchAll(/(?:then|next|after that|first|second|third|finally),?\s+(.+)/gi)];
      if (sequentialSteps.length > 0) {
        steps = sequentialSteps.map((match, idx) => {
          const stepText = match[1].trim();
          return parseStepText(stepText, idx + 1);
        });
      }
    }
  }
  
  // If no steps found, create a single step
  if (steps.length === 0) {
    steps = [{
      sequence: 1,
      subject: "Complete workflow",
      description: description,
      activityType: "Task",
      dayOffset: 1,
      assigneeType: "ContactsOwner",
      rollOver: true
    }];
  }
  
  return {
    processName,
    processDescription,
    steps
  };
}

// Parse individual step text into structured data
function parseStepText(text, sequence) {
  // Determine activity type
  const taskKeywords = /send|prepare|review|complete|fill|create|write|analyze|document|email|submit/i;
  const appointmentKeywords = /meeting|appointment|call|consultation|conference|presentation|interview/i;
  
  const activityType = appointmentKeywords.test(text) ? "Appointment" : "Task";
  
  // Determine assignee
  const assistantKeywords = /assistant|secretary|admin|support/i;
  const assigneeType = assistantKeywords.test(text) ? "ContactsOwnersAssistant" : "ContactsOwner";
  
  // Extract day offset
  let dayOffset = 1;
  const dayPatterns = [
    /within (\d+) days?/i,
    /(\d+) days? to/i,
    /takes? (\d+) days?/i,
    /(\d+) days? deadline/i
  ];
  
  for (const pattern of dayPatterns) {
    const match = text.match(pattern);
    if (match) {
      dayOffset = parseInt(match[1], 10);
      break;
    }
  }
  
  if (/same day|immediately|today|urgent/i.test(text)) {
    dayOffset = 0;
  } else if (/next day|tomorrow/i.test(text)) {
    dayOffset = 1;
  } else if (/week/i.test(text)) {
    dayOffset = 7;
  }
  
  // Extract subject (first part of text up to punctuation or keyword)
  let subject = text;
  const subjectMatch = text.match(/^([^,.:\-]+)/);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
  }
  
  // Limit subject length
  if (subject.length > 100) {
    subject = subject.substring(0, 97) + "...";
  }
  
  return {
    sequence,
    subject,
    description: text,
    activityType,
    dayOffset,
    assigneeType,
    rollOver: true,
    allDay: activityType === "Task"
  };
}

// Define Workflow Builder Tools using tool function with Zod
function createWorkflowTools(tool, z, passKey, orgId, dependencies) {
  return [
    // Tool 1: Create a new process
    tool(
      async ({ name, description }) => {
        try {
          const result = await createProcess(passKey, orgId, name, description, dependencies);
          return JSON.stringify({
            success: true,
            processId: result.id,
            name: result.name,
            description: result.description,
            message: `Process "${result.name}" created successfully with ID: ${result.id}`
          });
        } catch (error) {
          console.error("[Workflow Tool] Error creating process:", error);
          return JSON.stringify({ 
            success: false,
            error: `Failed to create process: ${error.message}` 
          });
        }
      },
      {
        name: "create_process",
        description: "Create a new workflow process shell/container. Returns the process ID needed for adding steps.",
        schema: z.object({
          name: z.string().describe("Name of the workflow process"),
          description: z.string().describe("Detailed description of what this workflow does")
        })
      }
    ),
    
    // Tool 2: Add a step to a process
    tool(
      async ({ processId, subject, description, activityType, sequence, dayOffset, assigneeType, rollOver }) => {
        try {
          const stepData = {
            subject,
            description: description || subject,
            activityType: activityType || "Task",
            sequence,
            dayOffset: dayOffset || 1,
            assigneeType: assigneeType || "ContactsOwner",
            rollOver: rollOver !== false,
            allDay: activityType !== "Appointment"
          };
          
          const result = await addProcessStep(passKey, orgId, processId, stepData, dependencies);
          return JSON.stringify({
            success: true,
            stepId: result.id,
            sequence: result.sequence,
            subject: result.subject,
            message: `Step ${result.sequence}: "${result.subject}" added successfully`
          });
        } catch (error) {
          console.error("[Workflow Tool] Error adding step:", error);
          return JSON.stringify({ 
            success: false,
            error: `Failed to add step: ${error.message}` 
          });
        }
      },
      {
        name: "add_process_step",
        description: "Add a single step to an existing workflow process. Steps must be added sequentially.",
        schema: z.object({
          processId: z.string().describe("The process ID to add the step to"),
          subject: z.string().describe("Brief title for this step"),
          description: z.string().optional().describe("Detailed description of what needs to be done"),
          activityType: z.enum(["Task", "Appointment"]).optional().describe("Type of activity (default: Task)"),
          sequence: z.number().describe("Order number of this step (1, 2, 3, etc.)"),
          dayOffset: z.number().optional().describe("Days allocated for this step (default: 1)"),
          assigneeType: z.enum(["ContactsOwner", "ContactsOwnersAssistant"]).optional().describe("Who should do this step"),
          rollOver: z.boolean().optional().describe("Should incomplete steps move to next day (default: true)")
        })
      }
    ),
    
    // Tool 3: List all processes
    tool(
      async () => {
        try {
          const result = await listProcesses(passKey, orgId, dependencies);
          return JSON.stringify({
            success: true,
            processes: result.processes,
            count: result.count,
            message: `Found ${result.count} workflow process(es)`
          });
        } catch (error) {
          console.error("[Workflow Tool] Error listing processes:", error);
          return JSON.stringify({ 
            success: false,
            error: `Failed to list processes: ${error.message}`,
            processes: [],
            count: 0
          });
        }
      },
      {
        name: "list_processes",
        description: "List all workflow processes in the organization",
        schema: z.object({})
      }
    ),
    
    // Tool 4: Get process steps
    tool(
      async ({ processId }) => {
        try {
          const result = await getProcessSteps(passKey, orgId, processId, dependencies);
          return JSON.stringify({
            success: true,
            processId: result.processId,
            steps: result.steps,
            count: result.count,
            message: `Retrieved ${result.count} step(s) for process`
          });
        } catch (error) {
          console.error("[Workflow Tool] Error getting steps:", error);
          return JSON.stringify({ 
            success: false,
            error: `Failed to get process steps: ${error.message}`,
            steps: [],
            count: 0
          });
        }
      },
      {
        name: "get_process_steps",
        description: "Get all steps for a specific workflow process, sorted by sequence",
        schema: z.object({
          processId: z.string().describe("The process ID to get steps for")
        })
      }
    ),
    
    // Tool 5: Build complete workflow from description
    tool(
      async ({ workflowDescription }) => {
        try {
          // Parse the natural language description
          const parsed = parseWorkflowDescription(workflowDescription);
          
          console.log("[Workflow Tool] Parsed workflow:", {
            name: parsed.processName,
            steps: parsed.steps.length
          });
          
          // Create the process shell
          const process = await createProcess(
            passKey, 
            orgId, 
            parsed.processName, 
            parsed.processDescription, 
            dependencies
          );
          
          // Add each step sequentially
          const addedSteps = [];
          for (const step of parsed.steps) {
            try {
              const result = await addProcessStep(passKey, orgId, process.id, step, dependencies);
              addedSteps.push({
                sequence: step.sequence,
                subject: step.subject,
                success: true
              });
            } catch (stepError) {
              console.error(`[Workflow Tool] Failed to add step ${step.sequence}:`, stepError);
              addedSteps.push({
                sequence: step.sequence,
                subject: step.subject,
                success: false,
                error: stepError.message
              });
            }
          }
          
          return JSON.stringify({
            success: true,
            processId: process.id,
            processName: process.name,
            processDescription: process.description,
            stepsAdded: addedSteps.filter(s => s.success).length,
            totalSteps: parsed.steps.length,
            steps: addedSteps,
            message: `Workflow "${process.name}" created with ${addedSteps.filter(s => s.success).length} of ${parsed.steps.length} steps`
          });
          
        } catch (error) {
          console.error("[Workflow Tool] Error building workflow:", error);
          return JSON.stringify({ 
            success: false,
            error: `Failed to build workflow: ${error.message}` 
          });
        }
      },
      {
        name: "build_complete_workflow",
        description: "Build a complete workflow from a natural language description. This will create the process and add all steps automatically.",
        schema: z.object({
          workflowDescription: z.string().describe("Natural language description of the workflow including process name and steps")
        })
      }
    )
  ];
}

// Create Workflow Builder Agent
async function createWorkflowBuilderAgent(passKey, orgId, dependencies) {
  const { getLLMClient } = dependencies;
  
  // Dynamic imports for LangChain and Zod
  const { z } = await import("zod");
  const { tool } = await import("@langchain/core/tools");
  const { AgentExecutor, createToolCallingAgent } = await import("langchain/agents");
  const { ChatPromptTemplate, MessagesPlaceholder } = await import("@langchain/core/prompts");
  
  // Use cached LLM client for better performance
  const llm = await getLLMClient();
  
  const tools = createWorkflowTools(tool, z, passKey, orgId, dependencies);
  
  console.log("[Workflow Agent] Initialized with", tools.length, "tools");
  
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", WORKFLOW_BUILDER_PROMPT],
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad")
  ]);
  
  const agent = createToolCallingAgent({
    llm,
    tools,
    prompt
  });
  
  // Configure executor with LangSmith tracing if available
  const executorConfig = {
    agent,
    tools,
    verbose: false
  };
  
  // Add LangSmith metadata if tracing is enabled
  if (process.env.LANGCHAIN_TRACING_V2 === 'true') {
    executorConfig.tags = ['agent:workflow', `org:${orgId}`];
    executorConfig.metadata = {
      agent: 'workflow_builder',
      orgId
    };
  }
  
  return new AgentExecutor(executorConfig);
}

// Create Workflow Node for LangGraph integration
async function createWorkflowNode(passKey, orgId, dependencies) {
  return async (state) => {
    // Extract the user query from state
    const messages = state.messages || [];
    const userMessage = messages.find(m => m.role === 'user' || m.type === 'human');
    
    if (!userMessage) {
      return {
        messages: [...messages, {
          role: "assistant",
          content: "No user query found for workflow agent",
          metadata: { agent: "workflow", error: true }
        }],
        next: "__end__"
      };
    }
    
    const query = typeof userMessage === 'string' ? userMessage : userMessage.content;
    
    try {
      // Create and invoke the workflow agent
      const agent = await createWorkflowBuilderAgent(passKey, orgId, dependencies);
      const result = await agent.invoke({ input: query });
      
      // Add the response to state
      return {
        messages: [...messages, {
          role: "assistant",
          content: result.output,
          metadata: { agent: "workflow" }
        }],
        next: "__end__"
      };
    } catch (error) {
      console.error("[Workflow Node] Error:", error);
      return {
        messages: [...messages, {
          role: "assistant",
          content: `Error in workflow agent: ${error.message}`,
          metadata: { agent: "workflow", error: true }
        }],
        next: "__end__"
      };
    }
  };
}

// Module exports
module.exports = {
  createWorkflowBuilderAgent,
  createWorkflowNode,
  createWorkflowTools,
  createProcess,
  addProcessStep,
  listProcesses,
  getProcessSteps,
  parseWorkflowDescription,
  WORKFLOW_BUILDER_PROMPT
};