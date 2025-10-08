# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Plan & Review

### Before starting work
- Always start in plan mode to make a plan
- After getting the plan, make sure you write the plan to `.claude/tasks/TASK_NAME.md`
- The plan should be a detailed implementation plan with reasoning and tasks broken down
- If the task requires external knowledge or certain packages, research to get latest knowledge (Use Task tool for research)
- Once you write the plan, ask for review. Do not continue until the plan is approved

### While implementing
- Update the plan as you work
- After you complete tasks in the plan, update and append detailed descriptions of the changes made
- This ensures following tasks can be easily handed over to other engineers

## Project Overview

BlueSquare Assistant - A secure Chrome Extension with AI-powered assistant capabilities for BlueSquare Apps (BSA) integration.

### Core Functionality
- OAuth 2.0 authentication with BSA
- AI assistant for calendar management using LangChain
- Natural language date parsing for queries like "this week" or "next month"
- Secure PassKey management with automatic refresh
- Real-time chat interface with markdown rendering

## Architecture

### Three-Tier Security Architecture
1. **Chrome Extension (MV3)** - Side panel UI that NEVER sees PassKeys
2. **Express Backend on Vercel** - Handles OAuth flow and proxies all API calls
3. **Supabase Database** - Stores PassKeys and session data

### Technology Stack
- **Frontend**: Vanilla JS, Marked.js, DOMPurify (Chrome Extension Manifest V3)
- **Backend**: Node.js, Express 4.x, CommonJS modules
- **AI/LLM**: LangChain 0.3.x, OpenAI GPT-4o-mini, Zod schemas
- **Date Handling**: Day.js with timezone/quarter/week plugins
- **Database**: Supabase (PostgreSQL)
- **Deployment**: Vercel (serverless functions)

### Authentication Flow
1. Extension generates session ID → opens OAuth window
2. Backend exchanges OAuth code → bearer token → PassKey (two-step exchange)
3. PassKey stored in `bsa_tokens.passkey` field (plain text, 1-hour expiry)
4. All BSA API calls use PassKey from Supabase (auto-refreshes when <5 min remaining)
5. Background processing for better UX (immediate redirect, async token exchange)

### BSA URL Configuration
- Centralized configuration module at `api/config/bsa.js`
- Smart environment detection based on URL in `BSA_BASE`
- Automatically detects RC vs Production environments
- Single point of control - change `BSA_BASE` in Vercel to switch environments
- No frontend changes needed - entirely backend-controlled

### Key Security Principles
- PassKeys NEVER sent to extension (only session IDs)
- Backend is the ONLY entity with database access (service role key)
- PassKey refresh uses `/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/login.json`
- Session-based authentication with CSRF protection
- Input sanitization for markdown rendering (DOMPurify)

## Critical Implementation Patterns

### LangChain Tool Implementation (MUST USE)
```javascript
// CORRECT - Use tool() function with Zod schemas
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const myTool = tool(
  async (input) => {
    // Tool implementation - input is already parsed object
    return JSON.stringify(result);
  },
  {
    name: "tool_name",
    description: "Tool description",
    schema: z.object({
      param: z.string()
    })
  }
);

// WRONG - These patterns cause errors
// ❌ StructuredTool class - causes toLowerCase error
// ❌ DynamicTool with string input - incompatible with modern agents
// ❌ createOpenAIFunctionsAgent - deprecated, causes empty responses
```

### Agent Creation Pattern (MUST USE)
```javascript
// CORRECT - Modern tool-calling agent
const { createToolCallingAgent } = await import("langchain/agents");

// WRONG - Deprecated patterns
// ❌ createOpenAIFunctionsAgent - returns empty responses
```

### Natural Language Date Support
```javascript
// Import the reusable date parser
const { parseDateQuery, extractDateFromQuery } = require('./lib/dateParser');

// Use in any agent's tools
if (dateQuery && !startDate && !endDate) {
  const parsed = parseDateQuery(dateQuery, userTimezone);
  if (parsed) {
    startDate = parsed.startDate;
    endDate = parsed.endDate;
  }
}
```

## API Endpoints

### OAuth Flow Endpoints
- `GET /auth/start?session_id=...` - Initiates OAuth with CSRF protection
- `GET /auth/callback?code=...&state=...` - Handles OAuth callback (async processing)
- `GET /auth/status?session_id=...` - Polling endpoint for auth status

### Data Endpoints (require session_id)
- `GET /api/orgs?session_id=...` - List organizations
- `POST /api/assistant/query` - AI assistant queries with natural language support
  - Body: `{ query, session_id, org_id, time_zone }`
  - Rate limited: 10 requests/minute
  - Input validation: 1-500 characters

### BSA API Integration Patterns
```javascript
// BSA responses have two formats:
// 1. Most endpoints: Array wrapper [{ Results: [...], Valid: true }]
// 2. PassKey endpoint: Plain object { passkey: "...", expires_in: 3600 }

// Use normalizeBSAResponse() helper for array-wrapped responses
const normalized = normalizeBSAResponse(resp.data);
if (!normalized.valid) {
  throw new Error(normalized.error);
}
```

## Environment Variables

Required in Vercel:
- `BSA_BASE` - BSA API URL (auto-detects environment)
  - RC: `https://rc.bluesquareapps.com`
  - Production: `https://toolkit.bluesquareapps.com`
  - System automatically detects which environment based on URL
- `BSA_CLIENT_ID` - OAuth client ID
- `BSA_CLIENT_SECRET` - OAuth client secret
- `BSA_REDIRECT_URI` - Your Vercel URL + /auth/callback
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Full access key (keep secure)
- `APP_BASE_URL` - Your deployed app URL
- `OPENAI_API_KEY` - For LangChain AI assistant

