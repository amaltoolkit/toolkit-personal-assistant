# Domain Subgraph Architecture - Implementation Plan

## Executive Summary
Migrate from complex orchestrator to domain-based subgraphs with lightweight coordination. Each domain (Calendar, Tasks, Workflows) becomes a specialized subgraph with its own micro-DAG, while a simple Coordinator routes and composes multi-domain requests.

**CRITICAL: Dual-System Architecture**
This architecture uses TWO COMPLEMENTARY SYSTEMS that work together:
1. **PostgreSQL Checkpointer (PostgresSaver)** - PERMANENT, NEVER REMOVED - Handles all conversation state and graph execution
2. **Mem0 Cloud Service** - NEW ADDITION - Handles intelligent memory extraction and recall

These are NOT replacements for each other. The PostgreSQL checkpointer remains the backbone of our state management and will never be removed. Mem0 only replaces our custom memory implementation (UnifiedStore/PgMemoryStore), NOT our state persistence.

## Architecture Overview

```
User Query → Coordinator Graph
    ├→ Memory Recall
    ├→ Router (classify domains)
    ├→ Run Subagents
    │   ├→ CalendarSubagent (subgraph)
    │   ├→ WorkflowSubagent (subgraph)
    │   └→ TaskSubagent (subgraph)
    └→ Finalizer (conversational response)
```

## Phase 1: Analysis & Asset Inventory

### What to KEEP (High Value):
1. **BSA Integration Logic**
   - All API calls from activitiesAgent.js
   - All API calls from workflowBuilderAgent.js
   - Natural language date parsing
   - BSA response normalization

2. **Memory System (Mem0 Cloud)**
   - Mem0 Cloud API - Unified memory layer
   - Recall mechanism - Via Mem0Service in Coordinator
   - Synthesis - Via Mem0Service.add() in each subagent
   - Automatic deduplication and extraction
   - 90% token reduction, 26% better accuracy

3. **Core Tools**
   - Extract and modularize from existing agents
   - Contact enrichment logic
   - Date parsing utilities
   - Authentication/session management

### What to TRANSFORM:
1. **Activities Agent** → Split into:
   - CalendarSubagent (appointments)
   - TaskSubagent (tasks/todos)
   - ContactResolver (shared service)

2. **Workflow Agent** → Becomes:
   - WorkflowSubagent with micro-DAG
   - Preserves domain expertise

3. **Memory Operations** → Unified via Mem0:
   - Recall → Coordinator uses Mem0Service.search()
   - Synthesis → Each subagent calls Mem0Service.add()
   - Single service, no duplication

### What to DELETE/ARCHIVE:
1. **Complex Orchestration**
   - `/api/graph/orchestrator.js` → Archive
   - `/api/graph/plan.js` → Archive (keep simple planning)
   - `/api/graph/parallel.js` → Archive
   - `/api/graph/intent.js` → Simplify to router

2. **Designer/Applier Pattern**
   - Merge into subagent nodes
   - Keep logic, remove separation

## Phase 2: Core Components Implementation

### 1. Coordinator Graph (`/api/coordinator/index.js`)
```javascript
const CoordinatorState = {
  messages: [],
  domains: [],        // ["calendar", "tasks", "workflows"]
  compose: "",        // "sequential" | "parallel"
  memory_context: {}, // From recall
  subagent_results: {},
  approvals: {},
  final_response: ""
};

// LLM-first router - NO PATTERN MATCHING
async function routerNode(state, config) {
  const query = state.messages[0].content;
  
  try {
    // Always use LLM for intelligent classification
    const llm = new ChatOpenAI({ 
      model: 'gpt-4o-mini',
      temperature: 0
    });
    
    // Single comprehensive prompt for domain and dependency detection
    const routerPrompt = `
Analyze this query and determine:
1. Which domains are needed (calendar, tasks, workflows)
2. If there are dependencies between actions
3. If sequential execution is required

Query: "${query}"

Rules:
- Calendar: appointments, meetings, events, scheduling
- Tasks: todos, reminders, action items, reviews
- Workflows: processes, templates, multi-step procedures

Return JSON only:
{
  "domains": ["domain1", "domain2"],
  "compose": "sequential" | "parallel",
  "needsPlanning": true/false,
  "reasoning": "brief explanation"
}
`;

    const response = await llm.invoke(routerPrompt);
    const result = JSON.parse(response.content);
    
    console.log(`[ROUTER] LLM Classification: ${JSON.stringify(result)}`);
    
    return {
      domains: result.domains || [],
      compose: result.compose || "parallel",
      needsPlanning: result.needsPlanning || false
    };
    
  } catch (error) {
    // Fallback to safe default if LLM fails
    console.error('[ROUTER] LLM classification failed:', error);
    return {
      domains: ["calendar"], // Safe default
      compose: "parallel",
      needsPlanning: false
    };
  }
}
```

### 1.5. Lightweight Planner (When Needed)

When the router detects sequential dependencies between multiple domains, a lightweight planner creates a query-specific execution plan:

```javascript
// Coordinator Graph with conditional planning
const CoordinatorGraph = new StateGraph(CoordinatorState)
  .addNode("recall_memory", recallMemoryNode)
  .addNode("router", routerNode)
  .addNode("planner", lightweightPlannerNode)  // Only for complex multi-domain
  .addNode("executor", executorNode)
  .addNode("finalizer", finalizerNode)
  .addEdge(START, "recall_memory")
  .addEdge("recall_memory", "router")
  .addConditionalEdges("router", (state) => {
    if (state.needsPlanning) {
      return "planner";  // Multi-domain with dependencies
    }
    return "executor";    // Simple or parallel execution
  })
  .addEdge("planner", "executor")
  .addEdge("executor", "finalizer")
  .addEdge("finalizer", END)
  .compile();

// Lightweight planner - NOT a complex DAG builder
async function lightweightPlannerNode(state) {
  const { domains, messages } = state;
  const query = messages[0].content;
  
  // Use small LLM to understand query-specific dependencies
  const planPrompt = `
    User query: "${query}"
    Detected domains: ${domains.join(", ")}
    
    Create a simple execution plan identifying:
    1. Order of operations (what must happen first?)
    2. Data dependencies (what info from step 1 does step 2 need?)
    3. Can anything run in parallel?
    
    Example for "Create a financial planning workflow and then create a task to review it tomorrow at 9am":
    {
      "steps": [
        {
          "domain": "workflows",
          "extractQuery": "financial planning workflow",
          "outputs_needed": ["workflowId", "name"]
        },
        {
          "domain": "tasks", 
          "extractQuery": "review task tomorrow 9am",
          "inputs_from_previous": {
            "title": "Review {name}",
            "linkedTo": "{workflowId}"
          },
          "depends_on": 0
        }
      ]
    }
    
    Return only JSON.
  `;
  
  const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
  const plan = await llm.invoke(planPrompt);
  
  return {
    executionPlan: JSON.parse(plan.content)
  };
}

// Executor follows the plan
async function executorNode(state) {
  const { executionPlan, domains } = state;
  
  // No plan = simple/parallel execution
  if (!executionPlan) {
    if (domains.length === 1) {
      // Single domain - direct execution
      const result = await subgraphs[domains[0]].invoke(state);
      return { subagent_results: { [domains[0]]: result } };
    }
    // Parallel execution for independent domains
    return parallelExecute(domains, state);
  }
  
  // Has plan = follow sequential execution with context passing
  const results = {};
  const context = { memory: state.memory_context };
  
  for (const step of executionPlan.steps) {
    // Build input with accumulated context
    let input = {
      query: step.extractQuery || state.messages[0].content,
      context
    };
    
    // Inject dependencies from previous steps
    if (step.inputs_from_previous) {
      // Replace {placeholder} with actual values from context
      const injected = {};
      for (const [key, template] of Object.entries(step.inputs_from_previous)) {
        injected[key] = template.replace(/{(\w+)}/g, (_, k) => context[k] || "");
      }
      input.context = { ...context, ...injected };
    }
    
    // Execute subagent
    const result = await subgraphs[step.domain].invoke(input);
    
    // Extract outputs for next steps
    if (step.outputs_needed) {
      step.outputs_needed.forEach(key => {
        context[key] = result[key];
      });
    }
    
    results[step.domain] = result;
  }
  
  return { subagent_results: results };
}
```

**Key Differences from Old Complex Planner:**
- **Query-specific**: Adapts to user's exact request, not generic patterns
- **Lightweight**: ~20 lines vs 200+ lines of planning logic
- **Domain-level**: Plans which subagent to call, not individual API operations
- **Simple dependencies**: Just tracks data flow between subagents
- **Only when needed**: Single domain or parallel queries skip planning entirely

### 2. Domain Subgraphs

#### Enhanced State Definitions with Refinement Support

```javascript
// Base state that all subgraphs inherit
const BaseSubgraphState = {
  query: "",                    // Original or refined query
  preview: null,                // Generated preview for approval
  approval: null,               // User's decision
  approvalContext: {
    isRefinement: false,        // Is this a refinement attempt?
    previousPreview: null,      // What was shown before
    refinementInstructions: "", // User's specific feedback
    attemptCount: 0,            // Prevent infinite loops
    refinementHistory: []       // Track all attempts
  }
};

// CalendarState with refinement tracking
const CalendarState = Annotation.Root({
  ...BaseSubgraphState,
  dateRange: Annotation({ reducer: (old, new_) => new_ }),
  contactId: Annotation({ reducer: (old, new_) => new_ }),
  appointment: Annotation({ reducer: (old, new_) => new_ }),
  approvalContext: Annotation({ 
    reducer: (old, new_) => ({ ...old, ...new_ }),
    default: () => ({
      isRefinement: false,
      previousPreview: null,
      refinementInstructions: null,
      attemptCount: 0,
      refinementHistory: []
    })
  })
});
```

#### CalendarSubagent (`/api/subagents/calendar/index.js`)
```javascript
// Micro-DAG for calendar operations with refinement support
const CalendarSubgraph = new StateGraph(CalendarState)
  .addNode("slot_fill", slotFillAppointment)      // Parse time, subject
  .addNode("resolve_contact", resolveContactNode)  // Uses ContactResolver service
  .addNode("check_conflicts", checkConflicts)      // Optional
  .addNode("generate_preview", generatePreview)    // Create preview
  .addNode("approval", approvalNode)               // Handle approve/reject/refine
  .addNode("create", createAppointment)            // BSA API
  .addNode("link", linkToContactNode)              // Uses ContactResolver.linkActivity()
  .addNode("synthesize", synthesizeMemory)         // Uses Mem0Service.add()
  .addEdge(START, "slot_fill")
  .addConditionalEdges("slot_fill", needsContact)
  .addEdge("resolve_contact", "check_conflicts")
  .addEdge("check_conflicts", "generate_preview")
  .addEdge("generate_preview", "approval")
  .addConditionalEdges("approval", (state) => {
    if (state.approval === "reject_with_refinement") {
      return "slot_fill"; // Re-run with refinement
    }
    if (state.approval === "approve") {
      return "create";
    }
    return END; // Simple rejection
  })
  .addEdge("create", "link")
  .addEdge("link", "synthesize")
  .addEdge("synthesize", END)
  .compile();

// Node implementation example using shared service
async function resolveContactNode(state, config) {
  const { query } = state;
  const contactResolver = new ContactResolver(config.passKey);
  
  // Use shared service for search and disambiguation
  const candidates = await contactResolver.search(query);
  const selected = await contactResolver.disambiguate(candidates, state.context);
  
  return {
    contactId: selected.id,
    contactName: selected.name,
    contactEmail: selected.email
  };
}

async function linkToContactNode(state, config) {
  const { appointment, contactId } = state;
  const contactResolver = new ContactResolver(config.passKey);
  
  // Use shared service for linking
  await contactResolver.linkActivity('appointment', appointment.id, contactId);
  
  return { linked: true };
}

// Thin wrapper for memory synthesis - used by all subgraphs
async function synthesizeMemory(state, config) {
  const { getMem0Service } = require('../services/mem0Service');
  const mem0 = getMem0Service();
  
  // Build conversation from state
  const messages = [
    { role: "user", content: state.query },
    { role: "assistant", content: `Created appointment: ${state.appointment.subject}` }
  ];
  
  // Mem0 automatically extracts what's important
  await mem0.synthesize(
    messages,
    config.configurable.orgId,
    config.configurable.userId,
    {
      domain: "calendar",
      action: "appointment_created",
      appointmentId: state.appointment.id
    }
  );
  
  return {}; // No state changes needed
}
```

