// API Routes for Multi-Agent LangGraph Orchestrator
// Handles agent execution and approval flows

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Import orchestrator and state management
const { buildGraph } = require('../graph/orchestrator');
const { getStore } = require('../graph/state');

// Constants
const RATE_LIMIT = 10; // requests
const RATE_WINDOW = 60000; // per minute
const MAX_QUERY_LENGTH = 2000;
const DEFAULT_TIMEZONE = 'UTC';

// Rate limiting storage
const rateLimitWindows = new Map();

/**
 * Check rate limit for a session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} - True if within limit, false if exceeded
 */
function checkRateLimit(sessionId) {
  const now = Date.now();
  
  // Periodic cleanup (1% chance)
  if (Math.random() < 0.01) {
    for (const [key, timestamps] of rateLimitWindows.entries()) {
      const valid = timestamps.filter(t => now - t < RATE_WINDOW);
      if (valid.length === 0) {
        rateLimitWindows.delete(key);
      } else {
        rateLimitWindows.set(key, valid);
      }
    }
  }
  
  const timestamps = rateLimitWindows.get(sessionId) || [];
  const recentRequests = timestamps.filter(t => now - t < RATE_WINDOW);
  
  if (recentRequests.length >= RATE_LIMIT) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimitWindows.set(sessionId, recentRequests);
  return true;
}

/**
 * Get valid PassKey with auto-refresh
 * @param {string} sessionId - Session identifier
 * @returns {Promise<string|null>} - PassKey or null if not authenticated
 */
async function getValidPassKey(sessionId) {
  try {
    const { data: rows, error } = await supabase
      .from('bsa_tokens')
      .select('passkey, expires_at')
      .eq('session_id', sessionId)
      .limit(1);
    
    if (error || !rows || !rows[0]) {
      console.error('[AGENT:GET_PASSKEY] No token found for session:', sessionId);
      return null;
    }
    
    const token = rows[0];
    const passKey = token.passkey;
    
    if (!passKey) {
      console.error('[AGENT:GET_PASSKEY] Token exists but passkey field is empty');
      return null;
    }
    
    // Check expiration and refresh if needed
    if (token.expires_at) {
      const expiry = new Date(token.expires_at);
      const now = new Date();
      const timeLeft = expiry - now;
      
      // Refresh if less than 5 minutes remaining
      if (timeLeft < 5 * 60 * 1000) {
        console.log('[AGENT:GET_PASSKEY] PassKey expiring soon, would refresh but keeping simple for now');
        // In production, would call refreshPassKey here
      }
    }
    
    return passKey;
  } catch (error) {
    console.error('[AGENT:GET_PASSKEY] Error:', error);
    return null;
  }
}

/**
 * Get user ID from database
 * @param {string} sessionId - Session identifier
 * @returns {Promise<string|null>} - User ID or null
 */
async function getUserId(sessionId) {
  try {
    const { data: rows, error } = await supabase
      .from('bsa_tokens')
      .select('user_id')
      .eq('session_id', sessionId)
      .limit(1);
    
    if (error || !rows || !rows[0]) {
      console.error('[AGENT:GET_USER] No user found for session:', sessionId);
      return null;
    }
    
    return rows[0].user_id || null;
  } catch (error) {
    console.error('[AGENT:GET_USER] Error:', error);
    return null;
  }
}

/**
 * Build configuration for graph execution
 * @param {Object} params - Configuration parameters
 * @returns {Promise<Object>} - RunnableConfig for LangGraph
 */
async function buildConfig(params) {
  const {
    session_id,
    org_id,
    thread_id,
    user_id,
    time_zone,
    safe_mode,
    passKey
  } = params;
  
  // Get the UnifiedStore instance for this org/user
  const store = await getStore();
  
  return {
    configurable: {
      thread_id: thread_id || `${session_id}:${org_id}`,
      userId: user_id,
      orgId: org_id,
      user_tz: time_zone || DEFAULT_TIMEZONE,
      safe_mode: safe_mode !== false, // Default true
      passKey, // Passed via closure, never in state
      BSA_BASE: process.env.BSA_BASE,
      store // Add UnifiedStore to config for memory nodes
    }
  };
}

/**
 * Format response for API consumers
 * @param {Object} state - Graph state after execution
 * @param {string} status - Execution status
 * @returns {Object} - Formatted response
 */
