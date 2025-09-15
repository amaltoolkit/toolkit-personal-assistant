// API Routes for Multi-Agent LangGraph Orchestrator
// Handles agent execution and approval flows

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const bsaConfig = require('../config/bsa');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Import orchestrator and state management
const { buildGraph } = require('../graph/orchestrator');
const { getStore, getCheckpointer } = require('../graph/state');

// Import V2 Coordinator (feature flag controlled)
const { getCoordinator } = require('../coordinator');
const USE_V2_ARCHITECTURE = process.env.USE_V2_ARCHITECTURE === 'true';

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
      passKey, // Passed via closure, never in state
      BSA_BASE: bsaConfig.getBaseUrl(),
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
      thread_id
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
      passKey
    });
    
    console.log(`[AGENT:EXECUTE:${requestId}] Config built with thread_id:`, config.configurable.thread_id);
    
    // Step 5: Execute based on architecture version
    let state;
    
    if (USE_V2_ARCHITECTURE) {
      // V2 Architecture: Use Coordinator
      console.log(`[AGENT:EXECUTE:${requestId}] Using V2 Coordinator architecture`);

      try {
        // Get checkpointer for state persistence
        const checkpointer = await getCheckpointer();
        const coordinator = getCoordinator(checkpointer);
        const result = await coordinator.processQuery(query, {
          org_id,
          user_id,
          session_id,
          thread_id: config.configurable.thread_id,
          checkpoint_id: config.configurable.checkpoint_id,
          timezone: time_zone || DEFAULT_TIMEZONE
        });

        // DEBUGGING: Log coordinator response
        console.log(`[AGENT:DEBUG:${requestId}] Coordinator returned:`, {
          hasSuccess: result?.success,
          hasError: result?.error,
          hasInterruptMarker: result?.interruptMarker,
          hasApprovalRequest: !!result?.approvalRequest,
          resultKeys: result ? Object.keys(result) : null,
          responseLength: result?.response?.length,
          resultKeys: Object.keys(result || {}),
          hasEntities: !!result?.entities,
          hasDomains: !!result?.domains
        });

        // Convert V2 response to V1 state format for compatibility
        state = {
          messages: [
            { role: 'human', content: query },
            { role: 'assistant', content: result.response }
          ],
          entities: result.entities,
          domains: result.domains
        };

        // Handle V2 errors
        if (!result.success) {
          throw new Error(result.error || 'V2 execution failed');
        }
      } catch (error) {
        // DEBUGGING: Log caught error
        console.log(`[AGENT:DEBUG:${requestId}] Coordinator threw error:`, {
          errorName: error.name,
          errorMessage: error.message,
          isGraphInterrupt: error.name === 'GraphInterrupt',
          hasInterrupts: !!error.interrupts,
          interruptCount: error.interrupts?.length,
          hasValue: !!error.value,
          errorKeys: Object.keys(error)
        });

        // Handle V2 interrupts (for approvals and contact disambiguation)
        if (error && error.name === 'GraphInterrupt') {
          // Extract interrupt value from the nested structure
          // LangGraph interrupts have the structure: error.interrupts[0].value.value
          const interruptData = error.interrupts?.[0]?.value?.value ||
                               error.interrupts?.[0]?.value ||
                               error.value || {};

          console.log(`[AGENT:EXECUTE:${requestId}] GraphInterrupt caught:`, {
            type: interruptData.type,
            hasPreview: !!interruptData.preview,
            domain: interruptData.domain
          });

          // Structure the interrupt data properly
          state = {
            interruptMarker: 'PENDING_APPROVAL',
            thread_id: config.configurable.thread_id
          };

          // Handle different interrupt types
          if (interruptData.type === 'contact_disambiguation') {
            state.interrupt = {
              type: 'contact_disambiguation',
              candidates: interruptData.candidates,
              message: interruptData.message,
              thread_id: config.configurable.thread_id
            };
          } else if (interruptData.type === 'approval') {
            state.approvalPayload = interruptData;
            state.previews = [interruptData.preview]; // Wrap single preview in array
            state.approvalContext = interruptData; // Store full context
          } else {
            // Generic interrupt handling
            state.approvalPayload = interruptData;
            state.previews = interruptData.previews || [];
            state.approvalContext = interruptData;
          }
        } else {
          throw error;
        }
      }
      
    } else {
      // V1 Architecture: Use Orchestrator
      console.log(`[AGENT:EXECUTE:${requestId}] Using V1 Orchestrator architecture`);
      console.log(`[AGENT:EXECUTE:${requestId}] Building graph...`);
      const graph = await buildGraph();
      
      console.log(`[AGENT:EXECUTE:${requestId}] Invoking graph with query:`, query.substring(0, 100));
      
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
        // GraphInterrupt errors have different properties depending on how they're thrown
        if (error && (error.resumable === true || error.when === "during" || error.name === 'GraphInterrupt')) {
          console.log(`[AGENT:EXECUTE:${requestId}] Graph interrupted for approval:`, {
            errorName: error.name,
            hasValue: !!error.value,
            resumable: error.resumable,
            when: error.when
          });
        
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
            previews: error.value?.previews || [],
            approvalContext: error.value || {}
          };
        }

        // Ensure we have the interrupt marker set and approval context
        state.interruptMarker = 'PENDING_APPROVAL';
        // Make sure we have the approval context from the interrupt
        if (error.value && !state.approvalContext) {
          state.approvalContext = error.value;
        }
        
        } else {
          // Real error, re-throw it
          throw error;
        }
      }
    }
    
    // Step 6: Check for interruption
    if (state.interruptMarker === 'PENDING_APPROVAL') {
      console.log(`[AGENT:EXECUTE:${requestId}] Approval required, returning previews`);
      
      // Store thread_id in response for resumption
      state.thread_id = config.configurable.thread_id;
      
      // Send interrupt via WebSocket or polling service
      try {
        // Extract preview from approvalContext if available
        const preview = state.approvalContext?.preview || state.preview;
        const message = state.approvalContext?.message || 'Please review this action:';

        // Avoid double-wrapping: use state.previews if it already contains the preview
        let previews = state.previews || [];

        // Only create a new array if we have a preview that's not already in state.previews
        if (preview && (!previews.length || previews[0] !== preview)) {
          previews = [preview];
        }

        const interruptData = {
          type: 'approval_required',
          threadId: config.configurable.thread_id,
          previews: previews,
          message: message,
          approvalPayload: state.approvalPayload || state.approvalContext,
          requestId
        };
        
        // Check if we're in development (WebSocket) or production (polling)
        if (process.env.NODE_ENV !== 'production') {
          // Try WebSocket first
          const { getInterruptWebSocketServer } = require('../websocket/interrupts');
          const wsServer = getInterruptWebSocketServer();
          await wsServer.sendInterrupt(session_id, interruptData);
        } else {
          // Use polling service for production
          const { getInterruptPollingService } = require('../websocket/pollingFallback');
          const pollingService = getInterruptPollingService();
          pollingService.storeInterrupt(session_id, interruptData);
        }
        
        console.log(`[AGENT:EXECUTE:${requestId}] Interrupt sent to client`);
      } catch (error) {
        console.error(`[AGENT:EXECUTE:${requestId}] Failed to send interrupt:`, error);
        // Continue anyway - client can still poll the response
      }
      
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
      time_zone,
      // V2 Architecture fields
      decision,
      interrupt_response,
      contact_id
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

    // Check if this is V2 architecture (has decision or interrupt_response)
    const isV2Request = decision || interrupt_response || contact_id;

    // Validate based on architecture version
    if (!isV2Request && (!approvals || typeof approvals !== 'object')) {
      return res.status(400).json({
        error: 'approvals must be an object with action IDs as keys'
      });
    }

    if (isV2Request) {
      console.log(`[AGENT:APPROVE:${requestId}] V2 Architecture request:`, {
        decision,
        interrupt_type: interrupt_response?.type,
        contact_id
      });
    } else {
      console.log(`[AGENT:APPROVE:${requestId}] V1 Approvals received:`, Object.keys(approvals));
    }
    
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
      passKey
    });
    
    console.log(`[AGENT:APPROVE:${requestId}] Resuming thread:`, thread_id);

    // Step 4: Resume graph execution based on architecture
    if (USE_V2_ARCHITECTURE && isV2Request) {
      // V2 Architecture: Resume coordinator with approval/contact selection
      console.log(`[AGENT:APPROVE:${requestId}] Using V2 Coordinator for resume`);

      try {
        // Get checkpointer and coordinator
        const checkpointer = await getCheckpointer();
        const coordinator = getCoordinator(checkpointer);

        // Load the current checkpoint to get state with error recovery
        // IMPORTANT: Use getTuple() with proper config structure (documented in LangGraph)
        let checkpoint;
        try {
          console.log(`[AGENT:APPROVE:${requestId}] 🔍 Attempting to retrieve checkpoint with getTuple():`, {
            thread_id: thread_id,
            checkpoint_ns: "",
            method: "checkpointer.getTuple()",
            checkpointerType: checkpointer.constructor.name
          });

          checkpoint = await checkpointer.getTuple({
            configurable: {
              thread_id: thread_id,
              checkpoint_ns: "" // Default namespace
            }
          });

          console.log(`[AGENT:APPROVE:${requestId}] ✅ Checkpoint retrieved successfully:`, {
            hasCheckpoint: !!checkpoint,
            hasConfig: !!checkpoint?.config,
            hasState: !!checkpoint?.checkpoint?.channel_values,
            configKeys: checkpoint?.config ? Object.keys(checkpoint.config) : null,
            stateKeys: checkpoint?.checkpoint?.channel_values ? Object.keys(checkpoint.checkpoint.channel_values).slice(0, 10) : null,
            checkpointId: checkpoint?.checkpoint?.id,
            checkpointTs: checkpoint?.checkpoint?.ts,
            parentConfig: checkpoint?.parentConfig,
            metadata: checkpoint?.metadata
          });

          // Log pendingApproval data if present
          if (checkpoint?.checkpoint?.channel_values?.pendingApproval) {
            console.log(`[AGENT:APPROVE:${requestId}] Found pendingApproval in checkpoint:`, {
              domains: checkpoint.checkpoint.channel_values.pendingApproval.domains,
              requestCount: checkpoint.checkpoint.channel_values.pendingApproval.requests?.length
            });
          }
        } catch (checkpointError) {
          console.error(`[AGENT:APPROVE:${requestId}] ❌ Failed to load checkpoint:`, {
            error: checkpointError.message,
            stack: checkpointError.stack?.split('\n').slice(0, 3).join(' | ')
          });
          // Try to recover by creating a minimal state
          checkpoint = null;
        }

        if (!checkpoint) {
          // Graceful degradation - inform user and suggest retry
          console.warn(`[AGENT:APPROVE:${requestId}] No checkpoint found for thread, attempting recovery`);
          return res.status(422).json({
            error: 'Session state not found',
            message: 'The conversation state could not be recovered. Please try starting a new conversation or retry your last action.',
            requiresRestart: true,
            thread_id
          });
        }

        // Build resume state based on interrupt type
        let resumeData = {};

        // Handle contact selection
        if (interrupt_response?.type === 'contact_selected' || contact_id) {
          resumeData = {
            resolved_contacts: [{
              id: contact_id || interrupt_response?.selected_contact_id,
              name: interrupt_response?.selected_contact_name
            }],
            contact_selected: true
          };
          console.log(`[AGENT:APPROVE:${requestId}] Resuming with selected contact:`, resumeData.resolved_contacts[0]);
        }
        // Handle approval/rejection
        else if (decision) {
          resumeData = {
            approval_decision: decision,
            approved: decision === 'approve',
            rejected: decision === 'reject'
          };
          console.log(`[AGENT:APPROVE:${requestId}] Resuming with decision:`, decision);
        }

        // Resume the coordinator with the approval decision using Command pattern
        // This is the documented way to resume from interrupts in LangGraph
        console.log(`[AGENT:APPROVE:${requestId}] 🚀 Starting resume with Command pattern`);

        // Get the checkpoint state
        const checkpointState = checkpoint?.checkpoint?.channel_values || checkpoint?.state || {};

        console.log(`[AGENT:APPROVE:${requestId}] Checkpoint state analysis:`, {
          hasChannelValues: !!checkpoint?.checkpoint?.channel_values,
          channelValueKeys: checkpoint?.checkpoint?.channel_values ? Object.keys(checkpoint.checkpoint.channel_values).slice(0, 10) : null,
          hasPendingApproval: !!checkpointState.pendingApproval,
          hasMessages: !!checkpointState.messages,
          messageCount: checkpointState.messages?.length
        });

        // Build the resume data
        const resumePayload = {
          ...resumeData,  // Approval decision or contact selection
          // Ensure we have the required context
          org_id,
          session_id,
          thread_id,
          user_id,
          timezone: time_zone || DEFAULT_TIMEZONE
        };

        console.log(`[AGENT:APPROVE:${requestId}] Creating Command with resume payload:`, {
          decision: resumePayload.approval_decision || resumePayload.contact_selected,
          hasApprovalDecision: !!resumePayload.approval_decision,
          hasContactSelection: !!resumePayload.contact_selected,
          payloadKeys: Object.keys(resumePayload)
        });

        // Dynamic import Command to avoid initialization issues
        console.log(`[AGENT:APPROVE:${requestId}] 📦 Importing Command from @langchain/langgraph...`);
        const startTime = Date.now();
        const { Command } = await import('@langchain/langgraph');
        console.log(`[AGENT:APPROVE:${requestId}] ✅ Command imported successfully in ${Date.now() - startTime}ms`);

        // Merge the approval decision into the resume command
        const resumeCommand = new Command({
          resume: resumePayload
        });

        const resumeConfig = checkpoint.config || config;
        console.log(`[AGENT:APPROVE:${requestId}] Using config for resume:`, {
          hasCheckpointConfig: !!checkpoint.config,
          configThreadId: resumeConfig?.configurable?.thread_id,
          configCheckpointId: resumeConfig?.configurable?.checkpoint_id
        });

        // Resume the graph with the Command
        console.log(`[AGENT:APPROVE:${requestId}] 🚀 Invoking coordinator.graph with Command...`);
        console.log(`[AGENT:APPROVE:${requestId}] Command details:`, {
          commandType: resumeCommand.constructor.name,
          hasResume: !!resumeCommand.resume,
          resumeKeys: Object.keys(resumeCommand.resume || {})
        });
        const invokeStart = Date.now();
        const result = await coordinator.graph.invoke(
          resumeCommand,
          resumeConfig  // Use checkpoint's config if available
        );
        console.log(`[AGENT:APPROVE:${requestId}] ⏱️ Graph invoke completed in ${Date.now() - invokeStart}ms`);

        console.log(`[AGENT:APPROVE:${requestId}] ✅ Resume completed successfully:`, {
          hasResult: !!result,
          resultKeys: result ? Object.keys(result).slice(0, 10) : null,
          hasResponse: !!result?.response,
          hasError: !!result?.error,
          hasInterruptMarker: !!result?.interruptMarker
        });

        // Check if there's another interrupt
        if (result.interruptMarker === 'PENDING_APPROVAL') {
          return res.json({
            status: 'PENDING_APPROVAL',
            ...result
          });
        }

        // Process completed
        return res.json({
          status: 'COMPLETED',
          response: result.final_response || result.response || 'Action completed successfully.',
          thread_id,
          entities: result.entities
        });

      } catch (error) {
        console.error(`[AGENT:APPROVE:${requestId}] ❌ V2 resume error:`, {
          message: error.message,
          name: error.name,
          stack: error.stack?.split('\n').slice(0, 5).join(' | ')
        });

        // Check if it's a checkpoint not found error
        if (error.message?.includes('checkpoint') || error.message?.includes('not found')) {
          console.error(`[AGENT:APPROVE:${requestId}] 🔄 Checkpoint error - suggesting retry`);
          return res.status(422).json({
            error: 'Session expired',
            message: 'The approval session has expired. Please retry your original request.',
            requiresRestart: true
          });
        }

        return res.status(500).json({
          error: 'Failed to resume execution',
          details: error.message
        });
      }
    }

    // V1 Architecture: Original flow
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
 * POST /api/agent/resolve-contact
 * Resume interrupted graph with selected contact
 */