#### WorkflowSubagent (`/api/subagents/workflow/index.js`)

**CRITICAL: Workflow Spectrum Support**
The WorkflowSubagent must handle three distinct modes based on user intent:
1. **Agent-Led Mode**: Full creative control using best practices
2. **User-Specified Mode**: Exact steps provided by user
3. **Hybrid Mode**: Combination of best practices + user's internal processes

```javascript
// Enhanced Micro-DAG for workflow operations with spectrum support
const WorkflowSubgraph = new StateGraph(WorkflowState)
  .addNode("detect_guidance", detectWorkflowGuidance)    // NEW: Classify user intent
  .addNode("recall_patterns", recallWorkflowPatterns)    // Mem0 patterns
  .addNode("design_agent_led", designWithBestPractices)  // Full agent control
  .addNode("parse_user_steps", parseExplicitSteps)       // User-specified steps
  .addNode("merge_hybrid", mergeHybridApproach)          // Combine both
  .addNode("validate_spec", validateWorkflowSpec)        // Ensure compliance & limits
  .addNode("preview", generatePreview)
  .addNode("approval", approvalNode)
  .addNode("create_shell", createAdvocateProcess)
  .addNode("add_steps", addProcessTemplateSteps)
  .addNode("synthesize", synthesizeMemory)               // Uses Mem0Service.add()
  
  // Entry point
  .addEdge(START, "detect_guidance")
  .addEdge("detect_guidance", "recall_patterns")
  
  // Conditional routing based on guidance mode
  .addConditionalEdges("recall_patterns", (state) => {
    switch(state.guidanceMode) {
      case "agent_led": return "design_agent_led";
      case "user_specified": return "parse_user_steps";
      case "hybrid": return "merge_hybrid";
      default: return "design_agent_led";
    }
  })
  
  // All paths converge at validation
  .addEdge("design_agent_led", "validate_spec")
  .addEdge("parse_user_steps", "validate_spec")
  .addEdge("merge_hybrid", "validate_spec")
  
  // Standard approval flow
  .addEdge("validate_spec", "preview")
  .addEdge("preview", "approval")
  .addEdge("approval", "create_shell")
  .addEdge("create_shell", "add_steps")
  .addEdge("add_steps", "synthesize")
  .addEdge("synthesize", END)
  .compile();

// Guidance detection node
async function detectWorkflowGuidance(state, config) {
  const { query } = state;
  const llm = new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0 });
  
  const prompt = `
    Analyze this workflow request and determine the user's guidance preference:
    
    Query: "${query}"
    
    Classify as:
    - "agent_led": User wants best practices (e.g., "create a financial planning workflow")
    - "user_specified": User provides exact steps (e.g., numbered list, bullet points)
    - "hybrid": Mix of both (e.g., "use best practices but include our compliance check")
    
    Also extract:
    - Any explicit steps mentioned
    - Domain context (financial, onboarding, etc.)
    - Special requirements or constraints
    
    Return JSON only.
  `;
  
  const response = await llm.invoke(prompt);
  const analysis = JSON.parse(response.content);
  
  return {
    guidanceMode: analysis.mode,
    extractedSteps: analysis.steps || [],
    domainContext: analysis.domain,
    constraints: analysis.constraints
  };
}

// Hybrid merger for combining approaches
async function mergeHybridApproach(state, config) {
  const { extractedSteps, domainContext, memory_context } = state;
  
  // Start with best practices template
  const bestPractices = await generateBestPracticesWorkflow(domainContext);
  
  // Identify insertion points for user steps
  const mergeStrategy = await analyzeMergeStrategy(bestPractices, extractedSteps);
  
  // Merge and reconcile
  const merged = await reconcileWorkflowSteps(
    bestPractices,
    extractedSteps,
    mergeStrategy
  );
  
  return {
    workflowSpec: merged,
    mergeReport: mergeStrategy.report
  };
}
```

#### TaskSubagent (`/api/subagents/task/index.js`)
```javascript
// Micro-DAG for task operations
const TaskSubgraph = new StateGraph(TaskState)
  .addNode("slot_fill", slotFillTask)              // Parse task details
  .addNode("resolve_contact", resolveContactNode)  // Uses ContactResolver service
  .addNode("generate_preview", generateTaskPreview) // Create preview
  .addNode("approval", approvalNode)               // Handle approve/reject/refine
  .addNode("create", createTask)                   // BSA API
  .addNode("link", linkToContactNode)              // Uses ContactResolver.linkActivity()
  .addNode("synthesize", synthesizeMemory)         // Uses Mem0Service.add()
  .addEdge(START, "slot_fill")
  .addConditionalEdges("slot_fill", needsContact)
  .addEdge("resolve_contact", "generate_preview")
  .addEdge("generate_preview", "approval")
  .addConditionalEdges("approval", (state) => {
    if (state.approval === "reject_with_refinement") {
      return "slot_fill"; // Re-run with refinement
    }
    if (state.approval === "approve") {
      return "create";
    }
    return END; // Simple rejection
  })
  .addEdge("create", "link")
  .addEdge("link", "synthesize")
  .addEdge("synthesize", END)
  .compile();

// Task nodes also use the shared ContactResolver service
async function resolveContactNode(state, config) {
  const { query } = state;
  const contactResolver = new ContactResolver(config.passKey);
  
  const candidates = await contactResolver.search(query);
  const selected = await contactResolver.disambiguate(candidates, state.context);
  
  return {
    contactId: selected.id,
    contactName: selected.name
  };
}

async function linkToContactNode(state, config) {
  const { task, contactId } = state;
  const contactResolver = new ContactResolver(config.passKey);
  
  // Reuse the same linking logic for tasks
  await contactResolver.linkActivity('task', task.id, contactId);
  
  return { linked: true };
}
```

### 3. Shared Services

