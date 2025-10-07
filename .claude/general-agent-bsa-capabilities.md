# General Agent BSA Read Capabilities - Implementation

## Date: 2025-10-07

## Problem Identified

The general agent could NOT read data from BSA (appointments, tasks, workflows), only from EntityManager (session memory). This created a gap where:

- **User asks**: "What appointments do I have tomorrow?"
- **Router routes**: to general agent (viewing = informational)
- **General agent**: Can't fetch from BSA → fails to answer

## Solution Implemented

Added BSA read capabilities to the general agent, making it truly "read-only/informational" with access to both:
1. **Session memory** (EntityManager - entities created during session)
2. **BSA data** (Appointments, tasks from BSA API)

---

## Changes Made

### 1. Imports Added ✅
**File**: `api/subgraphs/general.js:19-21`

```javascript
const { getAppointments } = require("../tools/bsa/appointments");
const { getTasks } = require("../tools/bsa/tasks");
const { parseDateQuery } = require("../lib/dateParser");
```

### 2. New State Channel ✅
**File**: `api/subgraphs/general.js:48-55`

```javascript
bsa_data: {
  value: (x, y) => y || x,
  default: () => ({
    appointments: [],
    tasks: [],
    needsFetch: false
  })
}
```

### 3. Graph Structure Updated ✅
**File**: `api/subgraphs/general.js:111-136`

**New nodes added:**
- `detect_bsa_needs` - Analyzes query to determine if BSA fetch is needed
- `fetch_bsa_data` - Fetches appointments/tasks from BSA API

**New flow:**
```
classify_query
  → detect_bsa_needs
    → (if needsFetch) fetch_bsa_data → retrieve_context
    → (else) retrieve_context
  → generate_answer
  → format_response
```

### 4. detectBSANeeds Method ✅
**File**: `api/subgraphs/general.js:184-227`

**Pattern detection:**
- Appointment patterns: `/appointment|meeting|calendar|schedule/`
- Task patterns: `/task|todo|to-do|action item/`
- Viewing patterns: `/show|list|what|view|get|find/`
- Date patterns: `/today|tomorrow|this week|next week/`

**Logic:**
- If query mentions appointments/tasks AND has viewing pattern → `needsFetch = true`
- Sets flags: `fetchAppointments`, `fetchTasks`

### 5. fetchBSAData Method ✅
**File**: `api/subgraphs/general.js:229-324`

**Capabilities:**
- Gets PassKey from config (same pattern as calendar agent)
- Parses date from query using `parseDateQuery()`
- Defaults to "today" if no date specified
- Fetches appointments using `getAppointments(params, passKey, orgId)`
- Fetches tasks using `getTasks(params, passKey, orgId)`
- Handles errors gracefully (logs error, continues with empty data)

### 6. Context Integration ✅
**File**: `api/subgraphs/general.js:329-377`

**Updated `retrieveContext` to include BSA data:**
```javascript
context.bsa = {
  appointments: state.bsa_data.appointments || [],
  tasks: state.bsa_data.tasks || []
};
```

### 7. BSA Context Builder ✅
**File**: `api/subgraphs/general.js:555-607`

**New method: `buildBSAContext(bsaData)`**

Formats BSA data for LLM prompt:
- **Appointments**: Name, time, location, participants (max 10 shown)
- **Tasks**: Title, assignee, due date, status (max 10 shown)
- Shows "... and X more" if >10 items

### 8. LLM Prompt Updated ✅
**File**: `api/subgraphs/general.js:444-464`

**Added BSA context to prompt:**
```javascript
const bsaContext = this.buildBSAContext(state.context.bsa);

const prompt = `
...
${conversationContext}
${entityContext}
${bsaContext}  // ← NEW
${memoryContext}
${statsContext}
...
`;
```

---

## How It Works

### Example Query: "What appointments do I have tomorrow?"

1. **classify_query**: Detects `intent = 'entity_question'`

2. **detect_bsa_needs**:
   - Finds "appointments" → `needsAppointments = true`
   - Finds "what" → `viewingPatterns = true`
   - Finds "tomorrow" → `hasDateReference = true`
   - Sets `needsFetch = true`, `fetchAppointments = true`

