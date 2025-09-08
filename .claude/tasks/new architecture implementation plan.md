# Complete Implementation Plan for Multi-Agent LangGraph Architecture

## Phase 1: Database & Infrastructure Setup (Day 1) ✅ COMPLETED

### 1.1 Database Migrations
```sql
-- Enable pgvector extension (REQUIRED FIRST)
CREATE EXTENSION IF NOT EXISTS vector;

-- Long-term memory tables with RLS
CREATE TABLE ltm_memories (
  key uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  user_id text NOT NULL,
  namespace text[] NOT NULL,
  kind text NOT NULL CHECK (kind IN ('user_pref', 'team_info', 'client_note', 'fact')),
  subject_id text,
  text text NOT NULL,
  importance int DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source text DEFAULT 'manual' CHECK (source IN ('manual', 'auto', 'suggested')),
  ttl_days int,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  embedding vector(1536)
);
ALTER TABLE ltm_memories ENABLE ROW LEVEL SECURITY;

-- Performance indexes for memories
CREATE INDEX ltm_memories_org_user_idx ON ltm_memories(org_id, user_id, created_at DESC);
CREATE INDEX ltm_memories_kind_idx ON ltm_memories(kind);
CREATE INDEX ltm_memories_namespace_gin ON ltm_memories USING gin(namespace);
CREATE INDEX ltm_memories_embedding_idx ON ltm_memories USING ivfflat (embedding vector_l2_ops) WITH (lists = 100);

-- Knowledge Base tables
CREATE TABLE kb_docsets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  version text NOT NULL,
  is_active boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE kb_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  docset_id uuid REFERENCES kb_docsets(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  url text,
  updated_at timestamptz NOT NULL,
  body_md text NOT NULL
);

CREATE TABLE kb_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id uuid REFERENCES kb_docs(id) ON DELETE CASCADE,
  chunk_no int NOT NULL,
  text text NOT NULL,
  headings text[],
  tokens int,
  embedding vector(1536)
);

-- KB indexes
CREATE INDEX kb_docs_docset_idx ON kb_docs(docset_id);
CREATE INDEX kb_chunks_doc_idx ON kb_chunks(doc_id, chunk_no);
CREATE INDEX kb_chunks_embedding_idx ON kb_chunks USING ivfflat (embedding vector_l2_ops) WITH (lists = 100);

-- CRITICAL: Do NOT create store tables manually - LangGraph manages its own schema
-- These will be created by running: await checkpointer.setup(); await store.setup();

-- Dedupe table for idempotency (CRITICAL for BSA)
CREATE TABLE action_dedupe (
  hash text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX action_dedupe_created_idx ON action_dedupe(created_at);

-- Mem0 suggestions table
CREATE TABLE mem0_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  user_id text NOT NULL,
  text text NOT NULL,
  kind text,
  subject_id text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE mem0_suggestions ENABLE ROW LEVEL SECURITY;

-- KB semantic search function (REQUIRED)
CREATE OR REPLACE FUNCTION kb_semantic_search(
  docset_id uuid,
  query_vec vector(1536),
  match_count int DEFAULT 6
)
RETURNS TABLE (
  doc_id uuid,
  chunk_id uuid,
  score float4,
  text text
)
LANGUAGE sql STABLE AS $$
  SELECT c.doc_id, c.id AS chunk_id,
         1 - (c.embedding <=> query_vec) AS score,
         c.text
  FROM kb_chunks c
  JOIN kb_docs d ON d.id = c.doc_id
  WHERE d.docset_id = kb_semantic_search.docset_id
  ORDER BY c.embedding <=> query_vec
  LIMIT match_count;
$$;

-- TTL cleanup function
CREATE OR REPLACE FUNCTION purge_expired_memories()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM ltm_memories
  WHERE ttl_days IS NOT NULL
    AND created_at < now() - (ttl_days || ' days')::interval;
END; 
$$;
```