#### ContactResolver (`/api/services/contactResolver.js`)
```javascript
class ContactResolver {
  async search(query, limit = 5) {
    // Search BSA contacts using the correct endpoint
    // Endpoint: /endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/search.json
    // Payload structure:
    const payload = {
      IncludeExtendedProperties: false,
      OrderBy: "LastName, FirstName",
      AscendingOrder: true,
      ResultsPerPage: limit,
      OrganizationId: orgId,
      PassKey: passKey,
      SearchTerm: query,
      PageOffset: 1,
      ObjectName: "contact"
    };

    // Response contains Results array with fields:
    // - Id (not id)
    // - FirstName, LastName, FullName
    // - EMailAddress1 (not Email)
    // - MobilePhone (not Mobile)
    // - Telephone1 (not Phone)
    // - JobTitle, CompanyName
    // - AddressLine1, City, State, Postal, Country
    // - BirthDate, ClientSince, MaritalStatus

    // Return normalized candidates
  }

  async disambiguate(candidates, context) {
    if (candidates.length === 1) return candidates[0];
    if (candidates.length <= 5) {
      // Raise interrupt for user choice
      throw new InterruptForChoice(candidates);
    }
    // Too many - ask for refinement
  }

  async linkActivity(type, activityId, contactId) {
    // Unified linking logic
    // Handles all BSA linker types
  }
}
```

#### Mem0 Cloud Service (`/api/services/mem0Service.js`)
```javascript
import MemoryClient from 'mem0ai';

class Mem0Service {
  constructor() {
    this.client = new MemoryClient(process.env.MEM0_API_KEY);
    this.cache = new Map(); // Session cache for performance
  }
  
  // Unified memory ID format: "orgId:userId"
  getMemoryId(orgId, userId) {
    return `${orgId}:${userId}`;
  }
  
  async recall(query, orgId, userId) {
    const memoryId = this.getMemoryId(orgId, userId);
    
    // Check cache first (5 minute TTL)
    const cacheKey = `${memoryId}:${query}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    
    // Mem0 handles vector search and relevance scoring
    const memories = await this.client.search(query, {
      user_id: memoryId,
      limit: 5
    });
    
    // Cache results
    this.cache.set(cacheKey, memories);
    setTimeout(() => this.cache.delete(cacheKey), 5 * 60 * 1000);
    
    return memories;
  }
  
  async synthesize(messages, orgId, userId, metadata = {}) {
    const memoryId = this.getMemoryId(orgId, userId);
    
    // Mem0 automatically extracts important information
    return await this.client.add(messages, {
      user_id: memoryId,
      metadata: {
        domain: metadata.domain,     // "calendar", "task", "workflow"
        action: metadata.action,      // "created", "updated", etc.
        timestamp: new Date().toISOString(),
        ...metadata
      }
    });
  }
  
  formatAsSystemMessage(memories) {
    if (!memories || memories.length === 0) return null;
    
    const context = memories
      .map(m => `- ${m.memory}`)
      .join('\n');
    
    return `Based on previous interactions:\n${context}`;
  }
}

// Singleton instance
let mem0Instance = null;
export function getMem0Service() {
  if (!mem0Instance) {
    mem0Instance = new Mem0Service();
  }
  return mem0Instance;
}
```

### Mem0 Cloud Integration Benefits

1. **Unified Memory Layer**: Single service for all subgraphs - no duplication
2. **Automatic Extraction**: No manual prompt engineering for synthesis
3. **Intelligent Deduplication**: Mem0 automatically merges similar memories
4. **Performance**: 90% token reduction, 26% better accuracy than custom solutions
5. **Zero Infrastructure**: No vector database, embeddings, or storage to manage
6. **Cost Effective**: Free tier (10K memories), then ~$50-100/month for Pro

## Phase 2.5: Approval & Refinement System

### Overview
The approval and refinement system ensures users have full control over all write operations. Every action that creates or modifies data (workflows, tasks, appointments) goes through an approval flow where users can:
- **Accept**: Proceed with the action as previewed
- **Reject**: Cancel the action entirely
- **Modify**: Request specific changes and regenerate the preview

This creates a conversational flow where the system learns from user preferences and refines its proposals through iterative feedback.

### Approval Node Implementation

```javascript
// Shared approval node used by all subgraphs
async function approvalNode(state, config) {
  const { preview, approvalContext } = state;
  
  // Always require approval for write operations (human in the loop)
  
  // Check max refinement attempts
  const MAX_ATTEMPTS = 3;
  if (approvalContext.attemptCount >= MAX_ATTEMPTS) {
    return {
      error: "Maximum refinement attempts reached. Please start a new request.",
      approval: "max_attempts_exceeded"
    };
  }
  
  // Prepare preview with context
  const enhancedPreview = {
    ...preview,
    attemptNumber: approvalContext.attemptCount + 1,
    isRefinement: approvalContext.isRefinement,
    previousFeedback: approvalContext.refinementInstructions
  };
  
  // Throw interrupt for user decision
  throw new Interrupt({
    value: {
      type: "APPROVAL_REQUIRED",
      preview: enhancedPreview,
      domain: state.domain || "unknown",
      allowRefinement: true,
      refinementPrompt: "What would you like to change?"
    },
    resumable: true
  });
}

