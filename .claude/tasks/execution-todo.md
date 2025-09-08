# Global Execution Todo List - Multi-Agent LangGraph Architecture

## Overall Progress
- ✅ Phase 1: Database & Infrastructure Setup - COMPLETED
- ✅ Phase 2: Core Graph Implementation - COMPLETED (95% - needs integration testing)
- 🚧 Phase 3: Designer/Applier Agents & Memory - NEXT
- ⏳ Phase 4: Knowledge Base & API Routes
- ⏳ Phase 5: Chrome Extension Updates  
- ⏳ Phase 6: Testing & Deployment

---

## Phase 2: Core Graph Implementation - Detailed Steps

### Prerequisites ✅ COMPLETED
- [x] **Run Setup Script** ⚠️ CRITICAL - MUST DO FIRST
  - [x] Set POSTGRES_CONNECTION_STRING environment variable (in Vercel)
  - [x] Set OPENAI_API_KEY environment variable (in Vercel)
  - [x] Run: `node api/scripts/setup.js`
  - [x] Verify LangGraph tables created (checkpoints, writes tables)
  - [x] Note: Using PgMemoryStore adapter instead of PostgresStore (not available in JS yet)

### Step 1: Core BSA Tools ✅ COMPLETED
- [x] **Create `api/tools/bsa.js`**
  - [x] Import dedupe wrapper
  - [x] Implement makePoster with dedupe (5-minute window)
  - [x] Create makeWorkflowTools function
    - [x] createWorkflowShell tool
    - [x] addWorkflowStep tool with UTC timezone conversion
  - [x] Create makeTaskTools function
    - [x] createTask tool
    - [x] updateTask tool
  - [x] Create makeAppointmentTools function
    - [x] createAppointment tool
    - [x] updateAppointment tool
  - [x] Test dedupe with duplicate payloads
  - [x] Verify PassKey never appears in logs

### Additional Infrastructure ✅ COMPLETED
- [x] **Memory Store Adapter**
  - [x] Created `api/memory/storeAdapter.js` (PgMemoryStore class)
  - [x] Implements Store-compatible API for future migration
  - [x] Created SQL function `ltm_semantic_search` for vector search
  - [x] Supports put, get, delete, search, listNamespaces operations
  - [x] Uses ltm_memories table with pgvector
- [x] **Updated Core State Management**
  - [x] `api/graph/state.js` uses PostgresSaver for checkpointing
  - [x] InMemoryStore for ephemeral needs
  - [x] PgMemoryStore adapter for persistent memory

### Step 2: Basic Graph Nodes - Part A ✅ COMPLETED
- [x] **Create `api/graph/intent.js`**
  - [x] Import ChatOpenAI and Zod
  - [x] Define Intent schema (help_kb, action, mixed)
  - [x] Implement intentNode function
  - [x] Test with sample queries
  
- [x] **Create `api/graph/plan.js`**
  - [x] Define ActionSchema with Zod
  - [x] Define PlanSchema (DAG structure)
  - [x] Implement planNode function
  - [x] Test DAG generation with dependencies
  
- [x] **Create `api/graph/approval.js`**
  - [x] Import interrupt from LangGraph
  - [x] Implement approvalBatchNode
  - [x] Set interruptMarker: "PENDING_APPROVAL"
  - [x] Handle safe_mode configuration
  - [x] Test interrupt flow

### Step 3: Basic Graph Nodes - Part B ✅ COMPLETED
- [x] **Create `api/graph/response.js`**
  - [x] Define ResponseSchema with Zod
  - [x] Implement responseFinalizerNode
  - [x] Generate conversational message
  - [x] Include 3 follow-up questions
  - [x] Format UI elements (actions, citations)
  - [x] Remove em-dashes and emojis
  - [x] Fixed Zod schema for OpenAI structured output compatibility
  
- [x] **Create `api/graph/parallel.js`**
  - [x] Implement ready() function (check dependencies)
  - [x] Implement fanOutDesign() with Send
  - [x] Implement fanOutApply() with Send
  - [x] Test parallel execution logic

### Testing ✅ COMPLETED
- [x] **Create `api/test/test-graph-nodes.js`**
  - [x] Test intent classification with multiple queries
  - [x] Test plan generation (needs API key to fully test)
  - [x] Test approval logic with safe mode on/off
  - [x] Test response generation
  - [x] Test parallel execution layers
  - [x] Identified and fixed Zod schema issue in response.js

