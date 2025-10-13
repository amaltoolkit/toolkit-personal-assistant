// Load environment variables in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// ===== SUPPRESS VERBOSE TRACING LOGS =====
// Filter out OpenTelemetry baggage context and HTTP body warnings from console
// LangSmith traces still work properly - this only affects console output
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function shouldSuppressLog(args) {
  const msg = args.join(' ');
  return (
    msg.startsWith('Context: trace=') ||      // OpenTelemetry baggage context
    msg.includes('Body is unusable') ||       // HTTP body read warnings
    msg.includes('Body has already been read') // HTTP body read warnings (variant)
  );
}

console.log = (...args) => {
  if (shouldSuppressLog(args)) return;
  originalLog.apply(console, args);
};

console.warn = (...args) => {
  if (shouldSuppressLog(args)) return;
  originalWarn.apply(console, args);
};

console.error = (...args) => {
  if (shouldSuppressLog(args)) return;
  originalError.apply(console, args);
};
// ===== END LOG FILTERING =====

// Ensure LangSmith callbacks complete in serverless environment
// This MUST be set before any LangChain imports for proper tracing
if (!process.env.LANGCHAIN_CALLBACKS_BACKGROUND) {
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";
}

// Dependencies
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const http = require('http');
const https = require('https');

// Import BSA configuration
const bsaConfig = require('./integrations/bsa/config');

// Performance optimizations
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10
});
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10
});

// Module caching to prevent duplicate imports
const modulePromises = {};
const moduleCache = {};

// Axios config with keep-alive for connection reuse
const axiosConfig = {
  timeout: 10000,
  httpAgent: keepAliveAgent,
  httpsAgent: keepAliveHttpsAgent
};

// Cached LLM client getter
async function getLLMClient() {
  if (!moduleCache.llm) {
    if (!modulePromises.llm) {
      modulePromises.llm = import("@langchain/openai").then(({ ChatOpenAI }) => {
        moduleCache.llm = new ChatOpenAI({
          model: "gpt-4o-mini",
          temperature: 0
        });
        return moduleCache.llm;
      });
    }
    return modulePromises.llm;
  }
  return moduleCache.llm;
}

// Note: Specialized LLM client removed - handled by subgraphs now

// Express app initialization
const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// Supabase database connection
// Service role key provides full database access - NEVER expose to frontend
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// PostgreSQL connection pool for direct database operations
// Lazy initialized on first use to avoid issues if POSTGRES_CONNECTION_STRING is not set
let pgPool = null;
function getPgPool() {
  if (!pgPool && process.env.POSTGRES_CONNECTION_STRING) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.POSTGRES_CONNECTION_STRING,
      ssl: { rejectUnauthorized: false },
      max: 10, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 2000, // Timeout for new connections
    });
    
    pgPool.on('error', (err) => {
      console.error('[PG_POOL] Unexpected error on idle client', err);
    });
    
    console.log('[PG_POOL] PostgreSQL connection pool initialized');
  }
  return pgPool;
}

// Environment variables
const BSA_CLIENT_ID = process.env.BSA_CLIENT_ID;
const BSA_CLIENT_SECRET = process.env.BSA_CLIENT_SECRET;
const BSA_REDIRECT_URI = process.env.BSA_REDIRECT_URI;

// BSA_BASE is now managed by the config module
// Use bsaConfig.getBaseUrl() or bsaConfig.buildEndpoint() methods directly

// LangSmith Configuration (for observability)
// These environment variables enable comprehensive tracing when set in Vercel:
// LANGCHAIN_TRACING_V2=true
// LANGCHAIN_API_KEY=your-api-key
// LANGCHAIN_PROJECT=your-project-name
// LANGCHAIN_ENDPOINT=https://api.smith.langchain.com (optional)
if (process.env.LANGCHAIN_TRACING_V2 === 'true' && process.env.LANGCHAIN_API_KEY) {
  console.log('[LangSmith] Tracing enabled for project:', process.env.LANGCHAIN_PROJECT || 'default');
  console.log('[LangSmith] Traces will be visible at: https://smith.langchain.com');
}