### 1.2 Package Dependencies ✅ COMPLETED
```bash
# Core LangGraph packages
pnpm add @langchain/langgraph-checkpoint-postgres
pnpm add mem0ai
pnpm add uuid
pnpm add cross-fetch

# Already have: @langchain/langgraph, @langchain/core, @langchain/openai, zod
```

### 1.3 Critical Setup Script (MUST RUN FIRST)
```javascript
// api/scripts/setup.js - Run this ONCE before Phase 2
// This creates LangGraph's internal tables for checkpointer and store
node api/scripts/setup.js
```

## Phase 2: New File Structure (Day 1-2)

```
/api/
├── index.js                      # Main Express server (modified)
├── graph/
│   ├── state.ts                  # Graph state with checkpointer & store
│   ├── orchestrator.ts           # Main graph builder
│   ├── intent.ts                 # Intent classification node
│   ├── plan.ts                   # Planner node (DAG generation)
│   ├── parallel.ts               # Fan-out/fan-in logic
│   ├── approval.ts               # Approval gate with interrupt
│   └── response.ts               # Conversational finalizer
├── memory/
│   ├── recall.ts                 # Memory recall before planning
│   ├── synthesize.ts             # Extract memories after actions
│   ├── mem0.ts                   # Mem0 integration
│   └── crud.ts                   # Memory CRUD operations
├── kb/
│   ├── ingestion.ts              # Ingest BSA docs
│   ├── retrieval.ts              # Semantic search
│   └── nodes.ts                  # KB graph nodes
├── tools/
│   ├── bsa.ts                    # BSA API tools (refactored)
│   ├── workflow.ts               # Workflow-specific tools
│   ├── task.ts                   # Task management tools
│   └── appointment.ts            # Appointment tools
├── agents/
│   ├── workflowDesigner.ts       # Design workflow specs
│   ├── workflowApplier.ts        # Apply workflow to BSA
│   ├── taskDesigner.ts           # Design task specs
│   ├── taskApplier.ts            # Apply tasks to BSA
│   ├── appointmentDesigner.ts    # Design appointment specs
│   └── appointmentApplier.ts     # Apply appointments to BSA
├── lib/
│   ├── supabase.ts              # Supabase helpers
│   ├── embeddings.ts            # OpenAI embeddings
│   └── dateParser.js            # Keep existing date parser
└── routes/
    ├── agent.ts                  # Main agent execution route
    ├── memory.ts                 # Memory CRUD routes
    └── kb.ts                     # Knowledge base routes
```

## Phase 3: Core Implementation Steps (Day 2-4)

### 3.1 Graph State & Persistence (CORRECTED)
```javascript
// api/graph/state.js - Use singleton pattern for performance
let checkpointerInstance = null;
let storeInstance = null;

async function getAppState() {
  const { Annotation, MessagesAnnotation } = await import("@langchain/langgraph");
  
  return Annotation.Root({
    ...MessagesAnnotation.spec,
    plan: Annotation({ default: () => [] }),
    cursor: Annotation({ default: () => 0 }),
    previews: Annotation({ 
      default: () => [], 
      reducer: (a, b) => a.concat(b) 
    }),
    approvals: Annotation({ default: () => null }),
    artifacts: Annotation({ default: () => ({}) }),
    intent: Annotation({ default: () => null }),
    kb: Annotation({ default: () => null }),
    // CRITICAL: Add interrupt marker for approval detection
    interruptMarker: Annotation({ default: () => null })
  });
}

async function getCheckpointer() {
  if (!checkpointerInstance) {
    const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
    checkpointerInstance = PostgresSaver.fromConnString(process.env.SUPABASE_DB_URL);
    // Note: setup() already run via setup script
  }
  return checkpointerInstance;
}

async function getStore() {
  if (!storeInstance) {
    const { PostgresStore } = await import("@langchain/langgraph-checkpoint-postgres");
    const { OpenAIEmbeddings } = await import("@langchain/openai");
    
    const embeddings = new OpenAIEmbeddings({ model: "text-embedding-3-small" });
    storeInstance = PostgresStore.fromConnString(process.env.SUPABASE_DB_URL, {
      index: { embeddings, dims: 1536, fields: ["text"] }
    });
    // Note: setup() already run via setup script
  }
  return storeInstance;
}
```

