# Corrected Phase 2 Implementation Plan

## ✅ Phase 1 Fixes Applied

### Database Corrections
- ✅ Removed manual store tables (LangGraph manages its own)
- ✅ Added `action_dedupe` table for idempotency
- ✅ Added `mem0_suggestions` table for auto-extracted memories
- ✅ Added performance indexes on all tables
- ✅ Created `kb_semantic_search` function for RAG
- ✅ Created `purge_expired_memories` function for TTL cleanup
- ✅ Enabled RLS on sensitive tables

### Infrastructure Setup
- ✅ Created `api/scripts/setup.js` to initialize LangGraph tables
- ✅ Created `api/lib/dedupe.js` for preventing duplicate BSA writes
- ✅ Created `api/graph/state.js` with proper singleton pattern

## Phase 2: Core Graph Implementation

### Directory Structure
```
/api/
├── graph/                    ✅ Created
│   ├── state.js             ✅ Complete - AppState, checkpointer, store
│   ├── orchestrator.js      📝 Next - Main graph builder
│   ├── intent.js            📝 Next - Intent classification
│   ├── plan.js              📝 Next - DAG planner
│   ├── parallel.js          📝 Next - Fan-out/fan-in
│   ├── approval.js          📝 Next - Approval gates
│   └── response.js          📝 Next - Conversational finalizer
├── tools/
│   ├── bsa.js               📝 Next - BSA tools with dedupe
│   ├── workflow.js          📝 Todo
│   ├── task.js              📝 Todo  
│   └── appointment.js       📝 Todo
├── agents/
│   ├── workflowDesigner.js  📝 Todo
│   ├── workflowApplier.js   📝 Todo
│   ├── taskDesigner.js      📝 Todo
│   ├── taskApplier.js       📝 Todo
│   └── appointmentDesigner/Applier.js
├── memory/
│   ├── recall.js            📝 Todo
│   ├── synthesize.js        📝 Todo
│   └── mem0.js              📝 Todo
├── kb/
│   ├── retrieval.js         📝 Todo
│   └── nodes.js             📝 Todo
└── routes/
    ├── agent.js             📝 Todo - Main execution route
    ├── memory.js            📝 Todo - Memory CRUD + suggestions
    └── kb.js                📝 Todo - Knowledge base search
```

## Next Implementation Steps

### Step 1: Run Setup Script
```bash
# First, ensure environment variables are set
export SUPABASE_DB_URL="postgresql://postgres.fscwwerxbxzbszgdubbo:[PASSWORD]@aws-0-us-west-1.pooler.supabase.com:6543/postgres"
export OPENAI_API_KEY="your-key"

# Run the setup to create LangGraph tables
node api/scripts/setup.js
```

### Step 2: Create BSA Tools with Dedupe
```javascript
// api/tools/bsa.js
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const { withDedupe } = require("../lib/dedupe");
// ... implement with dedupe wrapper
```

### Step 3: Create Core Graph Nodes
1. **Intent Node** - Classify user intent
2. **Plan Node** - Generate DAG of actions
3. **Approval Node** - Human-in-the-loop with interrupt marker
4. **Response Node** - Conversational finalizer

### Step 4: Build Orchestrator
- Use cached graph compilation
- Wire all nodes with proper edges
- Add conditional routing based on intent

### Step 5: Create API Routes
- `/api/agent/execute` - Main execution with interrupt detection
- `/api/agent/approve` - Resume after approval
- `/api/memory/suggestions` - Mem0 suggestions API

## Critical Implementation Notes

### 1. Graph Compilation (IMPORTANT)
```javascript
// Build graph ONCE at module level for performance
let compiledGraph = null;

async function buildGraph() {
  if (compiledGraph) return compiledGraph;
  // ... build and compile
  compiledGraph = g.compile({ 
    checkpointer, 
    store,
    maxConcurrency: 3 // Limit for BSA
  });
  return compiledGraph;
}
```

### 2. Interrupt Detection Pattern
```javascript
// In approval node, set marker
return {
  approvals: decision,
  interruptMarker: "PENDING_APPROVAL"
};

// In route, check marker
if (state.interruptMarker === "PENDING_APPROVAL") {
  return res.status(202).json({
    status: "PENDING_APPROVAL",
    previews: state.previews
  });
}
```

### 3. Timezone Handling
```javascript
// Always convert to UTC for BSA
const startTimeUTC = input.startTime ? 
  new Date(input.startTime).toISOString() : null;
```

### 4. Security Considerations
- PassKey NEVER in prompts (use closures)
- RLS enabled on user data tables
- Session validation on all routes
- CORS restricted to extension origin

### 5. Performance Optimizations
- Graph compiled once and cached
- Checkpointer/store singletons
- Dedupe with 5-minute window
- maxConcurrency: 3 for BSA limits

## Testing Checklist

### Before Proceeding
- [ ] Run setup.js successfully
- [ ] Verify LangGraph tables created
- [ ] Test dedupe with duplicate payloads
- [ ] Confirm vector search working

### After Each Node
- [ ] Test node in isolation
- [ ] Verify state mutations
- [ ] Check error handling
- [ ] Monitor with LangSmith

### Integration Tests
- [ ] Full graph execution
- [ ] Approval flow interruption
- [ ] Memory recall and storage
- [ ] KB semantic search

## Environment Variables Required

```env
# Database
SUPABASE_URL=https://fscwwerxbxzbszgdubbo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key
SUPABASE_DB_URL=postgresql://...

# AI/LLM
OPENAI_API_KEY=your-key

# Monitoring (optional but recommended)
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=your-key
LANGCHAIN_PROJECT=bsa-multiagent

# Feature Flags
USE_NEW_ARCHITECTURE=false
SAFE_MODE_DEFAULT=true
```

## Common Pitfalls to Avoid

1. **Don't create store tables manually** - LangGraph manages them
2. **Don't forget dedupe** - BSA has no idempotency
3. **Don't compile graph per request** - Cache it
4. **Don't skip timezone conversion** - Always UTC for BSA
5. **Don't expose PassKeys** - Use closures only
6. **Don't skip setup.js** - Tables won't exist

## Success Criteria

- ✅ No duplicate BSA writes (dedupe working)
- ✅ Approvals interrupt correctly
- ✅ Memory persists across sessions
- ✅ Graph state recovers after restarts
- ✅ Response time <3 seconds
- ✅ PassKeys never logged

This corrected plan addresses all the critical issues raised in the review and provides a solid foundation for the multi-agent architecture.