// Note: Auth endpoints (start, callback, status) moved to src/routes/auth.js
// This keeps OAuth logic modular and follows the new architecture

// PassKey refresh helper
// Refreshes expired/expiring PassKeys using BSA's refresh endpoint
async function refreshPassKey(sessionId) {
  try {
    // Get existing PassKey from database
    const { data: rows, error } = await supabase
      .from("bsa_tokens")
      .select("*")
      .eq("session_id", sessionId)
      .limit(1);
    
    // Handle database errors or missing token
    if (error || !rows || !rows[0]) {
      console.error("[REFRESH_PASSKEY] Failed to get current PassKey:", error);
      return null;
    }
    
    const currentPassKey = rows[0].passkey;
    
    // Validate PassKey exists
    if (!currentPassKey) {
      console.error("[REFRESH_PASSKEY] No existing PassKey to refresh");
      return null;
    }
    
    // Call BSA refresh endpoint
    const refreshUrl = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.data.VCDataEndpoint/login.json');
    
    try {
      // Make refresh request using current PassKey
      const refreshResp = await axios.post(
        refreshUrl,
        { PassKey: currentPassKey },  // Authenticate with current PassKey
        {
          headers: { "Content-Type": "application/json" },
          ...axiosConfig  // Apply keep-alive agents for connection reuse
        }
      );
      
      // Extract new PassKey from response
      // BSA may return PassKey in different formats:
      // - Array format: [{ PassKey: "...", Valid: true, ... }]
      // - Direct object with lowercase: { passkey: "...", user_id: "...", expires_in: 3600 }
      const responseData = Array.isArray(refreshResp.data) ? refreshResp.data[0] : refreshResp.data;
      // Check both PascalCase 'PassKey' and lowercase 'passkey' field names
      const newPassKey = responseData?.PassKey || responseData?.passkey;
      const userId = responseData?.user_id || responseData?.UserId || responseData?.UserID;
      
      // Log the response structure for debugging
      console.log("[REFRESH_PASSKEY] Refresh response structure:", {
        hasPassKey: !!newPassKey,
        hasUserId: !!userId,
        userId: userId || "not found",
        responseKeys: Object.keys(responseData || {})
      });
      
      if (!newPassKey) {
        console.error("[REFRESH_PASSKEY] No new PassKey in refresh response:", refreshResp.data);
        return null;
      }
      
      // Store the new PassKey with fresh 1-hour expiry
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      
      const { error: updateError } = await supabase
        .from("bsa_tokens")
        .update({
          passkey: newPassKey,                        // New PassKey
          expires_at: expiresAt,                      // Fresh 1-hour expiry
          user_id: userId || null,                    // Update user ID if provided
          updated_at: new Date().toISOString()        // Track update time
        })
        .eq("session_id", sessionId);
      
      // Check for update errors
      if (updateError) {
        console.error("[REFRESH_PASSKEY] Failed to update PassKey in database:", updateError);
        return null;
      }
      
      return newPassKey;  // Return new PassKey for immediate use
      
    } catch (refreshError) {
      // Log detailed error information for debugging
      console.error("[REFRESH_PASSKEY] API error - Status:", refreshError.response?.status);
      console.error("[REFRESH_PASSKEY] API error - Data:", refreshError.response?.data);
      console.error("[REFRESH_PASSKEY] API error - Message:", refreshError.message);
      return null;
    }
  } catch (error) {
    // Catch any unexpected errors
    console.error("[REFRESH_PASSKEY] Unexpected error:", error);
    return null;
  }
}

