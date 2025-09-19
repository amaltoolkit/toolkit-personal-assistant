# Memory Synthesis Implementation Plan

## Overview
The synthesize.js module will extract important information from conversations and store it as long-term memories with appropriate metadata, embeddings, and TTLs.

## Core Components

### 1. Memory Extraction Chain
**Purpose**: Use LLM to analyze conversation and extract memorable facts

**Implementation**:
```javascript
// Use GPT-4o-mini with structured output
const extractionChain = ChatOpenAI({
  model: "gpt-4o-mini",
  temperature: 0.2
}).withStructuredOutput(MemoryBatchSchema);
```

**Extraction Prompt**:
- Analyze last N messages (default: 8)
- Identify facts, preferences, instructions, and context
- Score importance (1-5)
- Avoid duplicating existing memories
- Focus on actionable and specific information

### 2. Memory Schema (Zod)
```javascript
const MemoryItemSchema = z.object({
  text: z.string().describe("The fact or information to remember"),
  kind: z.enum(["fact", "preference", "instruction", "context"]),
  importance: z.number().min(1).max(5),
  subjectId: z.string().optional().describe("Related entity ID if applicable")
});

const MemoryBatchSchema = z.object({
  memories: z.array(MemoryItemSchema),
  reasoning: z.string().describe("Why these were selected")
});
```

### 3. TTL Strategy
- **instruction**: 365 days (standing orders)
- **preference**: 180 days (user preferences)
- **fact**: 90 days (general knowledge)
- **context**: 30 days (temporary context)

### 4. Deduplication Logic
**Approach**:
1. Before storing, search for similar memories
2. Use semantic similarity threshold (>0.9 = likely duplicate)
3. If duplicate found, update importance if higher
4. Otherwise, store as new memory

### 5. Memory Synthesis Node
```javascript
async function synthesizeMemoryNode(state, config) {
  // 1. Get last N messages
  // 2. Check if synthesis should run (based on turn count or triggers)
  // 3. Extract memories using LLM
  // 4. Deduplicate against existing memories
  // 5. Store with embeddings and TTLs
  // 6. Return artifacts with stored memory IDs
}
```

## Implementation Steps

### Step 1: Define Schemas
- Create MemoryItemSchema with all fields
- Create MemoryBatchSchema for LLM output
- Add validation for text length (min: 10, max: 500 chars)

### Step 2: Create Extraction Prompt
```javascript
const EXTRACTION_PROMPT = `
Analyze this conversation and extract important information to remember.

Focus on:
1. User preferences and requirements
2. Important facts about people, companies, or projects
3. Standing instructions for future interactions
4. Context that would be helpful in future conversations

For each memory, determine:
- kind: fact, preference, instruction, or context
- importance: 1 (trivial) to 5 (critical)
- subjectId: entity ID if the memory is about a specific contact/company

Avoid:
- Temporary information (like "today's weather")
- Redundant facts already likely stored
- Vague or non-actionable statements
- Personal/sensitive information unless necessary

Previous memories for deduplication check:
{existingMemories}

Conversation to analyze:
{conversation}
`;
```

### Step 3: Implement Deduplication
```javascript
async function deduplicateMemories(newMemories, store, namespace) {
  const deduplicated = [];
  
  for (const memory of newMemories) {
    // Search for similar memories
    const similar = await store.search(namespace, {
      query: memory.text,
      limit: 3,
      minImportance: 1
    });
    
    // Check similarity scores
    const isDuplicate = similar.some(s => s.score > 0.9);
    
    if (!isDuplicate) {
      deduplicated.push(memory);
    } else {
      // Optionally update importance if higher
      const existing = similar[0];
      if (memory.importance > existing.value.importance) {
        // Update existing memory's importance
        await store.put(namespace, existing.key, {
          ...existing.value,
          importance: memory.importance
        });
      }
    }
  }
  
  return deduplicated;
}
```

### Step 4: Create Synthesis Triggers
**When to synthesize**:
- After successful action completion (workflow/task/appointment created)
- Every N conversation turns (configurable, default: 5)
- When conversation ends
- On explicit request

### Step 5: Implement Storage
```javascript
async function storeMemories(memories, store, namespace) {
  const stored = [];
  
  for (const memory of memories) {
    const ttlDays = TTL_BY_KIND[memory.kind] || 90;
    
    const key = await store.put(
      namespace,
      null, // auto-generate key
      memory,
      {
        ttlDays,
        source: "synthesis",
        index: true // Create embeddings
      }
    );
    
    stored.push({ key, ...memory });
  }
  
  return stored;
}
```

## Testing Strategy

### Unit Tests
1. Test extraction with sample conversations
2. Test deduplication logic
3. Test TTL assignment
4. Test importance scoring

### Integration Tests
1. Full synthesis flow with real LLM
2. Storage and retrieval verification
3. Embedding generation
4. Performance benchmarks

## Performance Considerations

### Optimizations
- Batch embedding generation
- Cache recent extractions to avoid re-processing
- Limit message history to last 8-10 messages
- Use streaming for large conversations

### Metrics to Track
- Extraction time per conversation
- Number of memories extracted
- Deduplication hit rate
- Storage success rate

## Error Handling

### Graceful Failures
- If LLM fails, log and continue without synthesis
- If storage fails, retry with exponential backoff
- If embeddings fail, store without semantic search capability
- Never block main conversation flow

## Configuration Options
```javascript
const DEFAULT_CONFIG = {
  messagesLookback: 8,        // How many messages to analyze
  synthesisInterval: 5,        // Synthesize every N turns
  minImportance: 2,           // Minimum importance to store
  dedupeThreshold: 0.9,       // Similarity threshold for duplicates
  maxMemoriesPerBatch: 10,    // Max memories to extract at once
  enableAutoSynthesis: true   // Auto-synthesize vs manual only
};
```

## Success Criteria
- ✅ Extracts 2-5 relevant memories per conversation
- ✅ No duplicate memories stored (>90% similarity)
- ✅ Appropriate TTLs applied by memory type
- ✅ Synthesis completes in <2 seconds
- ✅ Memories improve future conversation context
- ✅ System handles failures gracefully

## Next Steps After Implementation
1. Wire into orchestrator at conversation end
2. Add synthesis triggers for completed actions
3. Create memory management UI
4. Implement Mem0 integration for suggestions
5. Add memory analytics dashboard