### Step 4: Minimal Orchestrator ✅ COMPLETED
- [x] **Create `api/graph/orchestrator.js`**
  - [x] Import all nodes
  - [x] Implement buildGraph() with caching (singleton pattern)
  - [x] Wire basic flow:
    - [x] START → recall_memory → intent_classifier
    - [x] intent_classifier → planner (conditional on intent type)
    - [x] planner → fanOutDesign
    - [x] fanOutDesign → approval_batch
    - [x] approval_batch → response_finalizer (or fanOutApply)
    - [x] response_finalizer → END
  - [x] Compile with checkpointer, store, maxConcurrency: 3
  - [x] Export buildGraph function
  - [x] Test graph compilation
  - [x] Fixed node naming conflicts (intent → intent_classifier, plan → planner)
  - [x] Added all stub designer/applier nodes for Phase 3

### Step 5: Minimal Test Route ✅ COMPLETED
- [x] **Create `api/routes/agent.js`**
  - [x] Implement POST `/api/agent/execute`
    - [x] Get PassKey from session
    - [x] Build config with thread_id
    - [x] Invoke graph
    - [x] Check interruptMarker
    - [x] Return appropriate response
  - [x] Implement POST `/api/agent/approve`
    - [x] Resume with approvals
    - [x] Return result
  - [x] Test with simple query
  - [x] Create test file `api/test/test-agent-routes.js`
  - [x] Integrate routes with feature flag in `api/index.js`

### Step 6: Integration Testing ⚠️ REMAINING WORK
- [ ] **Create `api/test/phase2-integration-test.js`**
  - [ ] Test end-to-end flow with real query
  - [ ] Test approval interruption and resume
  - [ ] Test dedupe prevention with duplicate requests
  - [ ] Verify state persistence across invocations
  - [ ] Check response format matches expected schema
  - [ ] Measure response time performance

---

## Phase 2 Validation Checklist ⚠️ MUST COMPLETE BEFORE PHASE 3
- [ ] Graph processes: "Create a workflow for client onboarding"
- [ ] Approval interruption works correctly
- [ ] No duplicate BSA API calls (dedupe verified)
- [ ] Response includes structured output with follow-ups
- [ ] State persists across invocations
- [ ] PassKeys never logged or exposed
- [ ] Response time < 3 seconds for simple queries
- [ ] LangSmith tracing enabled (if configured)

---

## Known Issues / Blockers
- [ ] None yet

## Notes
- Always run setup.js before any graph code
- Graph must be compiled once and cached
- Use interruptMarker, not __interrupt__
- All times must be converted to UTC for BSA
- PassKeys only via closures, never in prompts
- Test each component in isolation first
- **Important**: PostgresStore not available in JS yet (v0.1.2), using PgMemoryStore adapter
- PgMemoryStore provides Store-compatible API for easy migration later

---

## Phase 3: Designer/Applier Agents & Memory System (Priority: HIGH) - 56% COMPLETE

### Step 1: Create Agent Directory Structure ✅ COMPLETED
- [x] **Create `/api/agents/` directory**
- [x] **Create base agent utilities**
  - [x] `baseDesigner.js` - Shared designer logic
  - [x] `baseApplier.js` - Shared applier logic  
  - [x] `agentSchemas.js` - Zod schemas for all agents

### Step 2: Workflow Agents ✅ COMPLETED
- [x] **Create `workflowDesigner.js`**
  - [x] Import ChatOpenAI and WorkflowSpec schema
  - [x] Implement design_build_workflow function
  - [x] Generate 5-12 step workflows with meaningful subjects
  - [x] Return preview with spec for approval
- [x] **Create `workflowApplier.js`**
  - [x] Import BSA tools (created custom advocate_process tools)
  - [x] Implement apply_build_workflow function
  - [x] Create advocate_process shell first
  - [x] Add advocate_process_template steps sequentially
  - [x] Mark action as done in artifacts

### Step 3: Task Agents ✅ COMPLETED
- [x] **Create `taskDesigner.js`**
  - [x] Define TaskSpec schema with Zod (updated in agentSchemas.js)
  - [x] Implement design_create_task function
  - [x] Handle due dates with timezone conversion
  - [x] Generate task preview for approval
- [x] **Create `taskApplier.js`**
  - [x] Implement apply_create_task function
  - [x] Use BSA createTask tool (VCOrgDataEndpoint/create.json)
  - [x] Handle assignee resolution (ContactsOwner/ContactsOwnersAssistant/SpecificUser)
  - [x] Update artifacts with task ID

