/**
 * TaskSubgraph - Domain-specific graph for task management
 * 
 * Handles task creation, updates, assignment, and tracking with
 * contact resolution and approval flows.
 */

const { StateGraph, END } = require("@langchain/langgraph");
const { ChatOpenAI } = require("@langchain/openai");
const { z } = require("zod");

// Import BSA tools
const { getTasks, createTask, updateTask, completeTask, deleteTask } = require("../tools/bsa/tasks");
const { searchContacts, linkContactToActivity } = require("../tools/bsa/contacts");

// Import services
const { getContactResolver } = require("../services/contactResolver");
const { getApprovalBatcher } = require("../services/approvalBatcher");
const { getMem0Service } = require("../services/mem0Service");

// Task state channels for LangGraph
const TaskStateChannels = {
  messages: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  action: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  task_details: {
    value: (x, y) => y ? y : x,
    default: () => ({})
  },
  existing_tasks: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  assignee: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  linked_contacts: {
    value: (x, y) => y ? y : x,
    default: () => []
  },
  priority: {
    value: (x, y) => y ? y : x,
    default: () => "Medium"
  },
  preview: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  approval_status: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  result: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  entities: {
    value: (x, y) => y ? y : x,
    default: () => ({})
  },
  error: {
    value: (x, y) => y ? y : x,
    default: () => null
  },

  // Context fields (required for authentication and state management)
  session_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  org_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  user_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  thread_id: {
    value: (x, y) => y ? y : x,
    default: () => null
  },
  timezone: {
    value: (x, y) => y ? y : x,
    default: () => 'UTC'
  }
};