### 3.2 BSA Tool Integration Pattern (WITH DEDUPE)
```javascript
// api/tools/bsa.js - CRITICAL: All BSA writes must use dedupe
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { withDedupe } = require("../lib/dedupe");

function makePoster(BSA_BASE, passKey, orgId) {
  const url = `${BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;
  
  return async (objectName, DataObject) => {
    const payload = {
      PassKey: passKey,
      OrganizationId: orgId,
      ObjectName: objectName,
      DataObject,
      IncludeExtendedProperties: false
    };
    
    // CRITICAL: Wrap with dedupe - 5 minute window
    return withDedupe(payload, 5 * 60 * 1000, async () => {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      if (!resp.ok) {
        throw new Error(`${objectName} create failed: ${resp.status}`);
      }
      
      return await resp.json();
    });
  };
}

function makeWorkflowTools(cfg) {
  const post = makePoster(cfg.BSA_BASE, cfg.passKey, cfg.orgId);
  
  return {
    createWorkflowShell: tool(
      async (i) => post("advocate_process", { 
        Name: i.name,
        Description: i.description || ""
      }),
      { 
        name: "bsa_create_workflow", 
        schema: z.object({
          name: z.string(),
          description: z.string().optional()
        })
      }
    ),
    
    addWorkflowStep: tool(
      async (i) => {
        // CRITICAL: Always convert times to UTC
        const startTimeUTC = i.startTime ? 
          new Date(i.startTime).toISOString() : null;
        const endTimeUTC = i.endTime ? 
          new Date(i.endTime).toISOString() : null;
        
        return post("advocate_process_template", {
          AdvocateProcessId: i.workflowId,
          Subject: i.subject,
          Sequence: i.sequence,
          DayOffset: i.dayOffset || 1,
          StartTime: startTimeUTC,
          EndTime: endTimeUTC,
          AllDay: i.allDay !== false,
          ActivityType: i.activityType || "Task",
          AssigneeType: i.assigneeType || "ContactsOwner",
          RollOver: i.rollOver !== false
        });
      },
      {
        name: "bsa_add_workflow_step",
        schema: z.object({
          workflowId: z.string(),
          subject: z.string(),
          sequence: z.number(),
          // ... full schema
        })
      }
    )
  };
}
```

### 3.3 Orchestrator Graph Wiring (WITH CACHING)
```javascript
// api/graph/orchestrator.js - CRITICAL: Build graph ONCE, cache it
let compiledGraph = null;

async function buildGraph() {
  if (compiledGraph) return compiledGraph; // Return cached
  
  const { StateGraph, START, END } = await import("@langchain/langgraph");
  const { getAppState, getCheckpointer, getStore } = require("./state");
  
  const AppState = await getAppState();
  const checkpointer = await getCheckpointer();
  const store = await getStore();
  
  const g = new StateGraph(AppState)
    .addNode("recall_memory", recallMemoryNode)
    .addNode("intent", intentNode)
    .addNode("plan", planNode)
    .addNode("fanOutDesign", fanOutDesign)
    .addNode("approval_batch", approvalBatchNode)
    .addNode("fanOutApply", fanOutApply)
    .addNode("synthesize_memory", synthesizeMemoryNode)
    .addNode("response_finalizer", responseFinalizerNode)
    // Add all designer/applier nodes
    .addEdge(START, "recall_memory")
    .addEdge("recall_memory", "intent")
    .addConditionalEdges("intent", (s) => 
      s.intent === "help_kb" ? ["kb_retrieve"] : ["plan"]
    )
    // ... complete graph wiring
  
  // CRITICAL: Compile with config
  compiledGraph = g.compile({ 
    checkpointer, 
    store,
    maxConcurrency: 3 // Limit for BSA API
  });
  
  return compiledGraph;
}

