# State Compatibility Documentation

## Overview

This document describes how the V1 (current) and V2 (new) architectures share state and maintain compatibility during the migration period. Both architectures use the same PostgreSQL database for state persistence, ensuring seamless rollback if needed.

## Dual Architecture Support

### Feature Flag Control
```javascript
// .env or environment variables
USE_V2_ARCHITECTURE=false  // Use V1 (current orchestrator)
USE_V2_ARCHITECTURE=true   // Use V2 (domain subgraphs)
```

### Runtime Selection
```javascript
// In api/routes/agent.js
const useV2 = process.env.USE_V2_ARCHITECTURE === 'true';

if (useV2) {
  // Route to Coordinator (V2)
  const coordinator = require('../coordinator');
  return coordinator.handleQuery(query, context);
} else {
  // Route to Orchestrator (V1)
  const orchestrator = require('../graph/orchestrator');
  return orchestrator.handleQuery(query, context);
}
```

## State Persistence Layer

### PostgresSaver (Permanent - Never Removed)

Both V1 and V2 use the same PostgresSaver for checkpoint persistence:

```javascript
// Shared configuration
const checkpointer = PostgresSaver.fromConnString(
  process.env.DATABASE_URL || process.env.POSTGRES_URL
);
```

This ensures:
- Conversation history is preserved across architectures
- State can be resumed regardless of which version handled previous messages
- Rollback is instant with no data loss

## State Schema Differences

### V1 State (AppState)
```javascript
{
  messages: [],           // Conversation history
  plan: {                // Complex planning structure
    steps: [],
    currentStep: 0
  },
  cursor: {              // Navigation state
    phase: '',
    status: ''
  },
  previews: {},          // Generated previews
  approvals: {},         // Approval status
  memories: [],          // UnifiedStore memories
  entities: {}           // Extracted entities
}
```

### V2 State (CoordinatorState)
```javascript
{
  messages: [],          // Conversation history (same format)
  memory_context: {},    // Mem0 recalled memories
  domains: [],           // Detected domains
  subgraph_results: {},  // Results from each subgraph
  entities: {},          // Shared entities (compatible)
  final_response: ''     // Final formatted response
}
```

### Key Compatibility Points

1. **Messages Array**: Both use the same format for conversation history
   ```javascript
   { role: 'user' | 'assistant', content: string }
   ```

2. **Entities Object**: Same structure for cross-domain sharing
   ```javascript
   {
     appointment: { id, name, time },
     task: { id, title, dueDate },
     contact: { id, name, email }
   }
   ```

3. **Thread ID**: Same thread_id used for conversation continuity

## Memory System Migration

### V1: UnifiedStore → V2: Mem0

V1 uses custom memory implementation:
```javascript
// V1: UnifiedStore with PgMemoryStore
const store = new UnifiedStore(sessionId);
await store.addMemory(content, metadata);
const memories = await store.searchMemories(query);
```

V2 uses Mem0 cloud service:
```javascript
// V2: Mem0 API
const mem0 = getMem0Service();
await mem0.synthesize(messages, orgId, userId);
const memories = await mem0.recall(query, orgId, userId);
```

**Migration Path**:
1. Both systems can run in parallel initially
2. Export memories from PgMemoryStore
3. Import into Mem0 using batch API
4. Verify memory quality
5. Disable UnifiedStore

## Subgraph State Isolation

Each V2 subgraph maintains its own state:

### CalendarSubgraph State
```javascript
{
  messages: [],         // Inherited from coordinator
  appointment: {},      // Domain-specific data
  conflicts: [],        // Calendar conflicts
  attendees: []         // Meeting participants
}
```

### TaskSubgraph State
```javascript
{
  messages: [],         // Inherited from coordinator
  task: {},            // Domain-specific data
  linkedContacts: [],  // Associated contacts
  priority: ''         // Task priority
}
```

## Interrupt Handling Compatibility

Both architectures use LangGraph's interrupt mechanism:

### V1 Interrupt
```javascript
// In approval node
throw interrupt({
  value: { previews, actions }
});
```

### V2 Interrupt
```javascript
// In ApprovalBatcher
throw interrupt({
  value: { 
    type: 'batch_approval',
    previews: formattedPreviews
  }
});
```

Frontend handles both formats transparently.

## Rollback Procedure

If V2 has issues:

1. **Immediate Rollback**:
   ```bash
   # Set environment variable
   USE_V2_ARCHITECTURE=false
   ```

2. **Verify Rollback**:
   - Check logs for "Using V1 Orchestrator"
   - Test with simple query
   - Confirm state persistence

3. **No Data Loss**:
   - All conversations preserved
   - All BSA data intact
   - Memories accessible (both systems)

## Testing State Compatibility

### Test Scenarios

1. **Cross-Architecture Conversation**:
   ```javascript
   // Message 1-3: V1 handles
   USE_V2_ARCHITECTURE=false
   "What's on my calendar today?"
   
   // Message 4-6: V2 handles
   USE_V2_ARCHITECTURE=true
   "Create a task for the first meeting"
   
   // Message 7+: Back to V1
   USE_V2_ARCHITECTURE=false
   "Show me all my tasks"
   ```

2. **Entity Reference Across Versions**:
   - V1 creates appointment → V2 references it
   - V2 creates task → V1 updates it

3. **Memory Continuity**:
   - V1 stores context → V2 recalls it
   - V2 learns pattern → V1 uses it

### Validation Checklist

- [ ] Messages array format identical
- [ ] Entity structure compatible
- [ ] Thread ID preserved
- [ ] Checkpoint loading works
- [ ] Interrupts handled correctly
- [ ] Memories accessible
- [ ] No data corruption
- [ ] Performance acceptable

## Migration Timeline

### Phase 1: Foundation (Current)
- Extract tools and services ✅
- Create subgraph structure ✅
- Maintain full V1 compatibility ✅

### Phase 2: Parallel Running
- Deploy V2 with feature flag
- Run 10% traffic on V2
- Monitor performance and errors
- Gradual increase to 50%

### Phase 3: Full Migration
- V2 as default (flag = true)
- V1 available for rollback
- Monitor for 2 weeks
- Archive V1 code

### Phase 4: Cleanup
- Remove V1 orchestrator
- Remove UnifiedStore
- Optimize V2 performance
- Update documentation

## Monitoring & Alerts

### Key Metrics to Track

1. **Performance**:
   - Response time (V1 vs V2)
   - Memory recall speed
   - Subgraph execution time

2. **Reliability**:
   - Error rate by version
   - Rollback frequency
   - State corruption incidents

3. **User Experience**:
   - Message continuity
   - Entity resolution accuracy
   - Memory relevance

### Alert Thresholds

- V2 error rate > 2x V1 → Auto-rollback
- Response time > 3s → Investigation
- State corruption → Immediate rollback

## Support & Troubleshooting

### Common Issues

1. **State Not Loading**:
   - Check thread_id consistency
   - Verify PostgreSQL connection
   - Review checkpoint format

2. **Entities Not Shared**:
   - Ensure entity structure matches
   - Check domain routing logic
   - Verify entity registration

3. **Memory Issues**:
   - For V1: Check UnifiedStore
   - For V2: Verify Mem0 API key
   - Test memory ID format

### Debug Mode

Enable detailed logging:
```javascript
// .env
DEBUG_STATE=true
LOG_LEVEL=verbose
```

This will log:
- State transitions
- Entity updates
- Memory operations
- Architecture selection

## Conclusion

The dual-architecture approach ensures:
1. **Zero downtime** during migration
2. **Instant rollback** capability
3. **No data loss** at any point
4. **Gradual, controlled** transition

Both architectures share the critical PostgresSaver layer, making them fully compatible for state persistence while allowing independent evolution of the processing logic.