// Handle approval response with refinement
async function handleApprovalResponse(state, response) {
  if (response.decision === "approve") {
    return { approval: "approve" };
  }
  
  if (response.decision === "reject" && response.refinement) {
    // User provided refinement instructions
    return {
      approval: "reject_with_refinement",
      approvalContext: {
        isRefinement: true,
        previousPreview: state.preview,
        refinementInstructions: response.refinement,
        attemptCount: state.approvalContext.attemptCount + 1,
        refinementHistory: [
          ...state.approvalContext.refinementHistory,
          {
            attempt: state.approvalContext.attemptCount + 1,
            preview: state.preview,
            feedback: response.refinement,
            timestamp: new Date().toISOString()
          }
        ]
      }
    };
  }
  
  // Simple rejection without refinement
  return { approval: "reject" };
}
```

### Preview Generation with Refinement Context

```javascript
// Example: Workflow preview generation with refinement
async function generateWorkflowPreview(state, config) {
  const { query, approvalContext } = state;
  const llm = new ChatOpenAI({ model: "gpt-4o", temperature: 0 });
  
  let prompt = `Design a workflow for: ${query}`;
  
  // Include refinement context if this is a retry
  if (approvalContext.isRefinement) {
    prompt += `\n\nPrevious Design:\n${JSON.stringify(approvalContext.previousPreview, null, 2)}`;
    prompt += `\n\nUser Feedback: "${approvalContext.refinementInstructions}"`;
    prompt += `\n\nPlease modify the workflow based on this feedback while maintaining all other aspects.`;
    
    // Include history for better context
    if (approvalContext.refinementHistory.length > 0) {
      prompt += `\n\nRefinement History:`;
      approvalContext.refinementHistory.forEach((h, i) => {
        prompt += `\n${i + 1}. Feedback: "${h.feedback}"`;
      });
    }
  }
  
  const response = await llm.invoke(prompt);
  const workflowSpec = JSON.parse(response.content);
  
  return {
    preview: {
      type: "workflow",
      spec: workflowSpec,
      summary: `${workflowSpec.name} (${workflowSpec.steps.length} steps)`,
      details: workflowSpec.steps.map((s, i) => `${i + 1}. ${s.subject}`),
      canRefine: true
    }
  };
}
```

### Coordinator Refinement Handler

```javascript
// Enhanced coordinator to handle refinement flows
const CoordinatorGraph = new StateGraph(CoordinatorState)
  .addNode("recall_memory", recallMemoryNode)
  .addNode("router", routerNode)
  .addNode("planner", lightweightPlannerNode)
  .addNode("executor", executorNode)
  .addNode("refinement_handler", refinementHandlerNode)  // NEW
  .addNode("finalizer", finalizerNode)
  .addEdge(START, "recall_memory")
  .addEdge("recall_memory", "router")
  .addConditionalEdges("router", (state) => {
    // Check if this is a refinement continuation
    if (state.approvalContext?.isRefinement) {
      return "refinement_handler";
    }
    if (state.needsPlanning) {
      return "planner";
    }
    return "executor";
  })
  .addEdge("refinement_handler", "executor")
  .addEdge("planner", "executor")
  .addEdge("executor", "finalizer")
  .addEdge("finalizer", END)
  .compile();

// Refinement handler node
async function refinementHandlerNode(state, config) {
  const { approvalContext, domains } = state;
  
  // Merge original query with refinement instructions
  const refinedQuery = `${state.messages[0].content}\n\nRefinement: ${approvalContext.refinementInstructions}`;
  
  // Prepare state for re-execution
  return {
    messages: [{ role: "human", content: refinedQuery }],
    previousAttempt: approvalContext.previousPreview,
    approvalContext: {
      ...approvalContext,
      isRefinement: true
    },
    // Maintain same domains for consistency
    domains,
    skipMemoryRecall: true  // Don't re-fetch memories
  };
}
```

### Frontend-Backend Protocol

```javascript
// Backend response for approval request
{
  "status": "PENDING_APPROVAL",
  "thread_id": "session_123:org_456",
  "approval_id": "apr_789",
  "domain": "workflow",
  "preview": {
    "type": "workflow",
    "summary": "Financial Planning Process (12 steps)",
    "details": ["1. Initial consultation", "2. Data gathering", "..."],
    "canRefine": true,
    "attemptNumber": 1
  },
  "ui_state": {
    "disable_input": true,
    "show_approval_buttons": true,
    "show_refinement_option": true,
    "refinement_placeholder": "Describe what changes you'd like..."
  }
}

// Frontend rejection with refinement
POST /api/agent/approve
{
  "thread_id": "session_123:org_456",
  "approval_id": "apr_789",
  "decision": "reject",
  "refinement": "Change step 6 to send documentation to the client instead of scheduling a meeting",
  "domain": "workflow"
}

// Backend continues with refinement
{
  "status": "PENDING_APPROVAL",
  "thread_id": "session_123:org_456",
  "approval_id": "apr_790",  // New approval ID
  "domain": "workflow",
  "preview": {
    "type": "workflow",
    "summary": "Financial Planning Process (12 steps)",
    "details": ["1. Initial consultation", "...", "6. Send documentation package to client", "..."],
    "canRefine": true,
    "attemptNumber": 2,
    "isRefinement": true,
    "previousFeedback": "Change step 6 to send documentation..."
  },
  "ui_state": {
    "disable_input": true,
    "show_approval_buttons": true,
    "show_refinement_option": true,
    "refinement_count": 2,
    "max_refinements": 3
  }
}
```

### UI Flow and User Experience

#### Visual State Transitions

**1. Normal Chat State (Input Enabled):**
```
┌─────────────────────────────────┐
│  Chat messages...               │
│                                 │
├─────────────────────────────────┤
│ [Type your message...]      [↵] │ ← User can type
└─────────────────────────────────┘
```

**2. Approval Request State (Input Disabled):**
```
┌─────────────────────────────────┐
│  Assistant: I'll create a       │
│  financial planning workflow:   │
│                                 │
│  📋 Preview:                    │
│  Financial Planning (12 steps)  │
│  1. Initial consultation        │
│  2. Gather documents            │
│  3. Analyze position            │
│  ...                           │
│                                 │
│  [✅ Accept] [❌ Reject] [✏️ Modify] │
├─────────────────────────────────┤
│ [Input field hidden]            │ ← Input disabled
└─────────────────────────────────┘
```

**3. Modify State (Refinement Input):**
```
┌─────────────────────────────────┐
│  Previous preview shown...      │
│                                 │
│  What would you like to change? │
│  ┌─────────────────────────┐   │
│  │Change step 6 to send    │   │
│  │documents instead...     │   │
│  └─────────────────────────┘   │
│                                 │
│  [Submit Changes] [Cancel]      │
└─────────────────────────────────┘
```

### Chrome Extension UI Integration

```javascript
// sidepanel.js enhancements for refinement flow
class ApprovalUI {
  constructor(container) {
    this.container = container;
    this.currentApproval = null;
  }
  