## Database Schema

Two tables in Supabase:
- `oauth_sessions` - Temporary OAuth state tracking (CSRF protection)
  - Fields: `id`, `session_id`, `state`, `used_at`, `created_at`
- `bsa_tokens` - PassKey storage
  - Fields: `session_id`, `passkey`, `refresh_token`, `expires_at`, `updated_at`

## Supabase MCP Tools Available

When working with the database, use the Supabase MCP tools:
- `mcp__supabase__list_projects` - Get project IDs
- `mcp__supabase__execute_sql` - Run queries
- `mcp__supabase__apply_migration` - Apply schema changes

Project IDs:
- Primary: `fscwwerxbxzbszgdubbo`
- Secondary: `wpghmnfuywvrwwhnzfcn`

## Performance Optimizations

### Backend Optimizations
- HTTP Keep-Alive agents for connection reuse
- Module caching to prevent duplicate imports
- Lazy loading of LangChain modules
- Request ID tracking for debugging
- 10-second timeout for all BSA API calls

### Frontend Optimizations
- Debounced input handling
- Efficient DOM updates
- Lazy loading of markdown renderer
- Session caching in localStorage

## Code Style & Conventions

### JavaScript/Node.js
- CommonJS modules for backend (no ESM)
- Dynamic imports for LangChain modules
- Async/await over promises
- Comprehensive error handling with try/catch
- Descriptive console.log prefixes: `[COMPONENT:ACTION]`

### Chrome Extension
- Manifest V3 compliance
- Service worker for background tasks
- Content Security Policy compliance
- No inline scripts or styles

### Error Handling
- Always return meaningful error messages
- Log full errors to console for debugging
- User-friendly error messages in UI
- Automatic retry for PassKey refresh

## Deployment Commands

```bash
# Install dependencies
npm install

# Deploy to Vercel
vercel                  # Deploy to preview
vercel --prod          # Deploy to production

# Chrome Extension
# Load unpacked from /extension directory
# No build step required - vanilla JS
```

## Common Issues & Solutions

### PassKey Expiration
- PassKeys expire in 1 hour
- System auto-refreshes when <5 minutes remain
- If expired, `refreshPassKey()` obtains a new one using existing PassKey

### Extension Development
- Extension automatically detects environment based on protocol
- Use Chrome DevTools for debugging
- Check console for prefixed debug logs

### LangChain Issues
1. **"toLowerCase" error**: Use `tool()` function, not StructuredTool class
2. **Empty agent responses**: Use `createToolCallingAgent`, not deprecated functions
3. **Tool input mismatch**: Tools must accept objects, not strings
4. **Version conflicts**: Check package.json overrides section

### Content-Type Headers
- Token exchange: `application/x-www-form-urlencoded`
- PassKey exchange and API calls: `application/json`

## Project Structure

```
/
├── src/                          # Backend source code
│   ├── agents/                   # Multi-agent system
│   │   ├── coordinator/          # Main orchestrator
│   │   └── domains/              # Domain agents (calendar, contact, task, workflow, general)
│   ├── core/                     # Core infrastructure
│   │   ├── state/                # State management & persistence
│   │   ├── memory/               # Memory system
│   │   ├── auth/                 # Authentication & PassKey management
│   │   └── websocket/            # Real-time communication
│   ├── services/                 # Business logic services (grouped by domain)
│   ├── integrations/bsa/         # BlueSquare Apps integration
│   ├── utils/                    # Utility functions (date parsing, etc.)
│   ├── routes/                   # HTTP routes
│   ├── database/                 # Migrations & scripts
│   └── server.js                 # Main Express server
├── client/                       # Chrome Extension frontend
│   ├── sidepanel/                # Side panel UI (index.html, index.js, styles.css)
│   ├── components/               # UI components
│   ├── lib/                      # Third-party libraries (marked, purify)
│   ├── services/                 # Client services (websocket)
│   ├── styles/                   # Stylesheets
│   └── assets/                   # Static assets (icons)
├── tests/                        # Test suite (unit, integration, e2e, debug)
├── docs/                         # Documentation
│   ├── architecture/             # Architecture docs
│   ├── api/                      # API docs
│   └── agents/                   # Agent docs
├── package.json                  # Dependencies and scripts
├── langgraph.json                # LangGraph Studio configuration
└── vercel.json                   # Deployment configuration
```

## Current Implementation Status

### Phase 1 Complete ✅
- OAuth 2.0 flow with PassKey management
- Calendar Agent with natural language date support
- AI assistant with markdown chat interface
- Organization selection and data fetching
- Rate limiting and input validation
- Production deployment on Vercel

### Phase 2 Complete ✅
- Task Agent for todo management
- LangGraph orchestration with multi-agent coordinator
- Contact Agent for advanced contact search
- Workflow Agent for process automation
- General Agent for conversational queries
- Cross-agent data sharing via EntityManager
- V2 architecture with domain-specific agents

## Testing Considerations

- OAuth flow requires production URLs (BSA redirects)
- Use Vercel preview deployments for testing
- Get real session_id from authenticated Chrome extension
- Check browser console for detailed debug logs
- Test PassKey refresh by waiting >55 minutes

## Important Notes

### Do NOT Modify
- Authentication flow (security critical)
- PassKey handling logic
- Database field names
- CORS configuration

### Always Remember
- PassKeys are sensitive - never log or expose them
- All BSA API calls require valid PassKey
- Organization selection is required for data endpoints
- Rate limiting is per session (10 req/min)
- Use modular patterns for new features (like dateParser.js)