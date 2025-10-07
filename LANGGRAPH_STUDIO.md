# LangGraph Studio - Graph Visualization Guide

## Overview

LangGraph Studio provides a visual graph view of your multi-agent architecture, allowing you to see and debug the flow of your coordinator and all subgraphs.

## Quick Start

### 1. Start Studio

```bash
npm run studio
```

This will output:
```
LangGraph API server listening on http://localhost:2024
LangGraph Studio Web UI: https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024
```

### 2. Open in Browser

Click or copy the Studio Web UI URL into your browser (Chrome/Edge recommended):

```
https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024
```

### 3. View Your Graphs

You'll see a list of all available graphs:
- **coordinator** - Main orchestrator that routes queries
- **calendar** - Calendar/appointment management
- **task** - Task/todo management
- **workflow** - Multi-step process builder
- **contact** - Contact search and resolution
- **general** - Conversational Q&A agent

## What You Can Do

### Visual Graph View

See your graph as a flowchart:
- **Nodes** - Each step in the graph (rectangles)
- **Edges** - Connections between steps (arrows)
- **Conditional Edges** - Decision points (diamonds)
- **Entry/Exit Points** - Start and end nodes

### Interactive Testing

1. Click on any graph to open it
2. Click "Start New Thread"
3. Send test queries
4. Watch execution flow in real-time

### State Inspection

- View state at each node
- See message history
- Inspect entity storage
- Check routing decisions

### Execution Tracing

- See which nodes executed
- View timing for each step
- Identify bottlenecks
- Debug errors

## Browser Compatibility

### Chrome/Edge (Recommended)
Works perfectly - allows HTTP on localhost

### Safari
May show "Failed to load assistants" errors. Use tunnel mode instead:

```bash
npm run studio:tunnel
```

This creates a secure HTTPS tunnel that Safari accepts.

## Configuration

Your project is configured via `langgraph.json`:

```json
{
  "node_version": "20",
  "dependencies": ["."],
  "graphs": {
    "coordinator": "./api/coordinator/index.js:graph",
    "calendar": "./api/subgraphs/calendar.js:graph",
    "task": "./api/subgraphs/task.js:graph",
    "workflow": "./api/subgraphs/workflow.js:graph",
    "contact": "./api/subgraphs/contact.js:graph",
    "general": "./api/subgraphs/general.js:graph"
  },
  "env": ".env"
}
```

## Environment Variables

Studio needs access to:
- `POSTGRES_CONNECTION_STRING` - For checkpointer (state persistence)
- `OPENAI_API_KEY` - For LLM calls
- All BSA-related variables - For subgraph execution

Make sure your `.env` file has all required variables.

## Example: Testing the Coordinator

1. Start Studio: `npm run studio`
2. Open the **coordinator** graph
3. Click "Start New Thread"
4. Enter query: "Schedule a meeting with John tomorrow at 2pm"
5. Watch the flow:
   ```
   recall_memory
   ↓
   route_domains (LLM decides: calendar + contact)
   ↓
   execute_subgraphs (parallel execution)
   ↓
   finalize_response
   ```

## Example: Viewing Calendar Agent Flow

1. Open the **calendar** graph
2. See all nodes:
   - parse_request
   - resolve_contacts
   - resolve_users
   - check_conflicts
   - generate_preview
   - approval (interrupt point!)
   - create_appointment
   - format_response

3. Notice **approval** node - this is where graph interrupts for user approval

## Debugging with Studio

### Problem: Query goes to wrong agent
**Solution:** Check router decision in coordinator graph
- Open coordinator graph
- Look at `route_domains` node output
- See why LLM chose that domain

### Problem: Subgraph fails
**Solution:** Open specific subgraph to see which node failed
- View error message in state
- Check inputs to failed node
- Verify BSA API responses

### Problem: Slow execution
**Solution:** Check node timing
- See which nodes take longest
- Identify BSA API bottlenecks
- Optimize expensive LLM calls

## Hot Reload

Studio supports hot reload:
1. Keep Studio running
2. Edit graph code in your editor
3. Save the file
4. Reload the graph in Studio (refresh button)
5. Changes are reflected immediately!

## Limitations

- **Local development only** - Not for production use
- **No multi-user** - Single developer instance
- **Memory-based state** - Uses local PostgreSQL for checkpoints
- **No authentication** - Assumes localhost security

## Troubleshooting

### "Failed to connect to server"
- Check if Studio is running (`npm run studio`)
- Verify port 2024 is available
- Check console for errors

### "Failed to load graphs"
- Verify `langgraph.json` is valid JSON
- Check graph exports in modules
- Ensure `POSTGRES_CONNECTION_STRING` is set

### "Graph execution failed"
- Check environment variables in `.env`
- Verify BSA credentials are valid
- Check console logs for detailed errors

### Browser CORS errors
- Use Chrome/Edge instead of Safari
- Or use tunnel mode: `npm run studio:tunnel`

## Production vs Studio

| Feature | Production (Vercel) | Studio (Local) |
|---------|-------------------|----------------|
| Purpose | Live API | Development/Debug |
| Access | Chrome Extension | Browser UI |
| State | PostgreSQL | Local PostgreSQL |
| Visualization | LangSmith Traces | Studio Graph View |
| Testing | Real users | Manual testing |

Both use the same code, but Studio provides interactive debugging tools.

## Next Steps

1. Explore each graph visually
2. Test different queries
3. Debug routing decisions
4. Optimize slow nodes
5. Understand approval flow

## Support

For LangGraph Studio issues:
- Documentation: https://langchain-ai.github.io/langgraphjs/concepts/langgraph_studio/
- GitHub: https://github.com/langchain-ai/langgraphjs-studio-starter

For project-specific issues:
- Check coordinator logs
- Review subgraph implementation
- Verify BSA API responses

---

*Last Updated: January 2025*