  showApprovalRequest(data) {
    const { preview, ui_state } = data;
    this.currentApproval = data;
    
    // Disable chat input
    chatInput.disabled = true;
    chatInput.placeholder = ui_state.refinement_count 
      ? `Refinement ${ui_state.refinement_count} of ${ui_state.max_refinements}`
      : 'Please review and approve or reject';
    
    // Create approval UI
    const approvalCard = document.createElement('div');
    approvalCard.className = 'approval-card';
    approvalCard.innerHTML = `
      <div class="preview-header">
        ${preview.isRefinement ? '🔄 Refined Preview' : '📋 Preview'}
        ${preview.attemptNumber > 1 ? `(Attempt ${preview.attemptNumber})` : ''}
      </div>
      <div class="preview-summary">${preview.summary}</div>
      <div class="preview-details">
        ${preview.details.map(d => `<div class="detail-item">${d}</div>`).join('')}
      </div>
      ${preview.previousFeedback ? `
        <div class="previous-feedback">
          Previous feedback: "${preview.previousFeedback}"
        </div>
      ` : ''}
      <div class="approval-actions">
        <button class="approve-btn">✅ Approve</button>
        <button class="reject-btn">❌ Reject</button>
      </div>
    `;
    
    this.container.appendChild(approvalCard);
    
    // Attach handlers
    this.attachHandlers(approvalCard, ui_state);
  }
  
  attachHandlers(card, ui_state) {
    const approveBtn = card.querySelector('.approve-btn');
    const rejectBtn = card.querySelector('.reject-btn');
    
    approveBtn.onclick = () => this.handleApprove();
    
    rejectBtn.onclick = () => {
      if (ui_state.show_refinement_option) {
        this.showRefinementInput(ui_state);
      } else {
        this.handleReject();
      }
    };
  }
  
  showRefinementInput(ui_state) {
    const refinementUI = document.createElement('div');
    refinementUI.className = 'refinement-input-container';
    refinementUI.innerHTML = `
      <textarea 
        class="refinement-input" 
        placeholder="${ui_state.refinement_placeholder}"
        rows="3"
      ></textarea>
      <div class="refinement-actions">
        <button class="submit-refinement">Submit Changes</button>
        <button class="cancel-refinement">Cancel Without Changes</button>
      </div>
    `;
    
    this.container.appendChild(refinementUI);
    
    const textarea = refinementUI.querySelector('.refinement-input');
    const submitBtn = refinementUI.querySelector('.submit-refinement');
    const cancelBtn = refinementUI.querySelector('.cancel-refinement');
    
    submitBtn.onclick = () => {
      const refinement = textarea.value.trim();
      if (refinement) {
        this.handleRejectWithRefinement(refinement);
      }
    };
    
    cancelBtn.onclick = () => this.handleReject();
    
    textarea.focus();
  }
  
  async handleApprove() {
    const response = await fetch('/api/agent/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id: this.currentApproval.thread_id,
        approval_id: this.currentApproval.approval_id,
        decision: 'approve',
        domain: this.currentApproval.domain
      })
    });
    
    this.clearApprovalUI();
    handleAgentResponse(await response.json());
  }
  
  async handleRejectWithRefinement(refinement) {
    const response = await fetch('/api/agent/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id: this.currentApproval.thread_id,
        approval_id: this.currentApproval.approval_id,
        decision: 'reject',
        refinement: refinement,
        domain: this.currentApproval.domain
      })
    });
    
    this.clearApprovalUI();
    const data = await response.json();
    
    if (data.status === 'PENDING_APPROVAL') {
      // Show new refined preview
      this.showApprovalRequest(data);
    } else {
      handleAgentResponse(data);
    }
  }
  
  clearApprovalUI() {
    this.container.innerHTML = '';
    chatInput.disabled = false;
    chatInput.placeholder = 'Type your message...';
  }
}
```

## Phase 3: Handling Complex Queries

### Example: "Create a financial planning workflow and then create a task for me to review that at 9:00 AM tomorrow"

```javascript
// 1. Coordinator Router identifies:
{
  domains: ["workflows", "tasks"],
  compose: "sequential",  // "then" indicates dependency
  needsPlanning: true     // Multiple domains with dependencies
}

// 2. Lightweight Planner creates execution plan:
{
  "steps": [
    {
      "domain": "workflows",
      "extractQuery": "financial planning workflow",
      "outputs_needed": ["workflowId", "name", "stepCount"]
    },
    {
      "domain": "tasks",
      "extractQuery": "review task tomorrow 9am",
      "inputs_from_previous": {
        "title": "Review {name}",
        "description": "Review workflow {workflowId} with {stepCount} steps",
        "linkedTo": "{workflowId}"
      },
      "depends_on": 0
    }
  ]
}

// 3. Executor follows the plan:
// - Runs WorkflowSubagent first
// - Extracts workflowId, name, stepCount
// - Passes context to TaskSubagent
// - TaskSubagent creates task with proper linking

// 4. Finalizer creates unified response:
"I've created a comprehensive financial planning workflow with 12 steps 
and scheduled your review task for tomorrow at 9:00 AM. The task is 
linked to the workflow for easy reference."
```

### Workflow Spectrum Examples

#### Agent-Led Mode (Full Creative Control)
```javascript
User: "Create a client onboarding workflow"

detectWorkflowGuidance → {
  guidanceMode: "agent_led",
  domainContext: "client_onboarding",
  extractedSteps: [],
  constraints: null
}

designWithBestPractices → {
  workflowSpec: {
    name: "Comprehensive Client Onboarding",
    steps: [
      "1. Initial consultation (30 min)",
      "2. KYC/AML documentation",
      "3. Risk assessment questionnaire",
      "4. Account opening forms",
      "5. Investment policy statement",
      "6. Initial funding instructions",
      "7. Welcome package delivery",
      "8. First portfolio review"
    ]
  }
}
```

#### User-Specified Mode (Exact Steps)
```javascript
User: "Create workflow with these steps:
1. Send welcome email
2. Schedule intro call
3. Review documents
4. Send contract"

detectWorkflowGuidance → {
  guidanceMode: "user_specified",
  extractedSteps: [
    "Send welcome email",
    "Schedule intro call", 
    "Review documents",
    "Send contract"
  ],
  constraints: "preserve_exact_wording"
}

parseExplicitSteps → {
  workflowSpec: {
    name: "Custom Workflow",
    steps: [
      "1. Send welcome email",
      "2. Schedule intro call",
      "3. Review documents",
      "4. Send contract"
    ],
    preservedUserIntent: true
  }
}
```

#### Hybrid Mode (Best Practices + Internal Process)
```javascript
User: "Build financial planning workflow but include our internal compliance check at step 3 and our proprietary risk scoring after goals"

