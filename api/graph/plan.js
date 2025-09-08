// Planning node that generates a DAG of actions
// Creates a dependency graph for parallel and sequential execution

const { z } = require("zod");

// Define the action schema
const ActionSchema = z.object({
  id: z.string().describe("Unique identifier for this action"),
  type: z.enum([
    "build_workflow",
    "create_task", 
    "update_task",
    "create_appointment",
    "update_appointment",
    "search_contacts",
    "get_calendar",
    "analyze_data"
  ]).describe("The type of action to perform"),
  params: z.record(z.any()).default({}).describe("Parameters for the action"),
  dependsOn: z.array(z.string()).default([]).describe("Array of action IDs this depends on")
});

// Define the plan schema (DAG structure)
const PlanSchema = z.object({
  actions: z.array(ActionSchema).describe("Array of actions forming a DAG")
});

/**
 * Planning node that creates a DAG of actions
 * Analyzes the user request and creates a structured plan
 * with dependencies for parallel execution
 * 
 * @param {Object} state - Graph state containing messages and context
 * @param {Object} config - Runtime configuration
 * @returns {Object} Updated state with plan and reset cursor
 */
async function planNode(state, config) {
  console.log("[PLAN] Starting plan generation");
  
  try {
    // Dynamic import for ESM module
    const { ChatOpenAI } = await import("@langchain/openai");
    
    // Get the last user message
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    
    if (!lastMessage || lastMessage.role !== "human") {
      console.log("[PLAN] No user message found, returning empty plan");
      return { plan: [], cursor: 0 };
    }
    
    const userQuery = String(lastMessage.content || "");
    console.log(`[PLAN] Creating plan for: "${userQuery.substring(0, 100)}..."`);
    
    // Initialize the planner model with structured output
    const model = new ChatOpenAI({
      model: process.env.LLM_PLANNER || "gpt-4o",
      temperature: 0,
      openAIApiKey: process.env.OPENAI_API_KEY
    });
    
    const structuredModel = model.withStructuredOutput(PlanSchema);
    
    // Get any recalled memory context
    const memoryContext = state.messages
      .filter(m => m.role === "system" && m.content.includes("Relevant context:"))
      .map(m => m.content)
      .join("\n");
    
    // Create the planning prompt
    const planningPrompt = `You are a planning agent for BlueSquare Apps. Create a DAG (Directed Acyclic Graph) of actions to fulfill the user's request.

${memoryContext ? `Context from memory:\n${memoryContext}\n` : ''}

User request: "${userQuery}"

Available action types:
- build_workflow: Create a new workflow with steps
- create_task: Create a new task
- update_task: Update an existing task
- create_appointment: Schedule a new appointment
- update_appointment: Modify an existing appointment
- search_contacts: Search for contacts
- get_calendar: Retrieve calendar events
- analyze_data: Analyze or summarize data

Guidelines:
1. Each action must have a unique ID (e.g., "act1", "act2")
2. Use dependsOn array to specify dependencies (empty array = can run immediately)
3. Actions with no dependencies can run in parallel
4. Actions with dependencies wait for their dependencies to complete
5. Keep the plan concise and focused on the user's request
6. Include relevant parameters in the params object

Example for "Create a workflow for client onboarding and schedule a kickoff meeting":
{
  "actions": [
    {
      "id": "act1",
      "type": "build_workflow",
      "params": {
        "name": "Client Onboarding",
        "description": "Standard process for new client onboarding"
      },
      "dependsOn": []
    },
    {
      "id": "act2",
      "type": "create_appointment",
      "params": {
        "title": "Client Kickoff Meeting",
        "duration": 60
      },
      "dependsOn": []
    }
  ]
}

Note: act1 and act2 have no dependencies, so they can execute in parallel.`;
    
    // Generate the plan
    const result = await structuredModel.invoke(planningPrompt);
    
    console.log(`[PLAN] Generated plan with ${result.actions.length} actions`);
    
    // Log the dependency structure
    const independentActions = result.actions.filter(a => a.dependsOn.length === 0);
    console.log(`[PLAN] ${independentActions.length} actions can run immediately`);
    
    // Validate the DAG (check for cycles)
    if (hasCycles(result.actions)) {
      console.error("[PLAN] Warning: Plan contains cycles, removing problematic dependencies");
      result.actions = removeCycles(result.actions);
    }
    
    return {
      plan: result.actions,
      cursor: 0,
      artifacts: {
        ...state.artifacts,
        planGenerated: new Date().toISOString(),
        doneIds: [] // Reset completed actions
      }
    };
    
  } catch (error) {
    console.error("[PLAN] Error during planning:", error.message);
    return { plan: [], cursor: 0 };
  }
}

/**
 * Check if the plan contains cycles
 * @param {Array} actions - Array of actions
 * @returns {boolean} True if cycles detected
 */
function hasCycles(actions) {
  const visited = new Set();
  const visiting = new Set();
  const actionMap = new Map(actions.map(a => [a.id, a]));
  
  function visit(actionId) {
    if (visited.has(actionId)) return false;
    if (visiting.has(actionId)) return true; // Cycle detected
    
    visiting.add(actionId);
    const action = actionMap.get(actionId);
    
    if (action && action.dependsOn) {
      for (const depId of action.dependsOn) {
        if (visit(depId)) return true;
      }
    }
    
    visiting.delete(actionId);
    visited.add(actionId);
    return false;
  }
  
  for (const action of actions) {
    if (visit(action.id)) return true;
  }
  
  return false;
}

/**
 * Remove cycles from the plan by clearing problematic dependencies
 * @param {Array} actions - Array of actions
 * @returns {Array} Actions with cycles removed
 */
function removeCycles(actions) {
  // Simple approach: clear all dependencies that would create cycles
  const actionMap = new Map(actions.map(a => [a.id, a]));
  const safeDeps = new Map();
  
  for (const action of actions) {
    const deps = [];
    for (const depId of action.dependsOn) {
      // Only keep dependency if it doesn't create a path back to this action
      if (!createsPathTo(depId, action.id, actionMap)) {
        deps.push(depId);
      }
    }
    safeDeps.set(action.id, deps);
  }
  
  return actions.map(a => ({
    ...a,
    dependsOn: safeDeps.get(a.id) || []
  }));
}

/**
 * Check if there's a path from source to target
 * @param {string} sourceId - Starting action ID
 * @param {string} targetId - Target action ID
 * @param {Map} actionMap - Map of action IDs to actions
 * @returns {boolean} True if path exists
 */
function createsPathTo(sourceId, targetId, actionMap) {
  const visited = new Set();
  const queue = [sourceId];
  
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    
    visited.add(current);
    const action = actionMap.get(current);
    
    if (action && action.dependsOn) {
      queue.push(...action.dependsOn);
    }
  }
  
  return false;
}

/**
 * Get actions that are ready to execute (dependencies satisfied)
 * @param {Object} state - Current graph state
 * @returns {Array} Array of ready actions
 */
function getReadyActions(state) {
  const plan = state.plan || [];
  const doneIds = new Set(state.artifacts?.doneIds || []);
  
  return plan.filter(action => {
    // Skip if already done
    if (doneIds.has(action.id)) return false;
    
    // Check if all dependencies are satisfied
    return action.dependsOn.every(depId => doneIds.has(depId));
  });
}

module.exports = {
  planNode,
  getReadyActions,
  ActionSchema,
  PlanSchema
};