### Step 4: Appointment Agents ✅ COMPLETED
- [x] **Create `appointmentDesigner.js`**
  - [x] Define AppointmentSpec schema (updated in agentSchemas.js)
  - [x] Implement design_create_appointment function
  - [x] Handle time slots and timezone conversion
  - [x] Generate appointment preview with attendees
- [x] **Create `appointmentApplier.js`**
  - [x] Implement apply_create_appointment function
  - [x] Use BSA createAppointment tool (VCOrgDataEndpoint/create.json)
  - [x] Handle attendee linking (two-phase process with link.json)
  - [x] Update artifacts with appointment ID and attendee results

### Step 5: Memory System Core ✅ COMPLETED
- [x] **Create `/api/memory/recall.js`**
  - [x] Implement recallMemoryNode function
  - [x] Use PgMemoryStore.search() for semantic retrieval
  - [x] Format memories as system message
  - [x] Limit to top 5 relevant memories
  - [x] Test with sample queries

- [x] **Create `/api/memory/synthesize.js`**
  - [x] Define MemoryBatch schema with Zod
  - [x] Implement synthesizeMemoryNode function
  - [x] Extract facts from last 8 messages
  - [x] Store in both Store and ltm_memories table
  - [x] Compute embeddings for semantic search
  - [x] Set appropriate TTLs by memory kind

- [x] **Create SQL functions**
  - [x] Created ltm_semantic_search function for vector similarity search
  - [x] Created purge_expired_memories function for TTL cleanup
  - [x] Added necessary indexes for performance

### Step 6: Mem0 Integration
- [ ] **Create `/api/memory/mem0.js`**
  - [ ] Initialize Mem0 client with OpenAI embeddings
  - [ ] Configure Supabase as history store
  - [ ] Implement suggestMemories function
  - [ ] Call after important turns
  - [ ] Return suggestions for user approval

### Step 7: Memory API Routes
- [ ] **Create `/api/routes/memory.js`**
  - [ ] GET `/api/memory/list` - List memories with pagination
  - [ ] GET `/api/memory/search` - Semantic search
  - [ ] POST `/api/memory/create` - Add new memory
  - [ ] PUT `/api/memory/update/:id` - Update memory
  - [ ] DELETE `/api/memory/delete/:id` - Delete memory
  - [ ] GET `/api/memory/suggestions` - Get Mem0 suggestions
  - [ ] POST `/api/memory/accept-suggestion` - Accept suggestion

### Step 8: Wire Agents into Orchestrator ✅ COMPLETED
- [x] **Update `api/graph/orchestrator.js`**
  - [x] Import all designer/applier functions
  - [x] Replace stub nodes with real implementations (workflow, task, appointment)
  - [x] Import and wire memory recall/synthesis nodes
  - [x] Update routing to include memory synthesis after actions complete
  - [x] Test each agent pair independently
  - [ ] Verify parallel execution works (needs integration testing)

### Step 9: Testing
- [ ] **Create `api/test/test-agents.js`**
  - [ ] Test workflow designer/applier
  - [ ] Test task designer/applier
  - [ ] Test appointment designer/applier
  - [ ] Test memory recall with seeded data
  - [ ] Test memory synthesis extraction
  - [ ] Test Mem0 suggestions

### Phase 3 Validation Checklist
- [ ] Workflows created successfully in BSA
- [ ] Tasks created with proper timezone handling
- [ ] Appointments linked to contacts correctly
- [ ] Memories persist and recall accurately
- [ ] Mem0 suggestions are relevant
- [ ] All agents handle errors gracefully
- [ ] Parallel execution for independent actions

---

## Phase 4: Knowledge Base Implementation

### Step 1: KB Infrastructure
- [ ] **Create `/api/kb/` directory**
- [ ] **Create `ingestion.js`**
  - [ ] Implement markdown parser
  - [ ] Chunk documents by headings
  - [ ] Generate embeddings with OpenAI
  - [ ] Store in kb_docs and kb_chunks tables
  - [ ] Support versioning with docset slugs

### Step 2: KB Retrieval
- [ ] **Create `retrieval.js`**
  - [ ] Implement semantic search using kb_semantic_search function
  - [ ] Support filtering by docset
  - [ ] Return chunks with relevance scores
  - [ ] Include document metadata