class TaskSubgraph {
  constructor(checkpointer = null) {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0.3
    });

    this.contactResolver = getContactResolver();
    this.approvalBatcher = getApprovalBatcher();
    this.mem0 = getMem0Service();
    this.checkpointer = checkpointer;
    
    this.graph = this.buildGraph();
  }

  buildGraph() {
    const workflow = new StateGraph({
      channels: TaskStateChannels
    });

    // Add nodes
    workflow.addNode("parse_request", this.parseRequest.bind(this));
    workflow.addNode("set_priority", this.setPriority.bind(this));
    workflow.addNode("resolve_assignee", this.resolveAssignee.bind(this));
    workflow.addNode("fetch_tasks", this.fetchTasks.bind(this));
    workflow.addNode("check_duplicates", this.checkDuplicates.bind(this));
    workflow.addNode("generate_preview", this.generatePreview.bind(this));
    workflow.addNode("wait_for_approval", this.waitForApproval.bind(this));
    workflow.addNode("create_task", this.createTaskNode.bind(this));
    workflow.addNode("update_task", this.updateTaskNode.bind(this));
    workflow.addNode("complete_task", this.completeTaskNode.bind(this));
    workflow.addNode("link_contacts", this.linkContacts.bind(this));
    workflow.addNode("synthesize_memory", this.synthesizeMemory.bind(this));
    workflow.addNode("format_response", this.formatResponse.bind(this));

    // Set entry point
    workflow.setEntryPoint("parse_request");

    // Define conditional routing from parse_request
    workflow.addConditionalEdges(
      "parse_request",
      (state) => {
        if (state.error) return "format_response";
        switch (state.action) {
          case "create": return "set_priority";
          case "view": return "fetch_tasks";
          case "update": return "fetch_tasks";
          case "complete": return "fetch_tasks";
          default: return "format_response";
        }
      },
      {
        "set_priority": "set_priority",
        "fetch_tasks": "fetch_tasks",
        "format_response": "format_response"
      }
    );

    // Creation flow
    workflow.addEdge("set_priority", "resolve_assignee");
    workflow.addEdge("resolve_assignee", "check_duplicates");
    workflow.addEdge("check_duplicates", "generate_preview");
    workflow.addEdge("generate_preview", "wait_for_approval");
    
    workflow.addConditionalEdges(
      "wait_for_approval",
      (state) => state.approval_status === "approved" ? "create_task" : "format_response",
      {
        "create_task": "create_task",
        "format_response": "format_response"
      }
    );
    
    workflow.addEdge("create_task", "link_contacts");
    workflow.addEdge("link_contacts", "synthesize_memory");

    // View flow
    workflow.addConditionalEdges(
      "fetch_tasks",
      (state) => {
        if (state.action === "view") return "format_response";
        if (state.action === "update") return "generate_preview";
        if (state.action === "complete") return "complete_task";
        return "format_response";
      },
      {
        "generate_preview": "generate_preview",
        "complete_task": "complete_task",
        "format_response": "format_response"
      }
    );

    // Update flow
    workflow.addEdge("update_task", "synthesize_memory");
    
    // Complete flow
    workflow.addEdge("complete_task", "synthesize_memory");

    // Memory synthesis leads to response
    workflow.addEdge("synthesize_memory", "format_response");
    
    // End
    workflow.addEdge("format_response", END);

    // Compile with checkpointer if available
    const compileOptions = {};
    if (this.checkpointer) {
      compileOptions.checkpointer = this.checkpointer;
      const checkpointerType = this.checkpointer.constructor?.name || 'Unknown';
      console.log(`[TASK] Compiling graph WITH checkpointer (${checkpointerType})`);
    } else {
      console.log("[TASK] Compiling graph WITHOUT checkpointer (interrupts disabled)");
    }

    return workflow.compile(compileOptions);
  }

  /**
   * Parse the user's request to determine task action and details
   */
  async parseRequest(state) {
    console.log("[TASK:PARSE] Parsing request");
    
    const lastMessage = state.messages[state.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      return { error: "No user message found" };
    }

    try {
      const parsePrompt = `
        Analyze this task-related request and extract:
        1. Action type: "create", "view", "update", "complete", or "delete"
        2. Task details (subject, description, due date, etc.)
        3. Priority indicators (urgent, high, normal, low)
        4. Assignee or contact mentions
        
        Query: "${lastMessage.content}"
        
        Return JSON:
        {
          "action": "create|view|update|complete|delete",
          "task": {
            "subject": "task title",
            "description": "details",
            "dueDate": "YYYY-MM-DD or null",
            "dueTime": "HH:MM or null"
          },
          "priority": "High|Medium|Low",
          "contacts": ["mentioned names"],
          "taskId": "id if updating/completing existing task"
        }
      `;

      const response = await this.llm.invoke(parsePrompt);
      let parsed = response.content;
      
      // Extract JSON from response
      if (parsed.includes('```json')) {
        parsed = parsed.split('```json')[1].split('```')[0].trim();
      } else if (parsed.includes('```')) {
        parsed = parsed.split('```')[1].split('```')[0].trim();
      }
      
      const result = JSON.parse(parsed);
      
      console.log("[TASK:PARSE] Detected action:", result.action);
      
      return {
        action: result.action,
        task_details: result.task || {},
        priority: result.priority || "Medium",
        linked_contacts: result.contacts || []
      };
      
    } catch (error) {
      console.error("[TASK:PARSE] Error:", error);
      return { error: `Failed to parse request: ${error.message}` };
    }
  }

  /**
   * Set task priority based on context and keywords
   */
  async setPriority(state) {
    console.log("[TASK:PRIORITY] Setting task priority");
    
    const { task_details, priority } = state;
    
    // Check for urgency indicators
    const urgentKeywords = /urgent|asap|immediately|critical|emergency/i;
    const highKeywords = /important|high priority|soon|today/i;
    const lowKeywords = /whenever|low priority|eventually|someday/i;
    
    const text = `${task_details.subject || ''} ${task_details.description || ''}`;
    
    let finalPriority = priority;
    
    if (urgentKeywords.test(text)) {
      finalPriority = "Urgent";
    } else if (highKeywords.test(text)) {
      finalPriority = "High";
    } else if (lowKeywords.test(text)) {
      finalPriority = "Low";
    }
    
    // Check due date proximity
    if (task_details.dueDate) {
      const dueDate = new Date(task_details.dueDate);
      const today = new Date();
      const daysDiff = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
      
      if (daysDiff <= 1) finalPriority = "Urgent";
      else if (daysDiff <= 3) finalPriority = "High";
    }
    
    console.log(`[TASK:PRIORITY] Set priority to: ${finalPriority}`);
    
    return { priority: finalPriority };
  }

  /**
   * Resolve assignee from contact mentions
   */
  async resolveAssignee(state, config) {
    console.log("[TASK:ASSIGNEE] Resolving assignee");
    
    const { linked_contacts } = state;
    
    if (!linked_contacts || linked_contacts.length === 0) {
      console.log("[TASK:ASSIGNEE] No assignee specified");
      return { assignee: null };
    }
    
    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      // Search for the first mentioned contact
      const contactName = linked_contacts[0];
      const contacts = await this.contactResolver.search(contactName, 3, passKey, orgId);
      
      if (contacts.length === 0) {
        console.log(`[TASK:ASSIGNEE] No contact found for "${contactName}"`);
        return { assignee: null };
      }
      
      // Use disambiguation if multiple matches
      let selectedContact = contacts[0];
      if (contacts.length > 1) {
        selectedContact = await this.contactResolver.disambiguate(contacts, `Assign task to ${contactName}`);
      }
      
      console.log(`[TASK:ASSIGNEE] Assigned to: ${selectedContact.name}`);
      
      return {
        assignee: selectedContact,
        linked_contacts: [selectedContact]
      };
      
    } catch (error) {
      console.error("[TASK:ASSIGNEE] Error:", error);
      return { assignee: null };
    }
  }

  /**
   * Fetch existing tasks (for view/update/complete actions)
   */
  async fetchTasks(state, config) {
    console.log("[TASK:FETCH] Fetching tasks");
    
    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      // Determine fetch parameters based on action
      const { action, task_details } = state;
      const options = {};
      
      if (action === "view") {
        // Fetch recent tasks or based on criteria
        if (task_details.dueDate) {
          options.dueDate = task_details.dueDate;
        }
        options.includeCompleted = false;
        options.limit = 10;
      } else if (action === "update" || action === "complete") {
        // Need to find specific task
        if (task_details.subject) {
          options.search = task_details.subject;
        }
        options.limit = 5;
      }
      
      const tasks = await getTasks(passKey, orgId, options);
      
      console.log(`[TASK:FETCH] Found ${tasks.length} tasks`);
      
      return { existing_tasks: tasks };
      
    } catch (error) {
      console.error("[TASK:FETCH] Error:", error);
      return { existing_tasks: [] };
    }
  }

  /**
   * Check for duplicate tasks before creation
   */
  async checkDuplicates(state) {
    console.log("[TASK:DUPLICATES] Checking for duplicates");
    
    const { task_details, existing_tasks } = state;
    
    if (!task_details.subject) {
      return state;
    }
    
    // Simple duplicate detection based on subject similarity
    const subject = task_details.subject.toLowerCase();
    const duplicates = existing_tasks.filter(task => {
      const taskSubject = (task.subject || '').toLowerCase();
      return taskSubject.includes(subject) || subject.includes(taskSubject);
    });
    
    if (duplicates.length > 0) {
      console.log(`[TASK:DUPLICATES] Found ${duplicates.length} potential duplicates`);
      
      // Add warning to preview
      return {
        task_details: {
          ...task_details,
          duplicateWarning: `Similar task exists: "${duplicates[0].subject}"`
        }
      };
    }
    
    return state;
  }

  /**
   * Generate task preview for approval
   */
  async generatePreview(state) {
    console.log("[TASK:PREVIEW] Generating preview");
    
    const { action, task_details, priority, assignee } = state;
    
    const preview = {
      type: "task",
      action: action,
      title: task_details.subject || "Untitled Task",
      details: {
        subject: task_details.subject || "Untitled Task",
        description: task_details.description || "",
        dueDate: task_details.dueDate || "Not set",
        dueTime: task_details.dueTime || "All day",
        priority: priority,
        assignee: assignee ? assignee.name : "Unassigned",
        duplicateWarning: task_details.duplicateWarning
      },
      // Add spec for UI rendering
      spec: {
        name: task_details.subject || "Untitled Task",
        description: task_details.description || "",
        dueDate: task_details.dueDate,
        priority: priority
      }
    };
    
    console.log("[TASK:PREVIEW] Preview generated");
    
    return { preview };
  }

  /**
   * Wait for user approval (interrupt point)
   */
  async waitForApproval(state) {
    console.log("[TASK:APPROVAL] Awaiting approval");
    
    const { preview } = state;
    
    // In production, this would trigger an interrupt
    // For now, auto-approve
    console.log("[TASK:APPROVAL] Auto-approving for testing");
    
    return { approval_status: "approved" };
  }

  /**
   * Create the task in BSA
   */
  async createTaskNode(state, config) {
    console.log("[TASK:CREATE] Creating task");
    
    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      const { task_details, priority, assignee } = state;
      
      const taskData = {
        subject: task_details.subject,
        description: task_details.description,
        dueDate: task_details.dueDate,
        dueTime: task_details.dueTime,
        priority: priority,
        status: "Not Started",
        assigneeId: assignee?.id
      };
      
      const createdTask = await createTask(taskData, passKey, orgId);
      
      console.log(`[TASK:CREATE] Created task with ID: ${createdTask.id}`);
      
      // Register entity
      const entity = {
        id: `TASK_${createdTask.id}`,
        type: "task",
        name: createdTask.subject,
        bsaId: createdTask.id
      };
      
      return {
        result: createdTask,
        entities: {
          ...state.entities,
          created: [entity]
        }
      };
      
    } catch (error) {
      console.error("[TASK:CREATE] Error:", error);
      return { error: `Failed to create task: ${error.message}` };
    }
  }

  /**
   * Update an existing task
   */
  async updateTaskNode(state, config) {
    console.log("[TASK:UPDATE] Updating task");
    
    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      const { existing_tasks, task_details } = state;
      
      if (!existing_tasks || existing_tasks.length === 0) {
        return { error: "No task found to update" };
      }
      
      const taskToUpdate = existing_tasks[0];
      const updates = { ...task_details };
      
      const updatedTask = await updateTask(taskToUpdate.id, updates, passKey, orgId);
      
      console.log(`[TASK:UPDATE] Updated task ${taskToUpdate.id}`);
      
      return { result: updatedTask };
      
    } catch (error) {
      console.error("[TASK:UPDATE] Error:", error);
      return { error: `Failed to update task: ${error.message}` };
    }
  }

  /**
   * Complete a task
   */
  async completeTaskNode(state, config) {
    console.log("[TASK:COMPLETE] Completing task");
    
    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      const { existing_tasks } = state;
      
      if (!existing_tasks || existing_tasks.length === 0) {
        return { error: "No task found to complete" };
      }
      
      const taskToComplete = existing_tasks[0];
      const completedTask = await completeTask(taskToComplete.id, passKey, orgId);
      
      console.log(`[TASK:COMPLETE] Completed task ${taskToComplete.id}`);
      
      return { result: completedTask };
      
    } catch (error) {
      console.error("[TASK:COMPLETE] Error:", error);
      return { error: `Failed to complete task: ${error.message}` };
    }
  }

  /**
   * Link contacts to the created task
   */
  async linkContacts(state, config) {
    console.log("[TASK:LINK] Linking contacts");
    
    const { result, linked_contacts } = state;
    
    if (!result || !result.id || !linked_contacts || linked_contacts.length === 0) {
      return state;
    }
    
    try {
      const passKey = await config.configurable.getPassKey();
      const orgId = config.configurable.org_id;
      
      for (const contact of linked_contacts) {
        await linkContactToActivity('task', result.id, contact.id, passKey, orgId);
        console.log(`[TASK:LINK] Linked contact ${contact.name} to task ${result.id}`);
      }
      
      return state;
      
    } catch (error) {
      console.error("[TASK:LINK] Error linking contacts:", error);
      return state;
    }
  }

  /**
   * Synthesize memory from the interaction
   */
  async synthesizeMemory(state, config) {
    console.log("[TASK:MEMORY] Synthesizing memory");
    
    if (!this.mem0.client) {
      console.log("[TASK:MEMORY] Mem0 not configured, skipping");
      return state;
    }
    
    try {
      const { result, action } = state;
      const orgId = config.configurable.org_id;
      const userId = config.configurable.user_id;
      
      if (result && action === "create") {
        const memory = `Created task "${result.subject}" with ${result.priority} priority, due ${result.dueDate || 'no date set'}`;
        
        await this.mem0.synthesize(
          [{ role: "assistant", content: memory }],
          orgId,
          userId,
          { domain: "task", action: "create" }
        );
        
        console.log("[TASK:MEMORY] Memory synthesized");
      }
      
      return state;
      
    } catch (error) {
      console.error("[TASK:MEMORY] Error:", error);
      return state;
    }
  }

  /**
   * Format the final response
   */
  async formatResponse(state) {
    console.log("[TASK:RESPONSE] Formatting response");
    
    const { action, result, existing_tasks, error } = state;
    
    if (error) {
      return {
        response: `Error: ${error}`,
        data: null
      };
    }
    
    let response = "";
    let data = null;
    
    switch (action) {
      case "create":
        if (result) {
          response = `✅ Task "${result.subject}" created successfully\n`;
          response += `Priority: ${result.priority}\n`;
          response += `Due: ${result.dueDate || 'No date set'}\n`;
          response += `Status: ${result.status}`;
          data = result;
        } else {
          response = "Task creation was cancelled.";
        }
        break;
        
      case "view":
        if (existing_tasks && existing_tasks.length > 0) {
          response = `Found ${existing_tasks.length} task(s):\n\n`;
          existing_tasks.forEach((task, i) => {
            response += `${i + 1}. ${task.subject}\n`;
            response += `   Priority: ${task.priority} | Status: ${task.status}\n`;
            response += `   Due: ${task.dueDate || 'No date'}\n\n`;
          });
          data = existing_tasks;
        } else {
          response = "No tasks found.";
        }
        break;
        
      case "update":
        if (result) {
          response = `✅ Task "${result.subject}" updated successfully`;
          data = result;
        } else {
          response = "Task update failed.";
        }
        break;
        
      case "complete":
        if (result) {
          response = `✅ Task "${result.subject}" marked as complete`;
          data = result;
        } else {
          response = "Failed to complete task.";
        }
        break;
        
      default:
        response = "I couldn't understand what you want to do with tasks.";
    }
    
    return { response, data };
  }

  /**
   * Main entry point
   */
  async invoke(state, config) {
    console.log("[TASK:SUBGRAPH] Invoked");
    
    try {
      const result = await this.graph.invoke(state, config);
      return result;
    } catch (error) {
      console.error("[TASK:SUBGRAPH] Fatal error:", error);
      return {
        response: `Task operation failed: ${error.message}`,
        error: error.message
      };
    }
  }
}

// Export factory function
/**
 * Factory function to create task subgraph
 * @param {Object} checkpointer - The checkpointer (propagated from parent)
 */
async function createSubgraph(checkpointer = null) {
  return new TaskSubgraph(checkpointer).graph;
}

module.exports = {
  createSubgraph,
  TaskSubgraph
};