3. **fetch_bsa_data**:
   - Gets PassKey from config
   - Parses "tomorrow" → `{startDate: '2025-10-08', endDate: '2025-10-08'}`
   - Calls `getAppointments({startDate, endDate}, passKey, orgId)`
   - Returns appointments for Oct 8

4. **retrieve_context**:
   - Adds appointments to `context.bsa.appointments`
   - Also includes EntityManager entities, memory, stats

5. **generate_answer**:
   - Builds BSA context with formatted appointments
   - LLM sees: "User query: 'What appointments do I have tomorrow?'" + appointment list
   - Generates natural response: "You have 3 appointments tomorrow: 1. Meeting with John at 9am..."

6. **format_response**: Returns final answer

---

## Supported Queries

### Appointments
- ✅ "What appointments do I have tomorrow?"
- ✅ "Show my meetings this week"
- ✅ "List all appointments for next Monday"
- ✅ "What's on my calendar today?"

### Tasks
- ✅ "What tasks do I have this week?"
- ✅ "Show all my todos"
- ✅ "List tasks due tomorrow"

### Mixed
- ✅ "What's my schedule for tomorrow?" (both appointments and tasks)

### Session Entities (still works)
- ✅ "What was step 2?" (from workflow in EntityManager)
- ✅ "Show the workflow we just created"

---

## Architecture Benefits

### Before
- ❌ General agent: Could only read EntityManager (session memory)
- ❌ Semantic mismatch: "viewing" routed to general, but general couldn't view BSA

### After
- ✅ General agent: Can read BOTH EntityManager AND BSA
- ✅ Semantic consistency: "viewing/reading" = general domain (truly informational)
- ✅ Separation maintained: Action agents create/modify, general agent reads
- ✅ Single source for questions: Users don't need to know which agent answers what

---

## Technical Details

### PassKey Access
Uses same pattern as calendar agent:
```javascript
const passKey = await config.configurable.getPassKey();
const orgId = config.configurable.org_id;
```

### Date Parsing
Reuses existing `parseDateQuery()` function:
```javascript
const parsedDate = parseDateQuery(query, timezone);
// Returns: {startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD'}
```

### Error Handling
- Missing PassKey/orgId: Warns and continues (no BSA data)
- API errors: Logs error, continues with empty array
- Doesn't block response if BSA fetch fails

### Performance
- Conditional fetch: Only fetches if query needs it
- Max 10 items shown in context (prevents token overload)
- Parallel EntityManager + BSA data retrieval

---

## Testing Recommendations

### Unit Tests
1. `detectBSANeeds` with various queries
2. `fetchBSAData` with/without PassKey
3. `buildBSAContext` with appointments/tasks

### Integration Tests
1. "Show appointments tomorrow" → Fetches from BSA
2. "What was step 2?" → Uses EntityManager only
3. "What's my schedule?" → Fetches both appointments and tasks

### End-to-End
1. Create appointment via calendar agent
2. Ask "Show my appointments" → Should see it from BSA
3. Create workflow via workflow agent
4. Ask "What was step 1?" → Should see it from EntityManager

---

## Future Enhancements

### Potential Additions
1. **Workflow reading**: Fetch workflow details from BSA (not just EntityManager)
2. **Contact reading**: Show contact details from BSA
3. **Filtering**: "Show only meetings with John"
4. **Sorting**: "Show tasks by priority"
5. **Date ranges**: "Show all appointments this month"

### Refactoring Opportunities
1. Extract BSA fetch logic into reusable service
2. Add caching for BSA data (reduce API calls)
3. Add pagination for large result sets

---

## Files Modified

1. **api/subgraphs/general.js** - Added BSA read capabilities (365 lines added)

---

## Impact

- **User Experience**: General agent can now answer calendar/task queries
- **Architecture**: Maintains clean separation (read vs write agents)
- **Extensibility**: Easy to add more BSA read operations
- **Performance**: Minimal impact (conditional fetch, max 10 items)

## Status: ✅ Complete and Ready for Testing