detectWorkflowGuidance → {
  guidanceMode: "hybrid",
  domainContext: "financial_planning",
  extractedSteps: [
    { step: "internal compliance check", position: 3 },
    { step: "proprietary risk scoring", position: "after_goals" }
  ]
}

mergeHybridApproach → {
  workflowSpec: {
    name: "Financial Planning (with Internal Process)",
    steps: [
      "1. Initial consultation",
      "2. Gather financial documents",
      "3. Internal compliance check", // USER REQUIREMENT
      "4. Analyze current position",
      "5. Set financial goals",
      "6. Proprietary risk scoring",   // USER REQUIREMENT
      "7. Create investment strategy",
      "8. Prepare comprehensive plan",
      "9. Present to client"
    ],
    mergeReport: "Inserted 2 custom steps while maintaining best practice flow"
  }
}
```

### More Examples of Query-Specific Planning

#### Example: "Find John Smith's contact and schedule a meeting with him next week"
```javascript
// Planner output:
{
  "steps": [
    {
      "domain": "contacts",
      "extractQuery": "John Smith",
      "outputs_needed": ["contactId", "email", "preferredMeetingLength"]
    },
    {
      "domain": "calendar",
      "extractQuery": "meeting next week",
      "inputs_from_previous": {
        "attendeeId": "{contactId}",
        "attendeeEmail": "{email}",
        "duration": "{preferredMeetingLength}",
        "subject": "Meeting with John Smith"
      },
      "depends_on": 0
    }
  ]
}
```

#### Example: "Create tasks for the quarterly review and schedule a meeting to discuss them"
```javascript
// Planner output:
{
  "steps": [
    {
      "domain": "tasks",
      "extractQuery": "quarterly review tasks",
      "parallel_within": true,  // Can create multiple tasks in parallel
      "outputs_needed": ["taskIds", "taskSummary"]
    },
    {
      "domain": "calendar", 
      "extractQuery": "schedule meeting to discuss",
      "inputs_from_previous": {
        "description": "Discuss quarterly review tasks: {taskSummary}",
        "relatedIds": "{taskIds}"
      },
      "depends_on": 0
    }
  ]
}
```

### Complete Approval & Refinement Flow Example

Let's walk through a full scenario showing all three user actions:

**Step 1: Initial Request**
```javascript
User: "Build out a financial planning process"

System → WorkflowSubgraph → generatePreview:
{
  "preview": {
    "type": "workflow",
    "summary": "Financial Planning Process (12 steps)",
    "details": [
      "1. Initial client consultation (30 min)",
      "2. Gather financial documents",
      "3. Analyze current financial position",
      "4. Set financial goals",
      "5. Create investment strategy",
      "6. Schedule follow-up meeting",
      "7. Prepare comprehensive plan",
      "8. Present plan to client",
      "9. Implement investment changes",
      "10. Set up monitoring",
      "11. Schedule quarterly reviews",
      "12. Annual plan update"
    ]
  }
}
```

**Step 2: User Rejects with Refinement**
```javascript
Frontend: User clicks "Reject" and enters:
"Change step 6 to send documentation to the client instead of scheduling a meeting"