// Get valid PassKey helper
// Retrieves PassKey and auto-refreshes if <5 minutes remaining
async function getValidPassKey(sessionId) {
  
  const { data: rows, error } = await supabase
    .from("bsa_tokens")
    .select("*")
    .eq("session_id", sessionId)
    .limit(1);
  
  // Handle database errors
  if (error) {
    console.error("[GET_PASSKEY] Database error:", error);
    return null;
  }
  
  // Check if token exists for this session
  if (!rows || !rows[0]) {
    console.error("[GET_PASSKEY] No token found for session:", sessionId);
    console.log("[GET_PASSKEY] Query returned rows:", rows);
    return null;
  }
  
  const token = rows[0];
  
  const passKey = token.passkey;
  if (!passKey) {
    console.error("[GET_PASSKEY] Token exists but passkey field is empty");
    return null;
  }
  
  // Check expiration and refresh if needed
  if (token.expires_at) {
    const expiry = new Date(token.expires_at);
    const now = new Date();
    const timeLeft = expiry - now;  // Time remaining in milliseconds
    
    // Refresh if less than 5 minutes remaining
    // This prevents API calls from failing due to expired tokens
    if (timeLeft < 5 * 60 * 1000) { // 5 minutes in milliseconds
      
      // Attempt to refresh the PassKey
      const newPassKey = await refreshPassKey(sessionId);
      
      if (newPassKey) {
        return newPassKey;
      } else {
        // Refresh failed - return existing PassKey (might still work)
        console.error("[GET_PASSKEY] Failed to refresh PassKey, using existing");
        return passKey;
      }
    }
  }
  
  // PassKey is still valid - return it
  return passKey;
}

// Note: Auth status endpoint moved to src/routes/auth.js

// BSA response normalization helper
// Unwraps array format: [{ Results/Organizations/etc: [...], Valid: true, ... }]
function normalizeBSAResponse(response) {
  try {
    // Handle null/undefined responses
    if (!response) {
      return { data: null, valid: false, error: 'No response data' };
    }
    
    // BSA returns responses in array format - unwrap the first element
    const responseData = Array.isArray(response) ? response[0] : response;
    
    // Check if response indicates an error
    if (responseData?.Valid === false) {
      return {
        data: responseData,
        valid: false,
        error: responseData.ResponseMessage || responseData.StackMessage || 'BSA API error'
      };
    }
    
    // Return normalized response
    return {
      data: responseData,
      valid: true,
      error: null
    };
  } catch (error) {
    console.error('[NORMALIZE_BSA] Error normalizing response:', error);
    return {
      data: response,
      valid: false,
      error: 'Failed to normalize BSA response'
    };
  }
}

// Fetch organizations helper
async function fetchOrganizations(passKey) {
  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.data.VCDataEndpoint/listMyOrganizations.json');
  
  try {
    // Make API call to BSA
    const resp = await axios.post(
      url, 
      { PassKey: passKey },  // Authenticate with PassKey
      { 
        headers: { "Content-Type": "application/json" },
        ...axiosConfig  // Apply keep-alive agents for connection reuse
      }
    );
    
    // Extract organizations from response
    const normalized = normalizeBSAResponse(resp.data);
    
    // Check if response is valid
    if (!normalized.valid) {
      console.error("[FETCH_ORGS] BSA returned invalid response:", normalized.error);
      throw new Error(normalized.error || 'Invalid response from BSA');
    }
    
    // Extract Organizations array from normalized response
    const orgsArray = normalized.data?.Organizations || [];
    
    // Validate organizations array
    if (Array.isArray(orgsArray)) {
      return orgsArray;
    } else {
      console.warn("[FETCH_ORGS] Organizations field is not an array:", typeof orgsArray);
      return [];
    }
  } catch (error) {
    // Log error and re-throw for caller to handle
    console.error("[FETCH_ORGS] BSA API error:", error.response?.status, error.message);
    throw error;
  }
}