function formatResponse(state, status) {
  // Extract last message
  const messages = state.messages || [];
  const lastMessage = messages[messages.length - 1];
  const responseText = lastMessage?.content || '';
  
  // Base response
  const response = {
    status,
    timestamp: new Date().toISOString()
  };
  
  // Add status-specific fields
  if (status === 'PENDING_APPROVAL') {
    response.thread_id = state.thread_id;
    
    // Get previews from approvalPayload or state.previews
    if (state.approvalPayload && state.approvalPayload.previews) {
      response.previews = state.approvalPayload.previews;
      response.message = state.approvalPayload.message || 'Please review and approve the following actions:';
    } else {
      response.previews = state.previews || [];
      response.message = responseText || 'Please review and approve the following actions:';
    }
    
    response.requiresApproval = true;
    
    // Include UI elements if present
    if (state.ui) {
      response.ui = state.ui;
    }
  } else if (status === 'COMPLETED') {
    response.response = responseText;
    
    // Include UI elements if present
    if (state.ui) {
      response.ui = state.ui;
    }
    
    // Include follow-up questions if present
    if (state.followups) {
      response.followups = state.followups;
    }
    
    // Include any artifacts created
    if (state.artifacts) {
      response.artifacts = state.artifacts;
    }
  } else if (status === 'ERROR') {
    response.error = state.error || 'An error occurred during execution';
  }
  
  return response;
}

/**
 * POST /api/agent/execute
 * Main entry point for agent queries
 */
