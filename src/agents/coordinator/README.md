# Coordinator and PassKey Flow Documentation

## Overview

The Coordinator is the lightweight orchestrator that replaces the complex monolithic graph. It handles:
- Memory recall via Mem0
- Domain routing (Calendar, Task, Workflow)
- PassKey management for BSA API calls
- Response finalization

## PassKey Flow - Critical Security Pattern

### The Problem
PassKeys are sensitive authentication tokens for BSA API access. They:
- Expire after 1 hour
- Must never be stored in state (security risk)
- Need automatic refresh when < 5 minutes remain
- Must be thread-safe for parallel subgraph execution

### The Solution: Getter Pattern

**NEVER do this:**
```javascript
// ❌ WRONG - PassKey stored in state (security risk)
const passKey = await getPassKey(sessionId);
const config = {
  configurable: {
    passKey: passKey  // BAD: Static PassKey in state
  }
};
```

**ALWAYS do this:**
```javascript
// ✅ CORRECT - PassKey getter for thread-safe access
const config = {
  configurable: {
    getPassKey: async () => await getPassKey(sessionId)  // GOOD: Fresh PassKey on demand
  }
};
```

### Implementation in Subgraphs

Each subgraph node that needs BSA access:

```javascript
// In any subgraph node (e.g., createAppointment)
async function createInBSA(state, config) {
  // Always get fresh PassKey when needed
  const passKey = await config.configurable.getPassKey();
  
  // Use PassKey for BSA API call
  const result = await createAppointment(data, passKey);
  
  // Never store PassKey in state
  return { appointment: result };  // ✅ No PassKey in return
}
```

## Architecture Flow

```
User Query
    ↓
Coordinator
    ├─ Memory Recall (Mem0)
    ├─ Router (LLM-based)
    └─ Execute Subgraph(s)
        ├─ Calendar Subgraph
        ├─ Task Subgraph
        └─ Workflow Subgraph
            ↓
        Each gets getPassKey()
            ↓
        Response Finalizer
```

## Coordinator State Structure

```javascript
const CoordinatorState = {
  messages: [],           // Conversation history
  memory_context: {},     // Recalled memories from Mem0
  domains: [],           // Detected domains ["calendar", "task"]
  subgraph_results: {},  // Results from each subgraph
  entities: {},          // Shared entities between subgraphs
  final_response: ""     // Final formatted response
}
```

## Subgraph Communication

### 1. Context Passing
Subgraphs can share context through the `entities` field:

```javascript
// Calendar subgraph creates an appointment
return {
  appointment: createdAppointment,
  entities: {
    appointment: {
      id: createdAppointment.id,
      name: createdAppointment.subject,
      time: createdAppointment.startTime
    }
  }
}

// Task subgraph can reference it
const appointmentId = state.entities.appointment?.id;
```

### 2. Sequential Dependencies
When domains depend on each other:

```javascript
// Coordinator detects: "Create workflow then task to review it"
executionPlan: {
  steps: [
    { domain: "workflow", outputs: ["workflowId", "name"] },
    { domain: "task", inputs: { linkedTo: "{workflowId}" } }
  ]
}
```

### 3. Parallel Execution
Independent domains run concurrently:

```javascript
// "Check my calendar and list my tasks"
Promise.all([
  CalendarSubgraph.invoke(state, config),
  TaskSubgraph.invoke(state, config)
])
```

## Memory Integration

### Recall (Start of Conversation)
```javascript
const mem0 = getMem0Service();
const memories = await mem0.recall(query, orgId, userId);
// Memories added to state.memory_context
```

### Synthesis (After Actions)
```javascript
// Each subgraph synthesizes its own memories
await mem0.synthesize(messages, orgId, userId, {
  domain: "calendar",
  action: "appointment_created",
  appointmentId: appointment.id
});
```

## Testing the V2 Architecture

### Feature Flag Control
```bash
# .env file
USE_V2_ARCHITECTURE=false  # Start with old system
USE_V2_ARCHITECTURE=true   # Switch to new system
```

### Test Sequence
1. **Single Domain**: "What's on my calendar today?"
2. **Parallel Domains**: "Show my appointments and tasks"
3. **Sequential**: "Create a workflow then a task to review it"
4. **With Contacts**: "Schedule a meeting with John Smith"
5. **Memory Recall**: "What did we discuss last time?"

## Migration Checklist

- [x] Mem0 API key configured
- [x] Directory structure created
- [x] Feature flag added
- [x] BSA tools extracted
- [x] Core services created
- [ ] Coordinator implemented
- [ ] Calendar subgraph built
- [ ] Task subgraph built
- [ ] Workflow subgraph built
- [ ] Integration tests written
- [ ] Performance benchmarks
- [ ] Gradual rollout plan

## Performance Targets

| Query Type | Current (v1) | Target (v2) | Improvement |
|------------|--------------|-------------|-------------|
| Simple     | 1.5-2.5s     | <500ms      | 3-5x faster |
| Complex    | 3-5s         | <1.5s       | 2-3x faster |
| Memory     | 200-300ms    | <100ms      | 2x faster   |

## Rollback Procedure

If issues arise:
1. Set `USE_V2_ARCHITECTURE=false` in .env
2. Restart the application
3. System automatically uses old orchestrator
4. No data loss - both systems use same database

## Next Steps

1. Build CalendarSubgraph with micro-DAG
2. Test with real BSA API calls
3. Add performance monitoring
4. Implement gradual rollout (% of traffic)
5. Monitor error rates and latency