// API endpoint: List organizations
app.get("/api/orgs", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    
    // Validate session ID is provided
    if (!sessionId) {
      console.error("[API/ORGS] Missing session_id parameter");
      return res.status(400).json({ error: "missing session_id" });
    }

    // Get valid PassKey (auto-refreshes if needed)
    const passKey = await getValidPassKey(sessionId);
    
    // Check if user is authenticated
    if (!passKey) {
      console.error("[API/ORGS] No PassKey found for session:", sessionId);
      return res.status(401).json({ error: "not authenticated", requiresReauth: true });
    }
    
    try {
      const orgs = await fetchOrganizations(passKey);
      
      // Return in the format expected by the frontend
      // Wrap in Organizations object for consistency
      res.json({ Organizations: orgs });
      
    } catch (apiError) {
      console.error("[API/ORGS] Error fetching organizations:", apiError.message);
      
      // Handle 401 - retry with refreshed PassKey
      if (apiError.response?.status === 401) {
        
        // Attempt to refresh the PassKey
        const newPassKey = await refreshPassKey(sessionId);
        
        if (newPassKey) {
          // Refresh successful - retry the API call
          try {
            const orgs = await fetchOrganizations(newPassKey);
            return res.json({ Organizations: orgs });
          } catch (retryError) {
            // Retry also failed - authentication truly expired
            console.error("[API/ORGS] Retry failed:", retryError.message);
          }
        }
        
        // PassKey refresh failed or retry failed
        return res.status(401).json({ error: "authentication expired", requiresReauth: true });
      }
      
      // Other API errors (not authentication related)
      res.status(500).json({ error: "failed to fetch organizations", details: apiError.message });
    }
  } catch (error) {
    // Unexpected errors (not from BSA API)
    console.error("[API/ORGS] Unexpected error:", error);
    console.error("[API/ORGS] Error stack:", error.stack);
    res.status(500).json({ error: "internal server error" });
  }
});

// Select organization endpoint with user sync
app.post("/api/orgs/select", async (req, res) => {
  console.log("[API/ORGS/SELECT] =================================");
  console.log("[API/ORGS/SELECT] Endpoint called with body:", JSON.stringify(req.body));
  console.log("[API/ORGS/SELECT] Headers:", req.headers);

  try {
    const { session_id: sessionId, org_id: orgId } = req.body;

    // Validate required fields
    if (!sessionId) {
      console.error("[API/ORGS/SELECT] ERROR: Missing session_id");
      return res.status(400).json({ error: "missing session_id" });
    }

    if (!orgId) {
      console.error("[API/ORGS/SELECT] ERROR: Missing org_id");
      return res.status(400).json({ error: "missing org_id" });
    }

    console.log(`[API/ORGS/SELECT] Starting org selection process`);
    console.log(`[API/ORGS/SELECT] Session ID: ${sessionId}`);
    console.log(`[API/ORGS/SELECT] Org ID: ${orgId}`);

    // Get valid PassKey
    console.log("[API/ORGS/SELECT] Getting PassKey for session...");
    const passKey = await getValidPassKey(sessionId);

    if (!passKey) {
      console.error("[API/ORGS/SELECT] ERROR: No PassKey found for session");
      return res.status(401).json({ error: "not authenticated", requiresReauth: true });
    }
    console.log("[API/ORGS/SELECT] PassKey retrieved successfully");

    // Get the user ID from the session
    console.log("[API/ORGS/SELECT] Fetching user ID from database...");
    const { data: tokenData, error: tokenError } = await supabase
      .from("bsa_tokens")
      .select("user_id")
      .eq("session_id", sessionId)
      .single();

    if (tokenError) {
      console.error("[API/ORGS/SELECT] ERROR fetching user ID from DB:", JSON.stringify(tokenError));
    } else {
      console.log("[API/ORGS/SELECT] Token data from DB:", JSON.stringify(tokenData));
    }

    const currentUserId = tokenData?.user_id;
    console.log("[API/ORGS/SELECT] Current user ID extracted:", currentUserId || "NOT FOUND - will sync without marking current user");

    // Import and use the user sync service
    const { getUserSyncService } = require('./services/sync/userSyncService');
    const userSyncService = getUserSyncService();

    // Sync organization users
    const syncResult = await userSyncService.syncOrganizationUsers(
      passKey,
      orgId,
      sessionId,
      currentUserId
    );

    console.log("[API/ORGS/SELECT] User sync result:", syncResult);

    // Get the current user details
    let currentUser = null;
    if (currentUserId) {
      currentUser = await userSyncService.getCurrentUser(sessionId, orgId);
    }

    // Return success response
    res.json({
      success: true,
      orgId,
      userSync: syncResult,
      currentUser: currentUser ? {
        id: currentUser.user_id,
        name: currentUser.full_name,
        email: currentUser.email,
        title: currentUser.job_title
      } : null
    });

  } catch (error) {
    console.error("[API/ORGS/SELECT] Error:", error);
    res.status(500).json({ error: "Failed to select organization" });
  }
});