router.post('/execute', async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[AGENT:EXECUTE:${requestId}] Starting request`);
  
  try {
    const { 
      query, 
      session_id, 
      org_id, 
      time_zone,
      thread_id,
      safe_mode 
    } = req.body;
    
    // Step 1: Input validation
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ 
        error: 'Query is required and must be a string' 
      });
    }
    
    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ 
        error: `Query must be less than ${MAX_QUERY_LENGTH} characters` 
      });
    }
    
    if (!session_id) {
      return res.status(400).json({ 
        error: 'session_id is required' 
      });
    }
    
    if (!org_id) {
      return res.status(400).json({ 
        error: 'org_id is required' 
      });
    }
    
    // Step 2: Rate limiting
    if (!checkRateLimit(session_id)) {
      console.log(`[AGENT:EXECUTE:${requestId}] Rate limit exceeded for session:`, session_id);
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        retryAfter: 60 
      });
    }
    
    // Step 3: Authentication
    console.log(`[AGENT:EXECUTE:${requestId}] Getting PassKey for session:`, session_id);
    const passKey = await getValidPassKey(session_id);
    
    if (!passKey) {
      console.error(`[AGENT:EXECUTE:${requestId}] No valid PassKey found`);
      return res.status(401).json({ 
        error: 'Not authenticated', 
        requiresReauth: true 
      });
    }
    
    // Get user ID
    const user_id = await getUserId(session_id);
    console.log(`[AGENT:EXECUTE:${requestId}] User ID:`, user_id || 'not found');
    
    // Step 4: Build configuration
    const config = await buildConfig({
      session_id,
      org_id,
      thread_id,
      user_id,
      time_zone,
      safe_mode,
      passKey
    });
    
    console.log(`[AGENT:EXECUTE:${requestId}] Config built with thread_id:`, config.configurable.thread_id);
    
    // Step 5: Get and invoke graph
    console.log(`[AGENT:EXECUTE:${requestId}] Building graph...`);
    const graph = await buildGraph();
    
    console.log(`[AGENT:EXECUTE:${requestId}] Invoking graph with query:`, query.substring(0, 100));
    
    let state;
    try {
      state = await graph.invoke(
        { 
          messages: [{ 
            role: 'human', 
            content: query 
          }] 
        },
        config
      );
    } catch (error) {
      // Check if this is an interrupt (not an error)
      if (error && (error.resumable === true || error.when === "during")) {
        console.log(`[AGENT:EXECUTE:${requestId}] Graph interrupted for approval`);
        
        // Get the current state from the checkpoint
        const checkpointer = graph.checkpointer;
        if (checkpointer) {
          const checkpoint = await checkpointer.get(config.configurable.thread_id);
          state = checkpoint?.state;
        }
        
        // If we can't get state from checkpoint, construct minimal state
        if (!state) {
          state = {
            interruptMarker: 'PENDING_APPROVAL',
            approvalPayload: error.value || error,
            previews: error.value?.previews || []
          };
        }
        
        // Ensure we have the interrupt marker set
        state.interruptMarker = 'PENDING_APPROVAL';
        
      } else {
        // Real error, re-throw it
        throw error;
      }
    }
    
    // Step 6: Check for interruption
    if (state.interruptMarker === 'PENDING_APPROVAL') {
      console.log(`[AGENT:EXECUTE:${requestId}] Approval required, returning previews`);
      
      // Store thread_id in response for resumption
      state.thread_id = config.configurable.thread_id;
      
      const response = formatResponse(state, 'PENDING_APPROVAL');
      return res.status(202).json(response);
    }
    
    // Step 7: Return completed response
    console.log(`[AGENT:EXECUTE:${requestId}] Execution completed successfully`);
    const response = formatResponse(state, 'COMPLETED');
    
    return res.json(response);
    
  } catch (error) {
    console.error(`[AGENT:EXECUTE:${requestId}] Error:`, error);
    console.error(`[AGENT:EXECUTE:${requestId}] Stack:`, error.stack);
    
    // Determine error type and status code
    let statusCode = 500;
    let errorMessage = 'Failed to execute agent query';
    
    if (error.message?.includes('authentication')) {
      statusCode = 401;
      errorMessage = 'Authentication failed';
    } else if (error.message?.includes('timeout')) {
      statusCode = 504;
      errorMessage = 'Request timeout - query took too long';
    } else if (error.message?.includes('rate limit')) {
      statusCode = 429;
      errorMessage = 'API rate limit exceeded';
    }
    
    return res.status(statusCode).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      requestId
    });
  }
});

/**
 * POST /api/agent/approve
 * Resume interrupted graph with user approvals
 */
router.post('/approve', async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[AGENT:APPROVE:${requestId}] Starting approval request`);
  
  try {
    const { 
      session_id, 
      org_id, 
      thread_id,
      approvals,
      time_zone
    } = req.body;
    
    // Step 1: Input validation
    if (!session_id) {
      return res.status(400).json({ 
        error: 'session_id is required' 
      });
    }
    
    if (!org_id) {
      return res.status(400).json({ 
        error: 'org_id is required' 
      });
    }
    
    if (!thread_id) {
      return res.status(400).json({ 
        error: 'thread_id is required to resume execution' 
      });
    }
    
    if (!approvals || typeof approvals !== 'object') {
      return res.status(400).json({ 
        error: 'approvals must be an object with action IDs as keys' 
      });
    }
    
    console.log(`[AGENT:APPROVE:${requestId}] Approvals received:`, Object.keys(approvals));
    
    // Step 2: Authentication
    const passKey = await getValidPassKey(session_id);
    
    if (!passKey) {
      console.error(`[AGENT:APPROVE:${requestId}] No valid PassKey found`);
      return res.status(401).json({ 
        error: 'Not authenticated', 
        requiresReauth: true 
      });
    }
    
    // Get user ID
    const user_id = await getUserId(session_id);
    
    // Step 3: Build config (must match original)
    const config = await buildConfig({
      session_id,
      org_id,
      thread_id, // Use the provided thread_id
      user_id,
      time_zone,
      safe_mode: true, // Approvals only happen in safe mode
      passKey
    });
    
    console.log(`[AGENT:APPROVE:${requestId}] Resuming thread:`, thread_id);
    
    // Step 4: Resume graph execution
    const graph = await buildGraph();
    
    // Import Command for proper resume
    const { Command } = await import("@langchain/langgraph");
    
    console.log(`[AGENT:APPROVE:${requestId}] Creating resume command with approvals`);
    
    // Create a Command to resume with the approvals
    const resumeCommand = new Command({
      resume: approvals,
      update: {
        interruptMarker: null,  // Clear the interrupt marker
        approvalPayload: null   // Clear the approval payload
      }
    });
    
    console.log(`[AGENT:APPROVE:${requestId}] Invoking graph with resume command`);
    const state = await graph.invoke(
      resumeCommand,
      config
    );
    
    // Step 5: Check for another interruption (nested approvals)
    if (state.interruptMarker === 'PENDING_APPROVAL') {
      console.log(`[AGENT:APPROVE:${requestId}] Another approval required`);
      
      state.thread_id = thread_id;
      const response = formatResponse(state, 'PENDING_APPROVAL');
      return res.status(202).json(response);
    }
    
    // Step 6: Return final result
    console.log(`[AGENT:APPROVE:${requestId}] Execution completed after approval`);
    const response = formatResponse(state, 'COMPLETED');
    
    return res.json(response);
    
  } catch (error) {
    console.error(`[AGENT:APPROVE:${requestId}] Error:`, error);
    console.error(`[AGENT:APPROVE:${requestId}] Stack:`, error.stack);
    
    return res.status(500).json({ 
      error: 'Failed to process approval',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      requestId
    });
  }
});

/**
 * GET /api/agent/status
 * Check the status of a thread
 */
router.get('/status', async (req, res) => {
  try {
    const { session_id, thread_id } = req.query;
    
    if (!session_id || !thread_id) {
      return res.status(400).json({ 
        error: 'session_id and thread_id are required' 
      });
    }
    
    // For now, return a simple status
    // In future, could check checkpoint state
    return res.json({
      status: 'active',
      thread_id,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[AGENT:STATUS] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to get status' 
    });
  }
});

module.exports = router;