module.exports = { buildGraph };
```

### 3.4 Approval Node with Interrupt Detection
```javascript
// api/graph/approval.js - CRITICAL: Set interrupt marker
const { interrupt } = require("@langchain/langgraph");

async function approvalBatchNode(state, config) {
  if (!config?.configurable?.safe_mode) {
    return {}; // Auto-approve if safe mode off
  }
  
  const decision = interrupt({
    kind: "approval_batch",
    previews: state.previews
  });
  
  return {
    approvals: decision,
    interruptMarker: "PENDING_APPROVAL" // CRITICAL: Set marker
  };
}
```

## Phase 4: API Routes Integration (Day 4-5)

### 4.1 Main Agent Execution (WITH INTERRUPT DETECTION)
```javascript
app.post("/api/agent/execute", async (req, res) => {
  const { session_id, org_id, time_zone, query, safe_mode, thread_id } = req.body;
  
  // Get PassKey from existing system
  const passKey = await getValidPassKey(session_id);
  const userId = await getBsaUserId(session_id);
  
  const config = {
    configurable: {
      thread_id: thread_id ?? `${session_id}:${org_id}`,
      userId, 
      orgId: org_id,
      user_tz: time_zone ?? "UTC",
      safe_mode: safe_mode !== false,  // Default true
      passKey,
      BSA_BASE: process.env.BSA_BASE
    }
  };
  
  // Get cached graph
  const graph = await buildGraph();
  
  const out = await graph.invoke(
    { messages: [{ role: "human", content: query }] },
    config
  );
  
  // CRITICAL: Check interrupt marker instead of __interrupt__
  if (out.interruptMarker === "PENDING_APPROVAL") {
    return res.status(202).json({ 
      status: "PENDING_APPROVAL", 
      previews: out.previews,
      ui: out.ui 
    });
  }
  
  return res.json({ status: "DONE", result: out });
});
```

### 4.2 Approval Resume Route
```javascript
app.post("/api/agent/approve", async (req, res) => {
  const { session_id, org_id, thread_id, approvals } = req.body;
  
  const config = { 
    configurable: { 
      thread_id,
      // ... rest of config
    } 
  };
  
  const out = await graph.invoke(
    { __command__: { resume: approvals } },
    config
  );
  
  return res.json({ status: "RESUMED", result: out });
});
```

## Phase 5: Chrome Extension Updates (Day 5)

### 5.1 Handle New Response Format
```javascript
// sidepanel.js updates
async function handleAgentResponse(response) {
  if (response.status === "PENDING_APPROVAL") {
    showApprovalUI(response.interrupt.previews);
  } else {
    renderMessage(response.result.messages.at(-1));
    if (response.result.ui) {
      renderActionCards(response.result.ui.actions);
      renderCitations(response.result.ui.citations);
    }
  }
}
```

### 5.2 Memory Management UI
- Add new tab for "Manage Memories"
- CRUD interface for long-term memories
- Mem0 suggestions panel

## Phase 6: Testing & Deployment (Day 6)

### 6.1 Initialize Checkpointer & Store
```javascript
// One-time setup script
await checkpointer.setup();
await store.setup();
```

### 6.2 Environment Variables
```env
# Add to Vercel
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=bsa-multiagent
MEM0_API_KEY=your-key  # If using Mem0 cloud
```

## Key Implementation Order

1. **Day 1**: Database migrations + package installation ✅ COMPLETED
2. **Day 2**: Core graph state, checkpointer, store setup (IN PROGRESS)
3. **Day 3**: Intent → Plan → Design nodes
4. **Day 4**: Approval gates + Apply nodes
5. **Day 5**: Memory synthesis + Response finalizer
6. **Day 6**: Chrome extension updates + testing

## CRITICAL IMPLEMENTATION NOTES (MUST READ)

### ❗ What MUST Change from Original Plan

1. **LangGraph Store Tables**: Do NOT create manually. LangGraph manages its own schema via:
   ```javascript
   await checkpointer.setup();
   await store.setup();
   ```

2. **Dedupe for BSA Writes**: ALL BSA API calls must use `withDedupe()` wrapper:
   ```javascript
   return withDedupe(payload, 5 * 60 * 1000, async () => {
     // BSA API call here
   });
   ```

3. **Graph Compilation**: Build ONCE and cache at module level:
   ```javascript
   let compiledGraph = null;
   async function buildGraph() {
     if (compiledGraph) return compiledGraph;
     // ... build and compile
   }
   ```

4. **Interrupt Detection**: Use `interruptMarker` in state, not `__interrupt__`:
   ```javascript
   if (out.interruptMarker === "PENDING_APPROVAL") {
     // Handle approval
   }
   ```

5. **Timezone Conversion**: ALWAYS convert to UTC for BSA:
   ```javascript
   const utcTime = new Date(localTime).toISOString();
   ```

6. **Setup Order**: Run `setup.js` BEFORE any graph code:
   ```bash
   node api/scripts/setup.js  # Creates LangGraph tables
   ```

### ✅ What's Already Correct

- Phased approach with gradual rollout
- PassKey isolation via closures
- Memory system architecture
- Knowledge base with semantic search
- Parallel execution design

## Critical Success Factors

1. **PassKey Security**: Maintain isolation through configurable
2. **Backward Compatibility**: Keep /api/assistant/query working initially
3. **Incremental Testing**: Test each node independently first
4. **Monitoring**: Enable LangSmith tracing from start
5. **Error Recovery**: Supersteps ensure transactional consistency

## Migration Strategy

1. **Parallel Development**: Build new system alongside current
2. **Feature Flag**: Toggle between old/new with environment variable
3. **Gradual Rollout**: Start with read-only operations (KB queries)
4. **Full Cutover**: Once stable, deprecate old agent system

## Technical Decisions

### Why LangGraph over Simple Agents
- **Orchestration**: Complex multi-step workflows with dependencies
- **Parallelism**: Fan-out/fan-in for concurrent operations
- **State Management**: Persistent conversation state across turns
- **Human-in-the-loop**: Native support for approval gates
- **Memory**: Built-in Store with semantic search

### Why PostgresSaver over Custom
- **Battle-tested**: LangGraph's official persistence layer
- **Transactional**: Supersteps ensure consistency
- **Compatible**: Works with existing Supabase setup
- **Performance**: Optimized for graph checkpoints

### Why Mem0 for Suggestions
- **Auto-extraction**: Automatically suggests memories from conversations
- **User Control**: Users approve before storage
- **Integration**: Works alongside LangGraph Store

## Risk Mitigation

### Performance Risks
- **Solution**: Configure `maxConcurrency` to limit parallel branches
- **Monitoring**: Track response times via LangSmith

### Complexity Risks
- **Solution**: Incremental rollout with feature flags
- **Testing**: Each node tested independently first

### Security Risks
- **Solution**: PassKey isolation via configurable
- **Audit**: No PassKeys in prompts or logs

## Success Metrics

- **Response Time**: <3 seconds for simple queries
- **Approval Flow**: <5 seconds to interrupt and display
- **Memory Recall**: >80% relevance for recalled memories
- **KB Accuracy**: >90% correct citations
- **User Satisfaction**: Reduced repeat questions via memory

This plan transforms your current single-agent system into a sophisticated multi-agent orchestration platform with memory, knowledge base, and human-in-the-loop approvals.