# Approval Flow Fixes - September 15, 2025

## Problem Summary
The appointment approval flow was not working end-to-end. Multiple issues were discovered:
1. Duplicate approval cards showing in UI
2. "Conversation state could not be recovered" error
3. Approval UI not showing despite approval being detected
4. Interrupt not propagating through LangGraph

## Root Cause Analysis

### Issue 1: Stateless Subgraphs Cannot Throw Interrupts
- **Discovery**: Subgraphs in V2 architecture are stateless (no checkpointer)
- **Impact**: Calendar subgraph's `throw interrupt()` was silently failing
- **Solution**: Implement coordinator-level interrupt pattern

### Issue 2: Missing State Channel Fields
- **Discovery**: LangGraph was stripping `approvalRequest` and `approval_decision` fields
- **Impact**: Approval data was lost during state transitions
- **Solution**: Added fields to both CalendarStateChannels and CoordinatorStateChannels

### Issue 3: Duplicate Interrupt Import
- **Discovery**: Using both static import and dynamic import of `interrupt`
- **Impact**: Two different interrupt instances, causing propagation issues
- **Solution**: Use only the statically imported interrupt

### Issue 4: Debug Logging Bug
- **Discovery**: Checking `approvalContext` instead of `approvalRequest`
- **Impact**: Misleading debug logs showing `hasApprovalContext: false`
- **Solution**: Fixed to check `approvalRequest` field

## Implementation Details

### 1. Calendar Subgraph Changes (`api/subgraphs/calendar.js`)
```javascript
// Added to CalendarStateChannels
approvalRequest: {
  value: (x, y) => y ? y : x,
  default: () => null
},
approval_decision: {
  value: (x, y) => y ? y : x,
  default: () => null
}

// Modified approvalNode to return request instead of throwing
return {
  ...state,
  requiresApproval: true,
  approvalRequest: {
    domain: 'calendar',
    type: 'approval_required',
    actionId: `calendar_${Date.now()}`,
    action: state.action,
    preview: state.preview,
    data: state.appointment_data,
    message: `Please review this ${state.action} action:`,
    thread_id: state.thread_id || null
  },
  approved: false
};
```

### 2. Coordinator Changes (`api/coordinator/index.js`)
```javascript
// Added to CoordinatorStateChannels
approval_decision: {
  value: (x, y) => y ? y : x,
  default: () => null
},
pendingApproval: {
  value: (x, y) => y ? y : x,
  default: () => null
}

// Coordinator-level interrupt throwing
if (approvalRequests.length > 0) {
  // Consolidate requests
  const consolidatedRequest = {
    type: "approval_required",
    previews: approvalRequests.map(req => ({...})),
    // ...
  };

  // Store context for resume
  state.pendingApproval = {
    domains: approvalRequests.map(req => req.domain),
    results: results,
    requests: approvalRequests
  };

  // Use statically imported interrupt
  throw interrupt({
    value: consolidatedRequest
  });
}
```

### 3. Approval Endpoint Fix (`api/routes/agent.js`)
```javascript
// Fixed resume logic
const result = await coordinator.processQuery(null, {
  ...checkpoint.state,
  ...resumeData,
  org_id,
  session_id,
  thread_id,
  user_id,
  checkpoint_id: config.configurable.checkpoint_id,
  timezone: time_zone || DEFAULT_TIMEZONE
});
```

### 4. Frontend Fix (`extension/sidepanel.js`)
- Skip polling when previews already exist in HTTP response
- Send `decision` field for V2 architecture compatibility

## Architecture Pattern: Coordinator-Level Interrupts for Stateless Subgraphs

Since subgraphs are stateless (no checkpointer), they cannot throw interrupts directly. The pattern is:

1. **Subgraph**: Return `requiresApproval: true` and `approvalRequest` object
2. **Coordinator**: Detect approval requests from subgraphs
3. **Coordinator**: Consolidate and throw interrupt at coordinator level
4. **LangGraph**: Saves checkpoint and returns with `__interrupt__` field
5. **API**: Detects interrupt and returns approval UI to frontend
6. **Frontend**: Shows approval UI and sends decision
7. **API**: Resumes graph with approval decision

## Testing Status
- ✅ Fixed duplicate approval cards
- ✅ Fixed debug logging
- ✅ Fixed duplicate interrupt import
- ✅ Added missing state channel fields
- ✅ Cleared Supabase for clean testing
- 🔄 Ready for end-to-end testing

## Next Steps
1. Test appointment creation with approval flow
2. Verify interrupt propagates correctly
3. Confirm approval UI shows in frontend
4. Test approval/rejection flow
5. Verify appointment is created after approval