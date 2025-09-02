# LangGraph Orchestration Integration Plan

## Project: BlueSquare Assistant - AI Agent Orchestration Layer

**Date Created**: 2025-01-31  
**Last Updated**: 2025-09-02 (v7.0 - Phase 1 COMPLETE with critical implementation fixes)  
**Status**: Phase 1 Complete, Phase 2 Ready  
**Complexity**: Medium (pragmatic approach)  
**Estimated Time**: 8-9 hours (phased implementation)  
**Phase 1 Actual Time**: 4 hours (including debugging)  

---

## Executive Summary

This plan outlines the integration of LangChain agent capabilities into the BlueSquare Assistant Chrome Extension. Phase 1 focuses on building a functional Calendar Agent that can intelligently interact with BSA APIs based on natural language queries. Phase 2 will add LangGraph orchestration when multiple agents need coordination.

**UPDATE (2025-02-01)**: Revised to agent-first approach - Calendar Agent with tools in Phase 1, orchestration in Phase 2.

## Current Architecture Review

### Existing System
- **Chrome Extension**: Side panel UI (vanilla JS)
- **Express Backend**: Handles OAuth, stores PassKeys in Supabase
- **Security Model**: PassKeys never exposed to frontend
- **API Integration**: BSA endpoints for organizations and contacts

### Key Strengths to Preserve
- Three-tier security architecture
- PassKey isolation in backend
- Session-based authentication
- Automatic token refresh mechanism

### Organization Selection Architecture
- **Frontend State**: Organization selection stored in `currentOrgId` (client-side only)
- **Persistence**: Last selected org saved to localStorage for auto-restore on reload
- **Backend Helper**: Centralized `fetchOrganizations()` function shared by endpoint and agent tools
- **Error Handling**: Assistant requires org_id, prompts user to select if missing
- **No Backend Coupling**: Backend remains stateless regarding org selection

## Proposed Architecture

### Phase 1 - Single Agent
```
User Query → Chrome Extension → Express Backend → Calendar Agent (with Tools)
                                                           ↓
                                                   Tool Selection Logic
                                                     ↙    ↓    ↘
                                          getAppointments  |  getContacts
                                                           ↓
                                                      BSA API (via PassKey)
```

### Phase 2 - Multi-Agent with Orchestration
```
User Query → Chrome Extension → Express Backend → LangGraph Supervisor
                                                   ↓
                                            Intent Classification
                                              ↙         ↘
                                    Calendar Agent    Task Agent
                                           ↓              ↓
                                      BSA APIs      BSA APIs
```

### Technology Stack
- **LangChain**: Agent framework with tool calling capabilities
- **OpenAI**: Language model for agent reasoning
- **LangGraph**: Orchestration layer (Phase 2 only)
- **Server-Sent Events**: Real-time streaming responses (future)

## Implementation Plan

### Phase 1: Calendar Agent with LangChain Tools (COMPLETE ✅)

#### 1.1 Install Dependencies (COMPLETE)
```bash
npm install @langchain/openai @langchain/core langchain zod
# Critical: All packages installed and version-aligned
# langchain: 0.3.31
# @langchain/core: 0.3.72 (with overrides to force alignment)
# @langchain/openai: 0.6.9
# zod: 3.x (for tool schemas)
```

#### CRITICAL IMPLEMENTATION FIXES APPLIED

##### Issue 1: Tool Execution Failure (FIXED)
**Problem**: Agent identified tools but didn't execute them (empty responses)
**Root Cause**: `createOpenAIFunctionsAgent` is deprecated
**Solution**: Replaced with `createToolCallingAgent`
```javascript
// WRONG (causes empty responses):
const { createOpenAIFunctionsAgent } = await import("langchain/agents");

// CORRECT:
const { createToolCallingAgent } = await import("langchain/agents");
```

##### Issue 2: Tool Input Schema Mismatch (FIXED)
**Problem**: "Received tool input did not match expected schema"
**Root Cause**: `DynamicTool` expects string input, but modern agents pass objects
**Solution**: Use `tool()` function with Zod schemas
```javascript
// WRONG (expects string, gets object):
new DynamicTool({
  name: "search_appointments_by_date",
  func: async (input) => { // input is string, needs parsing
    const parsed = JSON.parse(input);
  }
})

// CORRECT (accepts objects directly):
tool(
  async ({ startDate, endDate }) => { // destructured object input
    // Direct use, no parsing needed
  },
  {
    name: "search_appointments_by_date",
    schema: z.object({
      startDate: z.string(),
      endDate: z.string()
    })
  }
)
```

##### Issue 3: Tool Initialization Error (FIXED)
**Problem**: "Cannot read properties of undefined (reading 'toLowerCase')"
**Root Cause**: Incorrect use of `StructuredTool` constructor
**Solution**: Use `tool()` function instead
```javascript
// WRONG (causes toLowerCase error):
new StructuredTool({
  name: "get_appointments",
  schema: z.object({...}),
  func: async (input) => {...}
})

// CORRECT:
tool(
  async (input) => {...},
  {
    name: "get_appointments",
    schema: z.object({...})
  }
)
```

##### Issue 4: Version Conflicts (FIXED)
**Problem**: Module resolution errors between LangChain packages
**Solution**: Force version alignment with npm overrides
```json
"overrides": {
  "@langchain/core": "0.3.72"
}
```

