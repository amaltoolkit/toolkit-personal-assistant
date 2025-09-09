# How Memory Works in BlueSquare Assistant

## Overview

The BlueSquare Assistant implements a sophisticated multi-layered memory architecture designed to balance performance, security, and user experience. This document explains the memory system from first principles, detailing both the implementation and the reasoning behind key design decisions.

## Core Memory Philosophy

Our system treats memory not as a monolithic store, but as a **hierarchy of contexts** with different persistence, searchability, and security requirements. This mirrors human cognitive architecture:

- **Working Memory** → Ephemeral state (current conversation)
- **Short-term Memory** → Session storage (cross-conversation preferences)
- **Long-term Memory** → Database with TTL (learned facts and preferences)
- **Semantic Memory** → Vector embeddings (contextual understanding)

## Three-Tier Memory Hierarchy

### Layer 1: Ephemeral Memory (Frontend)

**Purpose**: Immediate UI state and active conversation management

**Location**: `extension/sidepanel.js`

**Implementation**:
```javascript
// In-memory state variables
let currentSessionId = null;
let currentOrgId = null;
let currentOrgName = null;
let organizations = [];
let chatMessages = [];
let isProcessing = false;
```

**Characteristics**:
- **Scope**: Browser tab session only
- **Persistence**: None (cleared on refresh)
- **Access Time**: Instant (in-memory)
- **Security**: No sensitive data stored

**Design Rationale**: 
- Zero latency for UI updates
- No persistence overhead for transient state
- Simplifies state management without backend roundtrips
- Security through ephemerality - sensitive data never persists

### Layer 2: Semi-Persistent Memory (Browser)

**Purpose**: User preferences and session continuity across page refreshes

**Location**: Browser LocalStorage

**Implementation**:
```javascript
const SESSION_ID_KEY = 'bsa_session_id';
const LAST_ORG_ID_KEY = 'bsa_last_org_id';
const LAST_ORG_NAME_KEY = 'bsa_last_org_name';
const ONBOARDING_COMPLETED_KEY = 'bsa_onboarding_completed';
```

**Characteristics**:
- **Scope**: Browser-specific, survives refreshes
- **Persistence**: Until cleared by user or browser
- **Access Time**: ~1ms (localStorage)
- **Security**: No PassKeys or sensitive auth data

**Design Rationale**:
- Preserves user context across sessions
- Enables seamless re-authentication flow
- Fast access without network calls
- Organization selection persistence improves UX

### Layer 3: Persistent Memory (Database)

**Purpose**: Long-term memory, secure storage, and semantic search

**Location**: Supabase PostgreSQL with pgvector

**Implementation**:
```sql
CREATE TABLE ltm_memories (
  key TEXT UNIQUE NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  namespace TEXT[] NOT NULL,
  kind TEXT DEFAULT 'fact',
  subject_id TEXT,
  text TEXT NOT NULL,
  importance INTEGER DEFAULT 3,
  ttl_days INTEGER,
  embedding vector(1536),
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ GENERATED ALWAYS AS (...)
);
```

**Characteristics**:
- **Scope**: Cross-device, user-specific
- **Persistence**: TTL-based (30-365 days)
- **Access Time**: ~50-200ms (network + query)
- **Security**: Service role key protection, namespace isolation

**Design Rationale**:
- Vector embeddings enable semantic search
- TTLs prevent unbounded growth
- Namespace isolation ensures data privacy
- Importance scoring prioritizes relevant memories

## Conversation State Management (LangGraph)

### State Schema Architecture

**Location**: `api/graph/state.js`

**Core State Definition**:
```javascript
AppState = Annotation.Root({
  // Message handling
  ...MessagesAnnotation.spec,
  
  // Execution state
  plan: Annotation({ reducer: (old, new_) => new_ }),
  cursor: Annotation({ default: () => 0 }),
  
  // User interaction
  previews: Annotation({ reducer: deduplicateById }),
  approvals: Annotation({ reducer: replace }),
  
  // Shared memory
  artifacts: Annotation({ reducer: deepMerge }),
  
  // Context
  intent: Annotation({ reducer: replace }),
  kb: Annotation({ reducer: replace }),
  userContext: Annotation({ reducer: merge })
});
```

