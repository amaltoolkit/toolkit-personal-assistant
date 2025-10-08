# BlueSquare Assistant Chrome Extension

A Chrome extension that authenticates with BlueSquareApps via OAuth 2.0 and provides AI-powered assistant capabilities through a side panel interface.

## 📁 Project Structure

```
/
├── src/                          # Backend source code
│   ├── agents/                   # Multi-agent system
│   │   ├── coordinator/          # Main orchestrator
│   │   └── domains/              # Domain-specific agents
│   │       ├── calendar/         # Calendar agent
│   │       ├── contact/          # Contact agent
│   │       ├── task/             # Task agent
│   │       ├── workflow/         # Workflow agent
│   │       └── general/          # General conversational agent
│   ├── core/                     # Core infrastructure
│   │   ├── state/                # State management & persistence
│   │   ├── memory/               # Memory system
│   │   ├── auth/                 # Authentication & PassKey management
│   │   └── websocket/            # Real-time communication
│   ├── services/                 # Business logic services
│   │   ├── entities/             # Entity management
│   │   ├── planning/             # Planning services
│   │   ├── approval/             # Approval system
│   │   ├── memory/               # Memory services
│   │   ├── sync/                 # Sync services
│   │   └── errors/               # Error handling
│   ├── integrations/             # External integrations
│   │   └── bsa/                  # BlueSquare Apps integration
│   ├── utils/                    # Utility functions
│   ├── routes/                   # HTTP routes
│   ├── database/                 # Database migrations & scripts
│   └── server.js                 # Main Express server
├── client/                       # Chrome Extension frontend
│   ├── sidepanel/                # Side panel UI
│   ├── components/               # UI components
│   ├── lib/                      # Third-party libraries
│   ├── services/                 # Client services
│   ├── styles/                   # Stylesheets
│   └── assets/                   # Static assets
├── tests/                        # Test suite
│   ├── unit/                     # Unit tests
│   ├── integration/              # Integration tests
│   ├── e2e/                      # End-to-end tests
│   └── debug/                    # Debug scripts
└── docs/                         # Documentation
    ├── architecture/             # Architecture documentation
    ├── api/                      # API documentation
    ├── agents/                   # Agent documentation
    └── tasks/                    # Implementation tasks
```

## 🏗️ Architecture

### Three-Tier Security Architecture
1. **Chrome Extension (MV3)** - Side panel UI that NEVER sees PassKeys
2. **Express Backend on Vercel** - Handles OAuth flow and proxies all API calls
3. **Supabase Database** - Stores PassKeys and session data

### Technology Stack
- **Frontend**: Vanilla JS, Marked.js, DOMPurify (Chrome Extension Manifest V3)
- **Backend**: Node.js, Express 4.x, CommonJS modules
- **AI/LLM**: LangChain 0.3.x, LangGraph, OpenAI GPT-4o-mini
- **Date Handling**: Day.js with timezone/quarter/week plugins, Chrono
- **Database**: Supabase (PostgreSQL)
- **Deployment**: Vercel (serverless functions)

## 🚀 Setup Instructions

### 1. Database Setup (Supabase)

Create the following tables in your Supabase database:

```sql
-- OAuth sessions table
CREATE TABLE oauth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_at TIMESTAMPTZ
);

-- BSA tokens table (stores PassKey in plain text)
CREATE TABLE bsa_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL UNIQUE,
  passkey TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_oauth_sessions_state ON oauth_sessions(state);
CREATE INDEX idx_oauth_sessions_session_id ON oauth_sessions(session_id);
CREATE INDEX idx_bsa_tokens_session_id ON bsa_tokens(session_id);
```

Run the LTM semantic search migration:
```bash
psql $POSTGRES_CONNECTION_STRING < src/database/migrations/create_ltm_semantic_search.sql
```

### 2. Backend Deployment (Vercel)

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables in Vercel:
```
BSA_BASE=https://rc.bluesquareapps.com
BSA_CLIENT_ID=YOUR_BSA_CLIENT_ID
BSA_CLIENT_SECRET=YOUR_BSA_CLIENT_SECRET
BSA_REDIRECT_URI=YOUR_VERCEL_URL/auth/callback
SUPABASE_URL=YOUR_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
POSTGRES_CONNECTION_STRING=YOUR_POSTGRES_CONNECTION_STRING
APP_BASE_URL=YOUR_APP_BASE_URL
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
```

3. Deploy to Vercel:
```bash
vercel
```

### 3. Chrome Extension Installation

1. Generate icons (if needed):
   - Open `client/assets/tools/generate-icons.html` in a browser
   - Right-click each canvas and save as the corresponding PNG file

2. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `client` directory

### 4. Local Development

For local development of the backend:

1. Create a `.env` file with all required environment variables

2. Run the backend locally:
```bash
npm run dev
```

3. For LangGraph Studio:
```bash
npm run studio
```

## 📖 Core Features

### Multi-Agent Architecture
- **Coordinator**: Routes queries to specialized domain agents
- **Calendar Agent**: Manages appointments and schedules
- **Task Agent**: Handles task creation and management
- **Contact Agent**: Search and disambiguation
- **Workflow Agent**: Process automation and workflows
- **General Agent**: Conversational queries and information retrieval

### Memory System
- Long-term memory with Mem0 integration
- Semantic search capabilities
- User preference learning
- Context-aware responses

### Authentication
- Secure OAuth 2.0 flow with BSA
- Automatic PassKey refresh
- Session management
- Multi-organization support

## 🧪 Testing

Run tests:
```bash
# Unit tests
npm test tests/unit/

# Integration tests
npm test tests/integration/

# E2E tests
npm test tests/e2e/
```

## 📚 Documentation

- [Architecture Overview](docs/architecture/overview.md)
- [API Documentation](docs/api/)
- [Agent Documentation](docs/agents/)
- [CLAUDE.md](docs/CLAUDE.md) - Claude AI guidance
- [LangGraph Studio Guide](docs/LANGGRAPH_STUDIO.md)

## 🔐 Security Considerations

- PassKeys stored securely in Supabase
- Service role key never exposed to client
- Session-based authentication with CSRF protection
- Input sanitization for markdown rendering
- HTTPS-only communication

## 📝 License

Private project - All rights reserved

## 🔄 Recent Changes

See [REFACTORING_STATUS.md](REFACTORING_STATUS.md) for details on the folder structure reorganization.