#### 1.2 Package.json Configuration
```json
// Only add overrides if you encounter version conflicts
// Current package.json uses CommonJS (no "type": "module")
// Keep existing structure intact
```

#### 1.3 Environment Variables
```env
OPENAI_API_KEY=your_openai_key
LANGCHAIN_API_KEY=optional_for_tracing
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT="BSA Assistant"
```

#### 1.4 Backend Implementation - Calendar Agent with Tools
Create a proper agent with tool-calling capabilities:

##### 1.4.1 Performance Optimizations
Add to top of `api/index.js`:
```javascript
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// Keep-alive agents for connection reuse
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10
});
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10
});

// Module caching to prevent duplicate imports
const modulePromises = {};
const moduleCache = {};

// Enhanced axios config
const axiosConfig = {
  httpAgent: keepAliveAgent,
  httpsAgent: keepAliveHttpsAgent,
  timeout: 10000
};

// Cached LLM client getter
async function getLLMClient() {
  if (!moduleCache.llm) {
    if (!modulePromises.llm) {
      modulePromises.llm = import("@langchain/openai").then(({ ChatOpenAI }) => {
        moduleCache.llm = new ChatOpenAI({
          model: "gpt-4o-mini",
          temperature: 0
        });
        return moduleCache.llm;
      });
    }
    return modulePromises.llm;
  }
  return moduleCache.llm;
}
```

##### 1.4.2 Calendar Agent with Tools
Add to `api/index.js`:
```javascript
// Helper functions for BSA API calls
// Note: fetchOrganizations helper is defined earlier in the file and shared with /api/orgs endpoint

// Helper to normalize BSA responses (handle array wrapper format)
// NOTE: This is for regular BSA endpoints only, NOT for /oauth2/passkey
function normalizeBSAResponse(response) {
  // Most BSA endpoints return responses in array format: [{ data }]
  // Exception: /oauth2/passkey returns plain object { passkey, user_id, expires_in }
  // This helper unwraps the array and validates the response
  if (!response) {
    return { data: null, valid: false, error: 'No response data' };
  }
  
  // Unwrap array wrapper
  const responseData = Array.isArray(response) ? response[0] : response;
  
  // Check Valid field for errors
  if (responseData?.Valid === false) {
    return {
      data: responseData,
      valid: false,
      error: responseData.ResponseMessage || responseData.StackMessage || 'BSA API error'
    };
  }
  
  return {
    data: responseData,
    valid: true,
    error: null
  };
}

async function getAppointments(passKey, orgId, options = {}) {
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json`;
  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "appointment",
    IncludeExtendedProperties: true,
    ResultsPerPage: options.limit || 100,
    PageOffset: options.offset || 0
  };
  
  const resp = await axios.post(url, payload, axiosConfig);
  // Handle array wrapper format: [{ Results: [...], Valid: true }]
  const normalized = normalizeBSAResponse(resp.data);
  
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Invalid BSA response');
  }
  
  return {
    appointments: normalized.data?.Results || [],
    totalResults: normalized.data?.TotalResults || 0,
    valid: true
  };
}

