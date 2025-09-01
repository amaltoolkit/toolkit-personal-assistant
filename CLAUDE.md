# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Plan & Review

### Before starting work
- Always in plan mode to make a plan
- After getting the plan, make sure you Write the plan to. .claude/tasks/TASK_NAME.md.
- The plan should be a detailed implementation plan and the reasoning behind them, as well as tasks broken down.
- If the task require external knowledge or certain package, also research to get latest knowledge (Use Task tool for research)
- Once you write the plan, firstly ask me to review it. Do not continue until I approve the plan.

### While implementing
- You should update the plan as you work.
- After you complete tasks in the plan, you should update and append detailed descriptions of the changes you made, so following tasks can be easily hand over to other engineers.

## Project Overview

This is a Chrome Extension with a Node.js/Express backend that authenticates with BlueSquareApps (BSA) via OAuth 2.0. The system exchanges OAuth tokens for PassKeys, which are stored in Supabase and used for all BSA API calls.

## Architecture

### Three-Tier System
1. **Chrome Extension (MV3)** - Side panel UI that never sees PassKeys
2. **Express Backend on Vercel** - Handles OAuth flow and proxies all API calls
3. **Supabase Database** - Stores PassKeys and session data

### Authentication Flow
1. Extension generates session ID → opens OAuth window
2. Backend exchanges OAuth code → bearer token → PassKey (two-step exchange)
3. PassKey stored in `bsa_tokens.passkey` field (plain text, 1-hour expiry)
4. All BSA API calls use PassKey from Supabase (auto-refreshes when <5 min remaining)

### Key Security Design
- PassKeys NEVER sent to extension (only session IDs)
- Backend is the ONLY entity with database access (service role key)
- PassKey refresh uses `/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/login.json`

## Development Commands

```bash
# Local Development
npm run dev              # Run backend locally on port 3000
npm install             # Install dependencies

# Deployment
vercel                  # Deploy to Vercel (production)
vercel --prod          # Force production deployment

# Chrome Extension
# Load unpacked from /extension directory in Chrome
# No build step required - vanilla JS
```

## Environment Variables

Required in Vercel (or .env for local):
- `BSA_BASE` - https://rc.bluesquareapps.com
- `BSA_CLIENT_ID` - OAuth client ID
- `BSA_CLIENT_SECRET` - OAuth client secret  
- `BSA_REDIRECT_URI` - Your Vercel URL + /auth/callback
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Full access key (keep secure)
- `APP_BASE_URL` - Your deployed app URL

## Database Schema

Two tables in Supabase:
- `oauth_sessions` - Temporary OAuth state tracking
- `bsa_tokens` - PassKey storage (passkey field, not access_token)

## API Endpoints

### OAuth Flow
- `GET /auth/start?session_id=...` - Initiates OAuth
- `GET /auth/callback?code=...&state=...` - Handles OAuth callback
- `GET /auth/status?session_id=...` - Polling endpoint

### Data Endpoints (require session_id)
- `GET /api/orgs?session_id=...` - List organizations
- `POST /api/orgs/:orgId/contacts?session_id=...` - List contacts

## Testing the OAuth Flow

1. Open Chrome extension side panel
2. Click "Login with BlueSquareApps"
3. Complete OAuth in popup window
4. Extension polls until PassKey is stored
5. Select organization → view contacts

## Common Issues & Solutions

### PassKey Expiration
PassKeys expire in 1 hour. The system auto-refreshes when <5 minutes remain. If expired, the refresh mechanism in `refreshPassKey()` obtains a new one.

### Local Development
Extension automatically switches between localhost:3000 (dev) and production URL based on protocol.

### Debugging
Enable Chrome DevTools to see detailed logs prefixed with:
- `[AUTH START]` - OAuth initiation
- `[PROCESS OAUTH]` - Background OAuth processing  
- `[SIDEPANEL]` - Extension client operations

## Important Implementation Details

### PassKey vs OAuth Token
- OAuth bearer token from `/oauth2/token` is temporary and discarded
- Only PassKey from `/oauth2/passkey` is stored and used
- Database field is named `passkey` (was `access_token` historically)

### Background Processing
OAuth callback immediately redirects user while processing continues asynchronously to improve UX.

### Content-Type Headers
- Token exchange uses `application/x-www-form-urlencoded`
- PassKey exchange and API calls use `application/json`

## Supabase MCP Tools Available

When working with the database, use the Supabase MCP tools:
- `mcp__supabase__list_projects` - Get project IDs
- `mcp__supabase__execute_sql` - Run queries
- `mcp__supabase__apply_migration` - Apply schema changes

Project IDs:
- Primary: `fscwwerxbxzbszgdubbo`
- Secondary: `wpghmnfuywvrwwhnzfcn`