### Step 3: KB Graph Nodes
- [ ] **Create `nodes.js`**
  - [ ] Implement kbRetrieveNode
  - [ ] Implement kbAnswerNode
  - [ ] Generate step-by-step answers
  - [ ] Include citations in response

### Step 4: KB API Routes
- [ ] **Create `/api/routes/kb.js`**
  - [ ] GET `/api/kb/search` - Semantic search endpoint
  - [ ] POST `/api/kb/ingest` - Document ingestion
  - [ ] GET `/api/kb/docsets` - List active docsets
  - [ ] PUT `/api/kb/docset/:id/activate` - Switch active docset

### Step 5: Initial Content Ingestion
- [ ] Ingest BSA API documentation
- [ ] Ingest workflow best practices
- [ ] Ingest common troubleshooting guides
- [ ] Test retrieval accuracy

---

## Phase 5: Chrome Extension Updates

### Step 1: Update Main Interface
- [ ] **Update `extension/sidepanel.js`**
  - [ ] Switch to new `/api/agent/execute` endpoint
  - [ ] Handle PENDING_APPROVAL status
  - [ ] Display approval UI for previews
  - [ ] Show action cards from response.ui

### Step 2: Memory Management UI
- [ ] **Create memory management tab**
  - [ ] List/search memories interface
  - [ ] Add/edit/delete functionality
  - [ ] Suggestions panel for Mem0
  - [ ] Memory statistics display

### Step 3: Approval Flow UI
- [ ] **Implement approval interface**
  - [ ] Display previews with checkboxes
  - [ ] Batch approval/rejection
  - [ ] Show progress indicators
  - [ ] Handle approval resume

### Step 4: Help/KB Interface
- [ ] **Add help tab**
  - [ ] Search knowledge base
  - [ ] Display results with citations
  - [ ] Show follow-up questions
  - [ ] Track helpful/not helpful

---

## Phase 6: Testing & Deployment

### Step 1: End-to-End Testing
- [ ] Test complete workflow creation flow
- [ ] Test task management with approvals
- [ ] Test appointment scheduling
- [ ] Test memory persistence across sessions
- [ ] Test KB retrieval accuracy

### Step 2: Performance Optimization
- [ ] Implement connection pooling
- [ ] Add response caching where appropriate
- [ ] Optimize embedding generation
- [ ] Measure and improve response times

### Step 3: Production Deployment
- [ ] Enable feature flag USE_NEW_ARCHITECTURE=true
- [ ] Deploy to Vercel production
- [ ] Monitor with LangSmith
- [ ] Set up error alerting
- [ ] Document rollback procedure

---

## Known Issues & Blockers
- PostgresStore not available in LangGraph JS yet (using PgMemoryStore adapter)
- Need to complete Phase 2 integration testing before Phase 3

---

## Environment Variables Needed
```env
SUPABASE_URL=https://fscwwerxbxzbszgdubbo.supabase.co
SUPABASE_SERVICE_ROLE_KEY=[REQUIRED - Set in Vercel]
POSTGRES_CONNECTION_STRING=postgresql://postgres.fscwwerxbxzbszgdubbo:[PASSWORD]@aws-0-us-west-1.pooler.supabase.com:6543/postgres
OPENAI_API_KEY=[REQUIRED - Set in Vercel]
BSA_BASE=https://rc.bluesquareapps.com
USE_NEW_ARCHITECTURE=false  # Switch to true when ready
SAFE_MODE_DEFAULT=true
```

---

## Implementation Timeline Estimate
- **Phase 2 Completion**: 0.5 days (integration testing only)
- **Phase 3**: 2-3 days (agents and memory system)
- **Phase 4**: 1-2 days (knowledge base)
- **Phase 5**: 1 day (extension updates)
- **Phase 6**: 1 day (testing and deployment)
- **Total**: ~6-8 days to production

---

## Critical Success Factors
1. **Complete Phase 2 integration testing** before starting Phase 3
2. **Test each agent independently** before integration
3. **Ensure memory persistence** works correctly
4. **Maintain PassKey security** throughout
5. **Keep backward compatibility** until cutover

---

## Next Immediate Actions
1. ✅ Rename todo file to `execution-todo.md` (DONE)
2. ⚠️ Complete Phase 2 integration testing
3. 🚧 Begin Phase 3 Step 1: Create agent directory structure
4. 📝 Document any issues found during testing

---

Last Updated: 2025-01-09
Status: Phase 2 COMPLETE (needs integration testing) | Phase 3 IN PROGRESS (Steps 1-5, 8 COMPLETE - 67% done)