async function getAppointmentContacts(passKey, orgId, appointmentId) {
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/listLinked.json`;
  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "linker_appointments_contacts",
    ListObjectName: "contact",
    LinkParentId: appointmentId
  };
  
  const resp = await axios.post(url, payload, axiosConfig);
  // Handle array wrapper format: [{ Results: [...], Valid: true }]
  const normalized = normalizeBSAResponse(resp.data);
  
  if (!normalized.valid) {
    throw new Error(normalized.error || 'Invalid BSA response');
  }
  
  return normalized.data?.Results || [];
}

// Helper function for safe JSON parsing in tools
function parseToolInput(input, schema = {}) {
  try {
    const parsed = JSON.parse(input || '{}');
    
    // Validate required fields if schema provided
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (parsed[field] === undefined || parsed[field] === null) {
          return { 
            error: `Missing required field: '${field}'`, 
            isError: true 
          };
        }
      }
    }
    
    return { data: parsed, isError: false };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { 
        error: `Invalid JSON format: ${error.message}`, 
        isError: true 
      };
    }
    return { 
      error: `Error parsing input: ${error.message}`, 
      isError: true 
    };
  }
}

// Define Calendar Agent Tools
function createCalendarTools(DynamicTool, passKey, orgId) {
  return [
    new DynamicTool({
      name: "get_appointments",
      description: "Fetch calendar appointments. Use when user asks about meetings, appointments, or calendar events.",
      func: async (input) => {
        try {
          const result = parseToolInput(input);
          if (result.isError) {
            return JSON.stringify({ error: result.error });
          }
          
          const options = result.data;
          const data = await getAppointments(passKey, orgId, options);
          
          // Handle various BSA response formats
          if (!data) {
            return JSON.stringify({ 
              error: "Unexpected empty response from BSA API" 
            });
          }
          
          // Check for error indicators in response
          if (data.Valid === false || data.ResponseMessage === "Error") {
            return JSON.stringify({ 
              error: data.StackMessage || data.ResponseMessage || "BSA API error" 
            });
          }
          
          return JSON.stringify({
            count: data.Items?.length || 0,
            appointments: data.Items?.slice(0, 5), // Limit for readability
            total: data.TotalResults || data.Items?.length || 0
          });
        } catch (error) {
          // Log full error for debugging
          console.error("[Calendar Tool] Error fetching appointments:", error);
          return JSON.stringify({ 
            error: `Failed to fetch appointments: ${error.message}` 
          });
        }
      }
    }),
    
    new DynamicTool({
      name: "get_appointment_contacts",
      description: "Get contacts linked to a specific appointment. Use when user asks who is attending a meeting.",
      func: async (appointmentId) => {
        try {
          if (!appointmentId || typeof appointmentId !== 'string') {
            return JSON.stringify({ 
              error: "Invalid input. Please provide a valid appointment ID as a string." 
            });
          }
          
          const contacts = await getAppointmentContacts(passKey, orgId, appointmentId);
          return JSON.stringify({
            appointmentId,
            contacts,
            count: contacts.length
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to fetch appointment contacts: ${error.message}` 
          });
        }
      }
    }),
    
    new DynamicTool({
      name: "search_appointments_by_date",
      description: "Search appointments by date range. Input should be JSON with 'startDate' and 'endDate' fields.",
      func: async (input) => {
        try {
          const result = parseToolInput(input, { 
            required: ['startDate', 'endDate'] 
          });
          if (result.isError) {
            return JSON.stringify({ 
              error: result.error,
              example: "Expected format: {\"startDate\": \"2024-01-01\", \"endDate\": \"2024-01-31\"}"
            });
          }
          
          const { startDate, endDate } = result.data;
          
          // Validate date formats
          const startDateObj = new Date(startDate);
          const endDateObj = new Date(endDate);
          if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
            return JSON.stringify({ 
              error: "Invalid date format. Please use YYYY-MM-DD format.",
              example: "{\"startDate\": \"2024-01-01\", \"endDate\": \"2024-01-31\"}"
            });
          }
          
          // Filter appointments by date
          const response = await getAppointments(passKey, orgId);
          // Handle BSA response structure (DataObject wrapper or array format)
          const normalizedResponse = normalizeBSAResponse(response);
          const data = normalizedResponse.DataObject || normalizedResponse;
          const filtered = data.Items?.filter(apt => {
            const aptDate = new Date(apt.StartTime);
            return aptDate >= startDateObj && aptDate <= endDateObj;
          });
          
          return JSON.stringify({
            dateRange: { startDate, endDate },
            count: filtered?.length || 0,
            appointments: filtered?.slice(0, 10)
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to search appointments: ${error.message}` 
          });
        }
      }
    }),
    
    new DynamicTool({
      name: "get_organizations",
      description: "List available organizations. Use when user needs to select an organization.",
      func: async () => {
        try {
          const orgs = await fetchOrganizations(passKey);
          return JSON.stringify({
            organizations: orgs,
            count: orgs.length
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to fetch organizations: ${error.message}` 
          });
        }
      }
    })
  ];
}

// Create Calendar Agent
async function createCalendarAgent(passKey, orgId) {
  // Dynamic imports for LangChain
  const { DynamicTool } = await import("@langchain/core/tools");
  const { ChatOpenAI } = await import("@langchain/openai");
  const { AgentExecutor, createOpenAIFunctionsAgent } = await import("langchain/agents");
  const { ChatPromptTemplate } = await import("@langchain/core/prompts");
  
  const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0
  });
  
  const tools = createCalendarTools(DynamicTool, passKey, orgId);
  
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a helpful calendar assistant. Use the available tools to answer questions about appointments, meetings, and schedules. Be concise and informative."],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"]
  ]);
  
  const agent = await createOpenAIFunctionsAgent({
    llm,
    tools,
    prompt
  });
  
  return new AgentExecutor({
    agent,
    tools,
    verbose: true // Set to false in production
  });
}

