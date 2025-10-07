# LangSmith Configuration for Vercel

## Overview
LangSmith provides comprehensive observability and tracing for the multi-agent orchestrator system. When configured, it captures detailed execution traces, routing decisions, and performance metrics.

## Environment Variables Required

Add these environment variables to your Vercel project settings:

```env
# Enable LangSmith tracing
# NEW (v0.2+): LANGSMITH_TRACING=true
# LEGACY: LANGCHAIN_TRACING_V2=true
# Both work, but newer versions prefer LANGSMITH_TRACING
LANGCHAIN_TRACING_V2=true

# Your LangSmith API key
LANGCHAIN_API_KEY=your-api-key-here

# Project name in LangSmith
# NEW (v0.2.16+): LANGSMITH_PROJECT=toolkit-personal-assistant
# LEGACY: LANGCHAIN_PROJECT=toolkit-personal-assistant
# Both work, but newer versions prefer LANGSMITH_PROJECT
LANGCHAIN_PROJECT=toolkit-personal-assistant

# LangSmith API endpoint (optional, defaults to the value below)
LANGCHAIN_ENDPOINT=https://api.smith.langchain.com

# CRITICAL for serverless environments (Vercel, AWS Lambda, etc.)
# Ensures tracing callbacks complete before function terminates
LANGCHAIN_CALLBACKS_BACKGROUND=false
```

## Setting Up in Vercel

1. Go to your Vercel project dashboard
2. Navigate to Settings → Environment Variables
3. Add each variable above with your values
4. Deploy the changes

## What Gets Traced

When LangSmith is enabled, the following is automatically traced:

### 1. **Orchestrator Graph Execution**
- Complete routing flow from supervisor to agents
- State transitions between nodes
- Decision reasoning from the supervisor

### 2. **Supervisor Decisions**
- Query analysis and classification
- Routing logic (LLM-based and keyword fallback)
- Agent selection reasoning

### 3. **Agent Executions**
- Activities Agent: Calendar queries, task fetching
- Workflow Builder Agent: Process creation, step additions
- Tool calls and responses
- Error handling and retries

### 4. **Performance Metrics**
- End-to-end latency
- Time spent in each node
- Token usage per request
- API call durations

## Viewing Traces

Once configured, traces are visible at:
https://smith.langchain.com

Navigate to your project to see:
- Real-time trace visualization
- Step-by-step execution details
- Performance analytics
- Error tracking

## Trace Organization

Traces are organized with:

### Tags
- `project:toolkit-personal-assistant`
- `org:{organization-id}`
- `timezone:{user-timezone}`
- `agent:activities` or `agent:workflow`
- `orchestrator:supervisor`

### Metadata
- Query text (first 100 chars)
- Organization ID
- Timestamp
- Environment (production/development)

## Benefits of LangSmith Integration

1. **Debugging**: Step-through execution of routing decisions
2. **Performance**: Identify bottlenecks and slow operations
3. **Monitoring**: Track error rates and success metrics
4. **Optimization**: Analyze token usage and reduce costs
5. **Compliance**: Audit trail of all AI decisions

## Testing the Integration

After configuring:

1. Make a request to `/api/orchestrator/query`
2. Check console logs for `[LangSmith] Tracing enabled`
3. Visit https://smith.langchain.com
4. Navigate to your project
5. View the trace for your request

## Implementation Best Practices

### Ensuring Traces Complete in Serverless

For serverless environments (Vercel, AWS Lambda), traces may not complete if the function terminates before callbacks finish. Our implementation uses two strategies:

1. **Set `LANGCHAIN_CALLBACKS_BACKGROUND=false`** (configured in [api/index.js:8-10](api/index.js#L8-L10))
   - Forces callbacks to complete synchronously
   - Set BEFORE any LangChain imports (critical!)

2. **Use `awaitAllCallbacks()` in finally blocks** (implemented in [api/routes/agent.js:499-508](api/routes/agent.js#L499-L508))
   ```javascript
   const { awaitAllCallbacks } = require("@langchain/core/callbacks/promises");

   try {
     // ... agent execution
   } catch (error) {
     // ... error handling
   } finally {
     // Ensure traces complete even on errors
     await awaitAllCallbacks();
   }
   ```

This ensures traces are captured even when errors occur, which is critical for debugging production issues.

## Troubleshooting

### Traces Not Appearing?
- Verify `LANGCHAIN_TRACING_V2=true` (must be string "true")
- Check API key is correct
- Ensure project name matches in LangSmith dashboard
- Check Vercel logs for LangSmith initialization messages
- **IMPORTANT**: Verify `LANGCHAIN_CALLBACKS_BACKGROUND=false` is set in Vercel
  - Without this, traces may not complete in serverless environments
  - This is the most common cause of missing traces in Vercel deployments
- Check for `awaitAllCallbacks()` in finally blocks of async handlers

### Performance Impact
- With `LANGCHAIN_CALLBACKS_BACKGROUND=false`: Small latency added for trace completion
  - Typically 50-200ms per request
  - Necessary trade-off for serverless reliability
- Failed trace uploads don't affect requests (caught in finally block)
- Consider using `LANGCHAIN_CALLBACKS_BACKGROUND=true` for long-running servers (non-serverless)

## Cost Considerations

- LangSmith has usage-based pricing
- Free tier available for development
- Production usage may incur costs
- Monitor usage in LangSmith dashboard

## Security Notes

- API key is stored securely in Vercel (never in code)
- Sensitive data can be filtered from traces
- PII should not be included in metadata
- Traces are retained based on your LangSmith plan

## Support

For LangSmith issues:
- Documentation: https://docs.smith.langchain.com
- Support: support@langchain.com

For integration issues:
- Check Vercel logs for errors
- Review this documentation
- Verify environment variables

---

*Last Updated: January 3, 2025*