POST /api/agent/approve
{
  "decision": "reject",
  "refinement": "Change step 6 to send documentation to the client instead of scheduling a meeting",
  "domain": "workflow"
}
```

**Step 3: System Regenerates with Refinement**
```javascript
WorkflowSubgraph → generatePreview (with refinement context):
{
  "preview": {
    "type": "workflow",
    "summary": "Financial Planning Process (12 steps)",
    "details": [
      // ... steps 1-5 unchanged ...
      "6. Send comprehensive documentation package to client",  // CHANGED
      // ... steps 7-12 unchanged ...
    ],
    "isRefinement": true,
    "attemptNumber": 2,
    "previousFeedback": "Change step 6 to send documentation..."
  }
}
```

**Step 4: User Approves**
```javascript
Frontend: User clicks "Approve"
System: Executes workflow creation in BSA
Response: "I've successfully created your Financial Planning Process workflow with 12 steps, including the documentation step as you requested."
```

### Key Benefits of the Approval System

1. **User Control**: Nothing happens without explicit user consent
2. **Iterative Refinement**: Users can perfect the output through feedback
3. **Clear UI States**: Input field automatically hides/shows based on context
4. **Prevention of Mistakes**: Users can review all details before execution
5. **Learning from Feedback**: System improves based on user modifications
6. **Maximum 3 Attempts**: Prevents infinite refinement loops
7. **Always Active**: Consistent experience with approvals for all write operations

### API Endpoint Updates for Refinement

```javascript
// Enhanced /api/agent/approve endpoint
router.post('/approve', async (req, res) => {
  const { 
    thread_id, 
    approval_id, 
    decision, 
    refinement, 
    domain 
  } = req.body;
  
  // Load checkpoint to get current state
  const checkpoint = await checkpointer.get(thread_id);
  const currentState = checkpoint?.state;
  
  if (!currentState) {
    return res.status(404).json({ error: 'Thread not found' });
  }
  
  // Handle different decision types
  switch (decision) {
    case 'approve':
      // Continue execution from interrupt
      const approvedState = {
        ...currentState,
        approval: 'approve',
        approvalContext: {
          ...currentState.approvalContext,
          finalDecision: 'approved',
          timestamp: new Date().toISOString()
        }
      };
      
      // Resume the appropriate subgraph
      const subgraph = getSubgraph(domain);
      const result = await subgraph.invoke(approvedState, config);
      
      return res.json({
        status: 'COMPLETED',
        result: result.finalResponse,
        ui_state: { 
          disable_input: false,
          show_approval_buttons: false
        }
      });
    
    case 'reject':
      if (refinement) {
        // Check refinement attempt limit
        const attemptCount = currentState.approvalContext?.attemptCount || 0;
        if (attemptCount >= 3) {
          return res.status(400).json({
            error: 'Maximum refinement attempts reached',
            ui_state: { disable_input: false }
          });
        }
        
        // Prepare state for refinement
        const refinedState = {
          ...currentState,
          approvalContext: {
            isRefinement: true,
            previousPreview: currentState.preview,
            refinementInstructions: refinement,
            attemptCount: attemptCount + 1,
            refinementHistory: [
              ...(currentState.approvalContext?.refinementHistory || []),
              {
                attempt: attemptCount + 1,
                preview: currentState.preview,
                feedback: refinement,
                timestamp: new Date().toISOString()
              }
            ]
          },
          // Merge refinement into original query
          query: `${currentState.query}\n\nRefinement: ${refinement}`
        };
        
        // Re-run the subgraph with refinement
        const subgraph = getSubgraph(domain);
        const newPreview = await subgraph.invoke(refinedState, {
          ...config,
          mode: 'preview_only'  // Only regenerate preview
        });
        
        // Return new preview for approval
        return res.status(202).json({
          status: 'PENDING_APPROVAL',
          thread_id,
          approval_id: `apr_${Date.now()}`,  // New approval ID
          domain,
          preview: newPreview.preview,
          ui_state: {
            disable_input: true,
            show_approval_buttons: true,
            show_refinement_option: true,
            refinement_count: attemptCount + 1,
            max_refinements: 3
          }
        });
      } else {
        // Simple rejection - end the flow
        return res.json({
          status: 'REJECTED',
          message: 'Action cancelled',
          ui_state: { 
            disable_input: false,
            show_approval_buttons: false
          }
        });
      }
    
    default:
      return res.status(400).json({ 
        error: 'Invalid decision type' 
      });
  }
});
```

## Phase 4: Implementation Steps

### Week 1: Foundation
1. **Extract and modularize BSA tools**
   - Create `/api/tools/bsa/` directory
   - Extract each API call as standalone function
   - Add error handling and retry logic

2. **Build ContactResolver service**
   - Extract from activitiesAgent
   - Add disambiguation logic
   - Create unified linking interface

3. **Enhance Memory service**
   - Keep PgMemoryStore
   - Add caching layer
   - Implement domain-specific synthesis

### Week 2: First Subagent (Calendar)
1. **Create CalendarSubagent**
   - Build micro-DAG
   - Implement all nodes
   - Test with real BSA API

2. **Simple Coordinator**
   - Just memory recall + router + calendar + finalizer
   - Test end-to-end flow

### Week 3: Add Workflow & Task Subagents
1. **WorkflowSubagent**
   - Port logic from workflowBuilderAgent
   - Add preview generation
   - Test workflow creation

2. **TaskSubagent**
   - Extract from activitiesAgent
   - Add slot filling
   - Test task creation

### Week 4: Multi-Domain Coordination & Refinement
1. **Sequential composition**
   - Dependency detection
   - Context passing between subagents

2. **Parallel composition**
   - Fan-out for independent actions
   - Result aggregation

3. **Approval batching**
   - Collect approvals from all subagents
   - Single interrupt to user

4. **Iterative Refinement System**
   - Implement approval nodes with refinement support
   - Add refinement state tracking
   - Frontend UI for refinement input
   - API endpoint enhancements
   - Test refinement loops with max attempts

### Week 5: Polish & Migration
1. **Conversational Finalizer**
   - Merge results from multiple subagents
   - Generate natural responses
   - Add follow-up questions

2. **Feature flag migration**
   - Route simple queries to new system
   - Monitor performance
   - Gradual rollout

## Phase 5: File Structure (Final State)

```
/api
├── coordinator/
│   ├── index.js              # Main coordinator graph
│   ├── router.js             # Domain detection & routing
│   └── finalizer.js          # Response generation
├── subagents/
│   ├── calendar/
│   │   ├── index.js          # Calendar subgraph
│   │   ├── nodes/            # Individual nodes
│   │   └── state.js          # CalendarState definition
│   ├── workflow/
│   │   ├── index.js          # Workflow subgraph
│   │   ├── nodes/
│   │   └── state.js
│   └── task/
│       ├── index.js          # Task subgraph
│       ├── nodes/
│       └── state.js
├── services/
│   ├── contactResolver.js    # Shared contact resolution
│   ├── memory.js             # Enhanced memory with cache
│   └── approvals.js          # Approval batching
├── tools/
│   └── bsa/                  # All BSA API calls
│       ├── appointments.js
│       ├── tasks.js
│       ├── workflows.js
│       └── contacts.js
└── _archived/                # Old orchestrator code
```

## Success Metrics

### Performance
- Simple queries (single domain): <500ms
- Complex queries (multi-domain): <1.5s
- Memory recall: <100ms (cached)
- Approval round-trip: <2s

### Quality
- Contact resolution accuracy: >95%
- Memory relevance: >80%
- User satisfaction: >90%

### Maintainability
- Test coverage: >80%
- Domain isolation: Complete
- Team ownership: Clear boundaries

## Risk Mitigation

1. **Incremental Migration**
   - Start with CalendarSubagent only
   - Keep old system running in parallel
   - Feature flag for gradual rollout

2. **Contract Testing**
   - Define interfaces upfront
   - Test subagents in isolation
   - Mock dependencies for unit tests

3. **Monitoring**
   - Track latency per subagent
   - Monitor memory hit rates
   - Log routing decisions

## Decision Points

**Q1: Parallel by default?**
Recommend: Detect dependencies, default to parallel when independent. This maximizes performance for queries like "Schedule a meeting with John and create a task for the report."

**Q2: Contact disambiguation UI?**
Recommend: Yes, with choice chips. Store selection for 24 hours to bias future queries with same name.

**Q3: Memory granularity?**
Recommend: Store at interaction level but aggregate patterns weekly. Keep hot cache for current session.

## First Implementation Task

1. Create `/api/services/contactResolver.js` with search and disambiguate
2. Build CalendarSubagent with full micro-DAG
3. Create minimal Coordinator (memory → router → calendar → finalizer)
4. Test with "Schedule a meeting with John tomorrow at 2pm"
5. Verify end-to-end flow including approval

This architecture provides the perfect balance:
- Simple queries stay fast (single subagent)
- Complex queries work correctly (sequential/parallel composition)
- Domain expertise preserved (specialized subagents)
- Memory deeply integrated (recall + synthesis)
- Maintainable and testable (clear boundaries)