router.post('/resolve-contact', async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  console.log(`[AGENT:RESOLVE_CONTACT:${requestId}] Starting contact resolution`);
  
  try {
    // Step 1: Validate input
    const { session_id, org_id, thread_id, contact_id, contact_data, time_zone } = req.body;
    
    if (!session_id) {
      return res.status(400).json({ 
        error: 'session_id is required',
        requiresReauth: false 
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
    
    if (!contact_id && !contact_data) {
      return res.status(400).json({ 
        error: 'Either contact_id or contact_data is required' 
      });
    }
    
    // Step 2: Get PassKey
    const passKey = await getValidPassKey(session_id);
    
    if (!passKey) {
      console.log(`[AGENT:RESOLVE_CONTACT:${requestId}] No valid PassKey, needs re-authentication`);
      return res.status(401).json({ 
        error: 'Authentication required. Please login again.',
        requiresReauth: true 
      });
    }
    
    // Step 3: Create config for resumption
    const config = {
      recursionLimit: 50,
      configurable: {
        thread_id,
        org_id,
        time_zone: time_zone || DEFAULT_TIMEZONE,
        passKey,
        session_id
      }
    };
    
    console.log(`[AGENT:RESOLVE_CONTACT:${requestId}] Resuming thread:`, thread_id);
    
    // Step 4: Resume with V2 architecture
    if (USE_V2_ARCHITECTURE) {
      const coordinator = getCoordinator();
      
      // Resume with selected contact
      const result = await coordinator.resume(thread_id, {
        type: 'contact_selection',
        selectedContact: contact_data || { id: contact_id }
      }, session_id, org_id);
      
      // Check for additional interrupts
      if (result.status === 'PENDING_INTERRUPT') {
        console.log(`[AGENT:RESOLVE_CONTACT:${requestId}] Another interrupt detected`);
        return res.status(202).json(result);
      }
      
      // Return completed result
      console.log(`[AGENT:RESOLVE_CONTACT:${requestId}] Completed successfully`);
      return res.json(result);
      
    } else {
      // Legacy architecture - use Command to resume
      const graph = await buildGraph();
      const { Command } = await import("@langchain/langgraph");
      
      // Create resume command with selected contact
      const resumeCommand = new Command({
        resume: {
          selectedContact: contact_data || { id: contact_id }
        },
        update: {
          interruptMarker: null,
          selectedContactId: contact_id
        }
      });
      
      console.log(`[AGENT:RESOLVE_CONTACT:${requestId}] Invoking graph with resume command`);
      const state = await graph.invoke(resumeCommand, config);
      
      // Check for another interruption
      if (state.interruptMarker === 'PENDING_APPROVAL') {
        console.log(`[AGENT:RESOLVE_CONTACT:${requestId}] Another approval required`);
        state.thread_id = thread_id;
        const response = formatResponse(state, 'PENDING_APPROVAL');
        return res.status(202).json(response);
      }
      
      // Format and return response
      const response = formatResponse(state, 'COMPLETED');
      console.log(`[AGENT:RESOLVE_CONTACT:${requestId}] Completed successfully`);
      return res.json(response);
    }
    
  } catch (error) {
    console.error(`[AGENT:RESOLVE_CONTACT:${requestId}] Error:`, error);
    return res.status(500).json({ 
      error: error.message || 'Failed to resolve contact' 
    });
  }
});

/**
 * GET /api/agent/interrupt-status
 * Check for pending interrupts (for polling mode)
 */
router.post('/interrupt-status', async (req, res) => {
  try {
    const { session_id, thread_id } = req.body;
    
    if (!session_id || !thread_id) {
      return res.status(400).json({ 
        error: 'session_id and thread_id are required' 
      });
    }
    
    // Check polling service for interrupts
    if (process.env.NODE_ENV === 'production') {
      const { getInterruptPollingService } = require('../websocket/pollingFallback');
      const pollingService = getInterruptPollingService();
      const interrupt = pollingService.checkPending(session_id);

      if (interrupt && interrupt.data && interrupt.data.threadId === thread_id) {
        return res.json({
          hasInterrupt: true,
          interrupt: interrupt.data
        });
      }
    }
    
    return res.json({
      hasInterrupt: false
    });
    
  } catch (error) {
    console.error('[AGENT:INTERRUPT_STATUS] Error:', error);
    return res.status(500).json({ 
      error: 'Failed to check interrupt status' 
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