// Assistant endpoint with Calendar Agent
app.post("/api/assistant/query", async (req, res) => {
  const requestId = crypto.randomBytes(8).toString('hex');
  
  try {
    const { query, session_id, org_id } = req.body;
    console.log(`[ASSISTANT:${requestId}] Query: "${query}"`);
    
    // Validate session
    const passKey = await getValidPassKey(session_id);
    if (!passKey) {
      return res.status(401).json({ error: "not authenticated" });
    }
    
    if (!org_id) {
      return res.status(400).json({ 
        error: "Please select an organization first" 
      });
    }
    
    // Create and execute Calendar Agent
    const agent = await createCalendarAgent(passKey, org_id);
    const result = await agent.invoke({ input: query });
    
    res.json({ 
      query,
      response: result.output,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`[ASSISTANT:${requestId}] Error:`, error);
    res.status(500).json({ 
      error: "Failed to process query",
      details: error.message 
    });
  }
});
```

#### 1.5 Frontend Implementation

##### 1.5.1 Update UI (`/extension/sidepanel.html`)
Add assistant section in authenticated view:
```html
<!-- Add inside auth-section, before org-section -->
<div id="assistant-section" class="card">
  <h3>AI Assistant</h3>
  <div class="query-container">
    <input type="text" id="query-input" 
           placeholder="Ask about calendar events, contacts, or organizations...">
    <button id="query-submit" class="btn btn-primary">
      <span class="btn-icon">🤖</span> Ask
    </button>
  </div>
  <div id="response-container" class="hidden">
    <div id="response-loading" class="loading hidden">
      Processing your request...
    </div>
    <div id="response-content"></div>
  </div>
</div>
```

##### 1.5.2 JavaScript Handler (`/extension/sidepanel.js`)
Add after existing code:
```javascript
// Assistant functionality
function initAssistant() {
  const queryInput = document.getElementById('query-input');
  const querySubmit = document.getElementById('query-submit');
  const responseContainer = document.getElementById('response-container');
  const responseContent = document.getElementById('response-content');
  
  if (!queryInput || !querySubmit) return;
  
  querySubmit.addEventListener('click', handleAssistantQuery);
  queryInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleAssistantQuery();
  });
  
  async function handleAssistantQuery() {
    const query = queryInput.value.trim();
    if (!query) return;
    
    const sessionId = getSessionId();
    const orgId = currentOrgId;
    
    if (!sessionId) {
      showError('Please login first');
      return;
    }
    
    // Check if organization is selected
    if (!orgId) {
      showError('Please select an organization first');
      // Optionally show the org selection UI
      showOrganizations();
      return;
    }
    
    responseContainer.classList.remove('hidden');
    showLoading('response-loading', true);
    responseContent.innerHTML = '';
    
    try {
      const response = await fetch(`${APP_BASE}/api/assistant/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          session_id: sessionId,
          org_id: orgId
        })
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          showError('Session expired. Please login again.');
          return;
        }
        if (response.status === 400) {
          const errorData = await response.json();
          if (errorData.error === 'Please select an organization first') {
            showError('Please select an organization first');
            showOrganizations();
            return;
          }
        }
        throw new Error('Request failed');
      }
      
      const data = await response.json();
      
      responseContent.innerHTML = `
        <div class="assistant-response">
          ${formatAssistantResult(data)}
        </div>
      `;
      
    } catch (error) {
      console.error('[ASSISTANT] Error:', error);
      showError('Failed to process request', 'response-content');
    } finally {
      showLoading('response-loading', false);
      queryInput.value = '';
    }
  }
  
  function formatAssistantResult(data) {
    if (data.error) {
      return `<span class="error">${escapeHtml(data.error)}</span>`;
    }
    if (data.response) {
      // Agent response is already formatted
      return escapeHtml(data.response);
    }
    // Fallback for raw data
    return `<pre>${JSON.stringify(data, null, 2)}</pre>`;
  }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAssistant);
} else {
  initAssistant();
}
```

### Phase 2: Task Agent and Orchestration (3-4 hours)

#### 2.1 Build Task Agent First (1-2 hours)
Create a second functional agent before adding orchestration:

##### 2.1.1 Task Agent Implementation
```javascript
// Add to api/index.js - Task Agent with Tools
function createTaskTools(DynamicTool, passKey, orgId) {
  return [
    new DynamicTool({
      name: "get_tasks",
      description: "Fetch tasks from BSA. Use when user asks about tasks or to-dos.",
      func: async (input) => {
        try {
          // Parse optional filter parameters
          const result = parseToolInput(input);
          if (result.isError) {
            return JSON.stringify({ error: result.error });
          }
          
          const options = result.data;
          
          // TODO: Replace with actual BSA task endpoint when provided
          const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json`;
          const payload = {
            PassKey: passKey,
            OrganizationId: orgId,
            ObjectName: "task", // TBD - actual ObjectName
            ...options // Allow additional filter options
          };
          
          const resp = await axios.post(url, payload, axiosConfig);
          // Handle BSA array wrapper format: [{ Results: [...], Valid: true }]
          const normalized = normalizeBSAResponse(resp.data);
          
          // Check for error indicators in response
          if (!normalized.valid) {
            return JSON.stringify({ 
              error: normalized.error || "BSA API error" 
            });
          }
          
          return JSON.stringify({
            tasks: normalized.data?.Results || [],
            count: normalized.data?.Results?.length || 0,
            total: normalized.data?.TotalResults || 0
          });
        } catch (error) {
          console.error("[Task Tool] Error fetching tasks:", error);
          return JSON.stringify({ 
            error: `Failed to fetch tasks: ${error.message}` 
          });
        }
      }
    }),
    
    new DynamicTool({
      name: "create_task",
      description: "Create a new task. Input should be JSON with task details including at minimum a 'title' field.",
      func: async (input) => {
        try {
          const result = parseToolInput(input, { 
            required: ['title'] 
          });
          if (result.isError) {
            return JSON.stringify({ 
              error: result.error,
              example: "Expected format: {\"title\": \"Task name\", \"description\": \"Optional description\", \"dueDate\": \"2024-01-31\"}"
            });
          }
          
          const taskData = result.data;
          
          // Validate title is not empty
          if (!taskData.title || taskData.title.trim() === '') {
            return JSON.stringify({ 
              error: "Task title cannot be empty" 
            });
          }
          
          // TODO: Implement task creation when BSA endpoint is provided
          return JSON.stringify({ 
            success: true, 
            task: taskData,
            message: "Task creation simulated (BSA endpoint not yet implemented)"
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to create task: ${error.message}` 
          });
        }
      }
    }),
    
    new DynamicTool({
      name: "update_task_status",
      description: "Update task status. Input should be JSON with taskId and status.",
      func: async (input) => {
        try {
          const result = parseToolInput(input, { 
            required: ['taskId', 'status'] 
          });
          if (result.isError) {
            return JSON.stringify({ 
              error: result.error,
              example: "Expected format: {\"taskId\": \"task_123\", \"status\": \"completed\"}"
            });
          }
          
          const { taskId, status } = result.data;
          
          // Validate status value (example validation)
          const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
          if (!validStatuses.includes(status.toLowerCase())) {
            return JSON.stringify({ 
              error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
            });
          }
          
          // TODO: Implement task update when BSA endpoint is provided
          return JSON.stringify({ 
            success: true, 
            taskId, 
            status,
            message: "Task update simulated (BSA endpoint not yet implemented)"
          });
        } catch (error) {
          return JSON.stringify({ 
            error: `Failed to update task: ${error.message}` 
          });
        }
      }
    })
  ];
}

async function createTaskAgent(passKey, orgId) {
  // Dynamic imports for LangChain
  const { DynamicTool } = await import("@langchain/core/tools");
  const { ChatOpenAI } = await import("@langchain/openai");
  const { AgentExecutor, createOpenAIFunctionsAgent } = await import("langchain/agents");
  const { ChatPromptTemplate } = await import("@langchain/core/prompts");
  
  const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0
  });
  
  const tools = createTaskTools(DynamicTool, passKey, orgId);
  
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a helpful task management assistant. Use the available tools to help manage tasks and to-dos."],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"]
  ]);
  
  const agent = await createOpenAIFunctionsAgent({
    llm,
    tools,
    prompt
  });
  
  return new AgentExecutor({
    agent,
    tools,
    verbose: true
  });
}

// Test endpoint for Task Agent (before orchestration)
app.post("/api/assistant/task", async (req, res) => {
  const requestId = crypto.randomBytes(8).toString('hex');
  
  try {
    const { query, session_id, org_id } = req.body;
    console.log(`[TASK:${requestId}] Query: "${query}"`);
    
    const passKey = await getValidPassKey(session_id);
    if (!passKey) {
      return res.status(401).json({ error: "not authenticated" });
    }
    
    const agent = await createTaskAgent(passKey, org_id);
    const result = await agent.invoke({ input: query });
    
    res.json({ 
      query,
      response: result.output,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`[TASK:${requestId}] Error:`, error);
    res.status(500).json({ error: "Failed to process task query" });
  }
});
```

#### 2.2 Install LangGraph for Orchestration (After Task Agent Works)
```bash
npm install @langchain/langgraph
```

#### 2.3 Add Orchestration Layer
Now that we have two working agents, add the orchestration layer:

##### 2.3.1 Create Supervisor for Multi-Agent Coordination
```javascript
// Add orchestration to api/index.js
async function createOrchestrator(passKey, orgId) {
  const { StateGraph, START, END, Annotation } = await import("@langchain/langgraph");
  const { ChatOpenAI } = await import("@langchain/openai");
  
  // Define state structure
  const AgentState = Annotation.Root({
    query: Annotation(),
    selectedAgent: Annotation(),
    result: Annotation()
  });
  
  // Supervisor node - routes to appropriate agent
  async function supervisorNode(state) {
    const llm = new ChatOpenAI({ 
      model: "gpt-4o-mini",
      temperature: 0
    });
    
    const query = state.query;
    const routingPrompt = `Route this query to the appropriate agent.
    Available agents: calendar (for appointments/meetings), task (for todos/tasks), general (for other queries).
    Query: ${query}
    Agent (one word):`;
    
    const response = await llm.invoke(routingPrompt);
    const agent = response.content.toLowerCase().trim();
    
    return {
      selectedAgent: agent,
      next: agent === "general" ? END : agent + "_agent"
    };
  }
  
  // Calendar Agent node
  async function calendarAgentNode(state) {
    const { query } = state;
    const agent = await createCalendarAgent(passKey, orgId);
    const result = await agent.invoke({ input: query });
    return { result: result.output, next: END };
  }
  
  // Task Agent node
  async function taskAgentNode(state) {
    const { query } = state;
    const agent = await createTaskAgent(passKey, orgId);
    const result = await agent.invoke({ input: query });
    return { result: result.output, next: END };
  }
  
  // Build and compile graph with multiple agents
  const workflow = new StateGraph(AgentState);
  
  // Add nodes
  workflow.addNode("supervisor", supervisorNode);
  workflow.addNode("calendar_agent", calendarAgentNode);
  workflow.addNode("task_agent", taskAgentNode);
  
  // Add edges
  workflow.addEdge(START, "supervisor");
  
  // Conditional routing from supervisor
  workflow.addConditionalEdges(
    "supervisor",
    (state) => state.next,
    {
      "calendar_agent": "calendar_agent",
      "task_agent": "task_agent",
      END: END
    }
  );
  
  // Agents return to END
  workflow.addEdge("calendar_agent", END);
  workflow.addEdge("task_agent", END);
  
  return workflow.compile();
}
```

##### 2.3.2 Refactor Agents to Work Within Orchestration
The Calendar Agent and Task Agent created earlier can now be called as nodes within the orchestration graph. Each agent maintains its own tool-calling capabilities but operates within the supervisor's routing logic.

#### 2.4 Create Orchestrated Endpoint
After both agents are working independently, create the orchestrated endpoint that uses LangGraph:
```javascript
// Phase 2: Orchestrated endpoint with LangGraph
app.post("/api/assistant/query/v2", async (req, res) => {
  const requestId = crypto.randomBytes(8).toString('hex');
  
  try {
    const { query, session_id, org_id } = req.body;
    console.log(`[ORCHESTRATOR:${requestId}] Query: "${query}"`);
    
    // Validate session
    const passKey = await getValidPassKey(session_id);
    if (!passKey) {
      return res.status(401).json({ error: "not authenticated" });
    }
    
    if (!org_id) {
      return res.status(400).json({ 
        error: "Please select an organization first" 
      });
    }
    
    // Create orchestrator with multiple agents
    const orchestrator = await createOrchestrator(passKey, org_id);
    
    // Execute orchestration graph - supervisor will route to appropriate agent
    const result = await orchestrator.invoke({
      query: query
    });
    
    console.log(`[ORCHESTRATOR:${requestId}] Complete`);
    res.json({
      query,
      ...result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`[ORCHESTRATOR:${requestId}] Error:`, error);
    res.status(500).json({ 
      error: "Failed to process query",
      details: error.message 
    });
  }
});
```

#### 2.5 Security & Rate Limiting
```javascript
// Optional: Add request validation with zod (if installed)
const { z } = require('zod'); // Only if adding validation

const assistantQuerySchema = z.object({
  query: z.string().min(1).max(500),
  session_id: z.string(),
  org_id: z.string().optional()
});

// In request handler:
// const validated = assistantQuerySchema.parse(req.body);

// In-memory rate limiting (per-instance)
// TODO: When scaling beyond single instance, migrate to:
// - Memorystore for Redis (for sub-ms latency)
// - Firestore (for persistence)
// - Or use Cloud Armor rate limiting at ingress
const rateLimitWindows = new Map();

function checkRateLimit(sessionId) {
  const now = Date.now();
  const limit = 10; // 10 requests
  const window = 60000; // per minute
  
  // Periodic cleanup to prevent memory leaks (1% chance)
  if (Math.random() < 0.01) {
    for (const [key, timestamps] of rateLimitWindows.entries()) {
      const valid = timestamps.filter(t => now - t < window);
      if (valid.length === 0) {
        rateLimitWindows.delete(key);
      } else {
        rateLimitWindows.set(key, valid);
      }
    }
  }
  
  const timestamps = rateLimitWindows.get(sessionId) || [];
  const recentRequests = timestamps.filter(t => now - t < window);
  
  if (recentRequests.length >= limit) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimitWindows.set(sessionId, recentRequests);
  return true;
}

// Add to assistant endpoint
app.post("/api/assistant/query", async (req, res) => {
  const { session_id, query } = req.body;
  
  // Rate limiting
  if (!checkRateLimit(session_id)) {
    return res.status(429).json({ 
      error: "Rate limit exceeded",
      retryAfter: 60 
    });
  }
  
  // Input validation
  if (!query || query.length > 500) {
    return res.status(400).json({ 
      error: "Query must be between 1 and 500 characters" 
    });
  }
  
  // ... rest of implementation
});
```

### Phase 3: Additional Agents (2-3 hours)

#### 3.1 Contact Agent
Add enhanced contact search capabilities when needed:

```javascript
// Future: Add Contact Agent for complex contact queries
// This would include tools for searching, filtering, and managing contacts
// Implementation similar to Calendar and Task agents
```

### Phase 4: Testing & Refinement (1 hour)

#### 4.1 Test Scenarios
1. **Basic Flow**
   - "Show me my contacts"
   - "List organizations"
   - "What calendar events do I have?"

2. **Error Handling**
   - Invalid session → 401 response
   - Missing org_id → Helpful error message
   - Rate limiting → 429 response

3. **Vercel Deployment Testing**
   - Deploy to preview environment first
   - Test dynamic imports work on Vercel
   - Verify environment variables are set
   - Check response times and performance

#### 4.2 Testing Strategy
```javascript
// Deploy to Vercel staging/preview first
vercel

// Test endpoints on Vercel preview URL
curl -X POST https://your-preview-url.vercel.app/api/assistant/query \
  -H "Content-Type: application/json" \
  -d '{"query": "show contacts", "session_id": "xxx", "org_id": "xxx"}'

// Use actual session from Chrome extension
// 1. Login via extension 
// 2. Get session_id from Chrome DevTools
// 3. Test new endpoints with real session
```

## Implementation Approach & Key Decisions

### Phased Rollout Strategy
1. **Phase 1 (Hour 1-4)**: Calendar Agent with Tools
   - Install @langchain/openai and core dependencies
   - Create Calendar Agent with tool-calling capabilities
   - Agent decides which BSA endpoints to call
   - Build chat interface in Chrome extension
   - Test with queries like "What's on my calendar today?"
   - Deploy to Vercel and test end-to-end

2. **Phase 2 (Hour 5-8)**: Task Agent and Orchestration
   - Build Task Agent with its own tools first
   - Test Task Agent independently at `/api/assistant/task`
   - Install @langchain/langgraph after both agents work
   - Create Supervisor Agent for routing
   - Refactor both agents to work within orchestration
   - Test routing between Calendar and Task agents

3. **Phase 3 (Hour 9)**: Additional Agents
   - Add Contact Agent for complex contact searches
   - Add more specialized agents as needed
   - Enable multi-agent collaboration

4. **Phase 4 (Future)**: Add streaming
   - Only after everything works reliably
   - Use SSE with proper headers for Cloud Run
   - Consider separate service for streaming endpoints

## Critical Implementation Notes

### Testing Limitations
- **OAuth flow requires production** - BSA redirects to production URL only
- **Use Vercel preview deployments** - Test new features on staging URLs
- **Real session required** - Get session_id from authenticated Chrome extension
- **No localhost testing** - Extension always connects to production/preview URLs

### CommonJS Compatibility
- **Backend remains CommonJS** - No migration to ESM needed
- **Use dynamic imports** for LangChain/LangGraph packages
- **No TypeScript** - Plain JavaScript only
- **Single file integration** - Add to existing `api/index.js`

### Performance Optimizations
- **Module caching**: Cache both promises and results to prevent duplicate imports
- **HTTP Keep-Alive**: Reuse connections for BSA API calls
- **AbortController**: Handle client disconnects gracefully
- **Request tracking**: Use request IDs for debugging and monitoring
- **Metrics collection**: Track cold starts, import times, and state transitions

### Recommended Implementation Order
1. **Phase 1**: Calendar Agent with tools (functional agent, not just classifier)
2. **Phase 2A**: Task Agent with tools (second functional agent)
3. **Phase 2B**: LangGraph orchestration (connect both agents with supervisor)
4. **Phase 3**: Additional specialized agents
5. **Phase 4**: Streaming and advanced features

### Model Selection
- **gpt-4o-mini**: For intent classification (fast, cheap)
- **gpt-3.5-turbo**: Alternative for cost savings
- **gpt-4**: Reserve for complex analysis only

### Frontend Integration
- Use existing `APP_BASE` constant (not `API_BASE`)
- Use existing `getSessionId()` function
- Use existing `currentOrgId` variable
- Start with JSON responses, add streaming later

## BSA API Integration

### BSA Response Format Patterns

BSA APIs have specific response formats that must be handled correctly:

#### PassKey Response Format (OAuth2 Endpoint - Special Case)
**IMPORTANT**: The `/oauth2/passkey` endpoint returns a **plain object**, NOT an array like other BSA endpoints:
```javascript
// PassKey response from /oauth2/passkey endpoint (actual format from logs)
{
  "passkey": "2Z-37xse5Wg1E4GFix9DCoBaoLO7PoYEXVVYhrs0bV7FW_nZnXlF36JeXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
  "user_id": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
  "expires_in": 3600
}
// Note: Field is lowercase "passkey", not "PassKey"
// Note: No array wrapper, unlike all other BSA endpoints
```

#### Handling Different Response Formats
BSA endpoints have two distinct response patterns:
```javascript
// Pattern 1: OAuth2 PassKey endpoint (plain object)
const passKeyResponse = response.data; // Direct object, no array
const passKey = passKeyResponse?.passkey; // lowercase field

// Pattern 2: All other BSA endpoints (array wrapper)
const responseData = Array.isArray(response.data) ? response.data[0] : response.data;
const results = responseData?.Results;
```

#### Known Response Formats by Endpoint

1. **PassKey Endpoint** (`/oauth2/passkey`) - **UNIQUE FORMAT**
   - Returns: Plain object (NO array wrapper)
   - Fields: `passkey` (lowercase), `user_id`, `expires_in`
   - Example: `{ "passkey": "...", "user_id": "...", "expires_in": 3600 }`
   - **Note**: This is the ONLY BSA endpoint that doesn't use array wrapper

2. **Organizations Endpoint** (`/listMyOrganizations.json`)
   - Returns: **Array** with single object containing Organizations array
   - Fields: `Organizations` array, `Valid`, `TotalResults`, `ResponseMessage`
   - Example: `[{ "Organizations": [...], "Valid": true, "TotalResults": 0 }]`
   - Organization fields: `Id`, `Name`, `City`, `State`, `Country`, `EmailAddress`, etc.

3. **List Endpoints** (`/list.json`) for Contacts/Appointments/etc.
   - Returns: **Array** with single object containing Results array
   - Fields: `Results`, `Valid`, `TotalResults`, `ResponseMessage`
   - Example: `[{ "Results": [...], "Valid": true, "TotalResults": 42 }]`
   - Note: Results field, NOT Items field

4. **Linked Data Endpoint** (`/listLinked.json`)
   - Returns: **Array** with single object containing Results array
   - Fields: `Results` containing linked objects, `Valid`, `TotalResults`
   - Example: `[{ "Results": [...], "Valid": true, "TotalResults": 5 }]`

### Known Working Endpoints
```javascript
// Confirmed working endpoints
const workingEndpoints = {
  // Organization listing
  organizations: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json',
  
  // Contact operations
  contacts: '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json',
  // ObjectName: "contact"
  
  // Calendar/Appointment operations
  appointments: '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json',
  // ObjectName: "appointment"
  
  // Linked data operations (for getting contacts linked to appointments)
  linkedContacts: '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/listLinked.json',
  // ObjectName: "linker_appointments_contacts", ListObjectName: "contact"
};

// Future endpoints to integrate (when provided)
const futureEndpoints = {
  tasks: 'TBD',      // ObjectName to be confirmed
  events: 'TBD',     // ObjectName to be confirmed
  meetings: 'TBD'    // ObjectName to be confirmed
};
```

## Security Considerations

### Maintained Security Features
- PassKeys remain server-side only
- Session validation on every request
- Automatic token refresh
- No sensitive data in LLM context

### New Security Measures
- Rate limiting for AI queries
- Input sanitization before LLM
- Response filtering
- Audit logging for AI interactions

## Cloud Run Migration Notes

```javascript
/* Cloud Run Deployment Configuration:
 * 
 * Service Configuration:
 * - Request timeout: Set in Cloud Run service YAML (max 60 min)
 * - Concurrency: Start with 80-100 for JSON endpoints, 5-20 for future SSE
 * - Min instances: Start with 0, consider 1+ for production
 * - CPU allocation: "CPU is allocated only during request processing"
 * - Memory: 512MB minimum, 1GB recommended for LangChain
 * 
 * Security & Secrets:
 * - Use Google Secret Manager for sensitive env vars:
 *   - OPENAI_API_KEY
 *   - BSA_CLIENT_ID, BSA_CLIENT_SECRET
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * - Configure static egress IPs if BSA requires IP allowlisting
 * 
 * For SSE endpoints (future):
 * - SSE is supported but may be buffered by intermediaries
 * - Test end-to-end through Cloud Run proxy
 * - Consider separate service with lower concurrency
 * - Set headers: Content-Type: text/event-stream, Cache-Control: no-cache
 * - May need instance-based billing for long-lived connections
 * 
 * ESM Migration (when moving to Cloud Run):
 * - Add "type": "module" to package.json
 * - Convert all require() to import statements
 * - Update module.exports to export statements
 * - Static imports will improve cold start performance
 */
```

## Future Enhancements

### Phase 5: Additional Agents
1. **Contact Agent**: Enhanced contact search with advanced filtering
2. **Report Agent**: Generate summaries and insights
3. **Analytics Agent**: Data analysis and trends

### Phase 6: Advanced Features
1. **Memory System**: Conversation persistence
2. **Human-in-the-Loop**: Approval workflows
3. **Multi-step Planning**: Complex task execution
4. **Proactive Suggestions**: Context-aware recommendations

### Phase 7: Optimization
1. **Response Caching**: Reduce API calls
2. **Parallel Execution**: Multiple agents simultaneously
3. **Error Recovery**: Automatic retry logic
4. **Performance Monitoring**: LangSmith integration

## Success Metrics

### Technical Metrics
- Response time < 3 seconds
- Streaming latency < 500ms
- Intent classification accuracy > 90%
- Error rate < 5%

### User Experience Metrics
- Query understanding rate
- Task completion rate
- User satisfaction score
- Feature adoption rate

## Risk Mitigation

### Identified Risks
1. **BSA API limitations**: Unknown endpoints/rate limits
2. **LLM costs**: OpenAI API usage
3. **Complexity**: Graph debugging challenges
4. **Performance**: Streaming bottlenecks

### Mitigation Strategies
1. Implement caching layer
2. Use GPT-3.5 for simple queries
3. Comprehensive logging
4. Connection pooling

## Conclusion

This agent-first approach prioritizes:
- **Functional agents over simple classifiers** - Phase 1 delivers real tool-calling capabilities
- **Incremental complexity** - Add orchestration only when multiple agents exist
- **User value first** - Calendar Agent immediately useful, not just intent routing
- **CommonJS compatibility** - No module system migration needed
- **Production readiness** - Test on Vercel early and often

---

**Implementation Checklist**:

Phase 1 - Calendar Agent with Tools (COMPLETE ✅):
- [x] Install `@langchain/openai` and `@langchain/core` dependencies
- [x] Add OPENAI_API_KEY to Vercel environment variables
- [x] Add performance optimizations to api/index.js (keep-alive, module caching)
- [x] Create Calendar Agent with tool definitions (5 tools implemented)
- [x] Implement `/api/assistant/query` endpoint with agent executor
- [x] Add AI Assistant UI section to sidepanel.html
- [x] Implement chat functionality in sidepanel.js
- [x] Deploy to Vercel production environment
- [x] Test queries: Successfully handling date-based appointment queries

**Phase 1 Implementation Summary**:
- **Tools Created**: 5 functional tools using `tool()` with Zod schemas
  - get_appointments (with optional limit/offset)
  - search_appointments_by_date (date range filtering)
  - get_appointment_details (by ID)
  - get_appointment_contacts (linked contacts)
  - get_organizations (list available orgs)
- **Agent Type**: createToolCallingAgent (not deprecated Functions agent)
- **Model**: gpt-4o-mini for efficiency
- **Response Format**: JSON with proper BSA data formatting
- **Error Handling**: Comprehensive with helpful error messages
- **Security**: PassKey validation, org_id requirement, session checks

Phase 2 - Task Agent and Orchestration:
- [ ] Create Task Agent with tool definitions (get_tasks, create_task, update_task)
- [ ] Implement `/api/assistant/task` endpoint for testing Task Agent
- [ ] Test Task Agent independently with task-related queries
- [ ] Install `@langchain/langgraph` dependency
- [ ] Create Supervisor Agent for routing between agents
- [ ] Refactor Calendar Agent to work as orchestration node
- [ ] Refactor Task Agent to work as orchestration node
- [ ] Implement `/api/assistant/query/v2` with full orchestration
- [ ] Test routing: "What's on my calendar?" vs "What tasks do I have?"
- [ ] Update frontend to use v2 endpoint

Phase 3 - Additional Agents:
- [ ] Enhance Task Agent when additional BSA task endpoints are provided
- [ ] Create Contact Agent for complex contact searches
- [ ] Add agents to orchestrator routing
- [ ] Test multi-agent collaboration scenarios
- [ ] Implement cross-agent data sharing if needed
- [ ] Test complex queries requiring multiple agents

Phase 4 - Testing & Optimization:
- [ ] Add rate limiting and input validation
- [ ] Implement comprehensive error handling
- [ ] Test all query types: contacts, organizations, calendar
- [ ] Optimize response formatting
- [ ] Performance testing and monitoring

**Key Success Criteria**:
- ✅ Working code over perfect architecture
- ✅ Test on production (Vercel) early
- ✅ Maintain existing security model
- ✅ Compatible with future Cloud Run migration
- ❌ No breaking changes to existing functionality