### State Persistence

**Checkpointer**: PostgresSaver for conversation persistence
```javascript
const checkpointer = PostgresSaver.fromConnString(
  process.env.POSTGRES_CONNECTION_STRING
);
```

**Benefits**:
- Conversations survive server restarts
- Resume from any checkpoint
- Audit trail of conversation flow
- Enables conversation branching

### State Reducers

**Custom Merging Logic**:
- **Messages**: Append-only log
- **Previews**: Deduplicate by actionId
- **Artifacts**: Deep merge with special array handling
- **Plan**: Complete replacement for new plans

**Design Rationale**:
- Reducers prevent state corruption
- Idempotent operations enable retry
- Predictable state transitions
- Supports parallel node execution

## Long-Term Memory System

### Memory Lifecycle

#### Phase 1: Memory Recall
**Location**: `api/memory/recall.js`

**Process**:
1. Extract user query from latest message
2. Create embedding using OpenAI
3. Semantic search in ltm_memories
4. Filter by importance and TTL
5. Format as SystemMessage context
6. Inject into conversation

**Implementation**:
```javascript
async function recallMemoryNode(state, config) {
  const userQuery = extractUserQuery(state.messages);
  const memories = await store.search(namespace, {
    query: userQuery,
    limit: 5,
    minImportance: 2
  });
  
  const context = formatMemoriesAsContext(memories);
  return {
    messages: [new SystemMessage(context)]
  };
}
```

#### Phase 2: Memory Synthesis
**Location**: `api/memory/synthesize.js`

**Process**:
1. Triggered after actions or every N turns
2. Analyze recent conversation with LLM
3. Extract facts, preferences, instructions
4. Deduplicate against existing memories
5. Store with appropriate TTL and importance

**Memory Types & TTLs**:
```javascript
const TTL_BY_KIND = {
  instruction: 365,  // Standing orders (1 year)
  preference: 180,   // User preferences (6 months)
  fact: 90,         // General facts (3 months)
  context: 30       // Temporary context (1 month)
};
```

### Vector Search Implementation

**Adapter**: `api/memory/storeAdapter.js`

**Embedding Creation**:
```javascript
const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-small",  // 1536 dimensions
  openAIApiKey: process.env.OPENAI_API_KEY
});
```

**Semantic Search Function**:
```sql
CREATE FUNCTION ltm_semantic_search(
  ns_prefix TEXT[],
  query_vec vector(1536),
  match_count INT,
  min_importance INT
) RETURNS TABLE (...) AS $$
  SELECT 
    key, namespace, text, kind, importance,
    1 - (embedding <=> query_vec) AS score
  FROM ltm_memories
  WHERE namespace[1:array_length(ns_prefix, 1)] = ns_prefix
    AND importance >= min_importance
    AND (expires_at IS NULL OR expires_at > NOW())
  ORDER BY embedding <=> query_vec ASC
  LIMIT match_count;
$$;
```

**Design Decisions**:
- Cosine similarity for relevance scoring
- Namespace prefix matching for multi-tenancy
- Importance threshold filtering
- Automatic TTL expiration

## Multi-Agent Orchestration & Shared State

### Parallel Execution Pattern

**Location**: `api/graph/parallel.js`

**Fan-out Mechanism**:
```javascript
async function fanOutDesign(state) {
  const readyActions = ready(state); // Check dependencies
  
  return new Command({
    goto: readyActions.map(action => 
      new Send(`design_${action.type}`, {
        plan: state.plan,
        artifacts: state.artifacts,  // Shared memory
        action: action,
        userContext: state.userContext
      })
    )
  });
}
```

**Shared Artifacts Pattern**:
```javascript
artifacts: {
  doneIds: [],        // Completed action tracking
  failedActions: [],  // Error recovery state
  createdIds: {},     // Cross-agent ID sharing
  memories: []        // Accumulated insights
}
```

**Benefits**:
- Actions execute in parallel when possible
- Dependencies respected through DAG
- Shared state enables coordination
- Error isolation prevents cascading failures

### Memory Consistency

**Deduplication**:
- Prevents duplicate memories
- Updates importance scores
- Maintains single source of truth