// Import date parser for natural language date queries
const { parseDateQuery, extractDateFromQuery } = require('./utils/dateParser');



// Rate limiting (in-memory)
const rateLimitWindows = new Map();

function checkRateLimit(sessionId) {
  const now = Date.now();
  const limit = 10; // 10 requests
  const window = 60000; // per minute
  
  // Periodic cleanup to prevent memory leaks (1% chance)
  if (Math.random() < 0.01) {
    for (const [key, timestamps] of rateLimitWindows.entries()) {
      const valid = timestamps.filter(t => now - t < window);
      if (valid.length === 0) {
        rateLimitWindows.delete(key);
      } else {
        rateLimitWindows.set(key, valid);
      }
    }
  }
  
  const timestamps = rateLimitWindows.get(sessionId) || [];
  const recentRequests = timestamps.filter(t => now - t < window);
  
  if (recentRequests.length >= limit) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimitWindows.set(sessionId, recentRequests);
  return true;
}

// Note: Old /api/assistant/query endpoint removed - use /api/agent/execute instead

// Note: Old /api/workflow/query endpoint removed - use /api/agent/execute instead
// Note: Old /api/orchestrator/query endpoint removed - use /api/agent/execute instead

// Mount all routes using centralized route setup
const { setupRoutes } = require('./routes');
setupRoutes(app);

// Health check endpoint
app.get("/health", (_, res) => {
  res.json({ 
    status: "healthy",                        // Server status
    timestamp: new Date().toISOString()        // Current server time
  });
});

// Global error handling middleware
app.use((err, _, res, __) => {
  // Log the full error for debugging
  console.error("Unhandled error:", err);
  
  // Send generic error response to client
  // Don't expose internal error details for security
  res.status(500).json({ error: "internal server error" });
});

// Reset conversation endpoint - clears checkpoint data
app.post("/api/reset-conversation", async (req, res) => {
  const requestId = crypto.randomBytes(4).toString("hex");
  console.log(`[RESET:${requestId}] Starting conversation reset`);
  
  try {
    const { session_id, org_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ error: "session_id required" });
    }

    if (!org_id) {
      return res.status(400).json({ error: "org_id required" });
    }

    // Validate session exists (security check)
    const { data: tokenData, error: tokenError } = await supabase
      .from("bsa_tokens")
      .select("user_id")
      .eq("session_id", session_id)
      .single();

    if (tokenError || !tokenData) {
      console.error(`[RESET:${requestId}] Invalid session:`, tokenError);
      return res.status(401).json({ error: "Invalid session" });
    }

    const userId = tokenData.user_id;
    // Use org_id from request body - this matches how thread_id is constructed in the coordinator
    const threadId = `${session_id}:${org_id}`;
    
    console.log(`[RESET:${requestId}] Clearing checkpoints for thread: ${threadId}`);
    
    // Get the shared connection pool
    const pool = getPgPool();
    if (!pool) {
      console.error(`[RESET:${requestId}] PostgreSQL connection not configured`);
      return res.status(500).json({ error: "Database connection not configured" });
    }
    
    // Use a transaction for atomic deletion
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Clear all checkpoint-related data for this thread
      // Track deletion counts for each table
      const writesResult = await client.query('DELETE FROM checkpoint_writes WHERE thread_id = $1', [threadId]);
      const blobsResult = await client.query('DELETE FROM checkpoint_blobs WHERE thread_id = $1', [threadId]);
      const checkpointsResult = await client.query('DELETE FROM checkpoints WHERE thread_id = $1', [threadId]);
      
      // Also clear checkpoint_migrations if any exist for this thread
      // Note: checkpoint_migrations might not have thread_id column, so we check first
      let migrationsDeleted = 0;
      try {
        const migrationCheckResult = await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'checkpoint_migrations' AND column_name = 'thread_id'"
        );
        if (migrationCheckResult.rows.length > 0) {
          const migrationsResult = await client.query('DELETE FROM checkpoint_migrations WHERE thread_id = $1', [threadId]);
          migrationsDeleted = migrationsResult.rowCount;
        }
      } catch (migrationErr) {
        console.log(`[RESET:${requestId}] Note: checkpoint_migrations table may not have thread_id column`);
      }
      
      // Commit the transaction
      await client.query('COMMIT');
      
      const deletionCounts = {
        checkpoint_writes: writesResult.rowCount,
        checkpoint_blobs: blobsResult.rowCount,
        checkpoints: checkpointsResult.rowCount,
        checkpoint_migrations: migrationsDeleted
      };

      const totalDeleted = deletionCounts.checkpoint_writes + deletionCounts.checkpoint_blobs + deletionCounts.checkpoints;

      if (totalDeleted === 0) {
        console.log(`[RESET:${requestId}] Warning: No checkpoints found for thread ${threadId} - conversation may already be empty`);
      } else {
        console.log(`[RESET:${requestId}] Successfully cleared checkpoints:`, deletionCounts);
      }

      res.json({
        success: true,
        message: "Conversation reset successfully",
        thread_id: threadId,
        deleted: deletionCounts,
        was_empty: totalDeleted === 0
      });
      
    } catch (err) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      throw err;
    } finally {
      // Release the client back to the pool
      client.release();
    }
    
  } catch (error) {
    console.error(`[RESET:${requestId}] Error:`, error);
    res.status(500).json({ error: "Failed to reset conversation" });
  }
});