**Namespace Isolation**:
- `[org_id, user_id, "memories"]` structure
- Prevents cross-tenant data leaks
- Enables efficient filtering

## Caching Strategy

### Module Caching
**Location**: `api/index.js`

```javascript
const modulePromises = {};  // Prevent duplicate imports
const moduleCache = {};     // Store initialized modules

async function getLLMClient() {
  if (!moduleCache.llm) {
    if (!modulePromises.llm) {
      modulePromises.llm = import("@langchain/openai")
        .then(({ ChatOpenAI }) => {
          moduleCache.llm = new ChatOpenAI({...});
          return moduleCache.llm;
        });
    }
    return modulePromises.llm;
  }
  return moduleCache.llm;
}
```

### Connection Pooling

**HTTP Keep-Alive**:
```javascript
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10
});
```

**PostgreSQL Pool**:
```javascript
const pgPool = new Pool({
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});
```

### Graph Compilation Cache

```javascript
let compiledGraph = null;  // Singleton pattern

async function buildGraph() {
  if (compiledGraph) return compiledGraph;
  // Build once, reuse always
  compiledGraph = new StateGraph(AppState)...
  return compiledGraph;
}
```

## Security & Privacy Principles

### PassKey Isolation
- **Never in Frontend**: PassKeys exist only in Supabase
- **Backend Exclusive**: Service role key for database access
- **Auto-refresh**: Handles expiration transparently

### Namespace Security
```javascript
const namespace = [orgId, userId, "memories"];
// All operations scoped to this namespace
```

### Session-Based Access
- Every API call requires valid session_id
- Sessions tied to organization context
- Automatic re-authentication flow

## Performance Optimizations

### Lazy Loading
- Modules loaded on first use
- Graph compiled once per process
- Connections pooled and reused

### Parallel Processing
- DAG enables concurrent execution
- Fan-out/fan-in pattern
- Error boundaries prevent blocking

### Smart Caching
- Frontend: Instant UI updates
- LocalStorage: Cross-session state
- Database: Long-term with TTL

## Best Practices

### When to Use Each Layer

**Ephemeral Memory**:
- UI state (loading, processing)
- Current conversation
- Temporary selections

**Semi-Persistent Memory**:
- Session IDs
- User preferences
- Organization selection

**Persistent Memory**:
- Learned facts
- User instructions
- Historical context

### Memory Synthesis Guidelines

**What to Remember**:
- User preferences ("prefers morning meetings")
- Standing instructions ("always include zoom links")
- Important facts ("ABC Corp is key client")
- Context ("working on migration project")

**What NOT to Remember**:
- Temporary data ("today's weather")
- Sensitive information (passwords, keys)
- Redundant information (duplicates)
- Low-importance trivia

### TTL Management

**Long TTLs (365 days)**:
- Standing instructions
- Core preferences
- Foundational facts

**Medium TTLs (90-180 days)**:
- Project context
- Seasonal preferences
- Team information

**Short TTLs (30 days)**:
- Temporary situations
- One-off requests
- Transitional states

## Future Enhancements

### Potential Improvements

1. **Memory Compression**: Consolidate similar memories over time
2. **Memory Chains**: Link related memories for context
3. **Adaptive TTLs**: Extend based on access patterns
4. **Memory Versioning**: Track how facts change over time
5. **Cross-User Memories**: Shared organizational knowledge
6. **Memory Analytics**: Usage patterns and insights

### Scaling Considerations

- **Sharding**: By org_id for horizontal scaling
- **Read Replicas**: For search-heavy workloads
- **Memory Pruning**: Automated cleanup jobs
- **Embedding Cache**: Pre-computed common queries
- **Federated Search**: Cross-database memory access

## Conclusion

The BlueSquare Assistant's memory architecture is designed to provide intelligent, context-aware assistance while maintaining security, performance, and privacy. By implementing a multi-tiered approach with semantic search capabilities, the system can recall relevant information precisely when needed, creating a more natural and effective user experience.

The key insight is that memory is not just storage - it's about understanding context, managing lifecycle, and providing the right information at the right time. This architecture achieves that through careful layering, smart caching, and semantic understanding.