// =========================
// Interrupt Polling Endpoints (for production/Vercel)
// =========================

const { getInterruptPollingService } = require('./core/websocket/pollingFallback');
const pollingService = getInterruptPollingService();

// Check for pending interrupts
app.get('/api/interrupts/poll', async (req, res) => {
  const sessionId = req.query.session_id;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  const interrupt = pollingService.checkPending(sessionId);
  
  if (interrupt) {
    res.json({
      hasInterrupt: true,
      interrupt: interrupt
    });
  } else {
    res.json({
      hasInterrupt: false
    });
  }
});

// Acknowledge interrupt receipt
app.post('/api/interrupts/acknowledge', async (req, res) => {
  const { session_id } = req.body;
  
  if (!session_id) {
    return res.status(400).json({ error: 'Session ID required' });
  }
  
  pollingService.acknowledgeInterrupt(session_id);
  
  res.json({
    success: true,
    message: 'Interrupt acknowledged'
  });
});

// Submit approval response
app.post('/api/interrupts/approve', async (req, res) => {
  const { session_id, approval_data } = req.body;
  
  if (!session_id || !approval_data) {
    return res.status(400).json({ error: 'Session ID and approval data required' });
  }
  
  const result = await pollingService.handleApprovalResponse(session_id, approval_data);
  
  res.json(result);
});

// Get polling service stats (for debugging)
app.get('/api/interrupts/stats', async (req, res) => {
  const stats = pollingService.getStats();
  res.json(stats);
});

// Module exports for Vercel
module.exports = app;

// Local development server with WebSocket support
if (require.main === module) {
  // Use PORT from environment or default to 3000
  const PORT = process.env.PORT || 3000;
  
  // Create HTTP server for WebSocket attachment
  const server = require('http').createServer(app);
  
  // Initialize WebSocket server (only in development)
  if (process.env.NODE_ENV !== 'production') {
    const { getInterruptWebSocketServer } = require('./core/websocket/interrupts');
    const wsServer = getInterruptWebSocketServer();
    wsServer.initialize(server);
    console.log('WebSocket server initialized for development');
  }
  
  // Start the server
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`OAuth start: http://localhost:${PORT}/auth/start?session_id=test`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
    }
  });
}