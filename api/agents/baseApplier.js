/**
 * Base Applier - Shared logic for all applier agents
 *
 * Provides common functionality for:
 * - Finding previews in state
 * - Calling BSA tools
 * - Managing artifacts and marking actions done
 * - Error handling and retries
 * - PassKey security
 */

const bsaConfig = require('../config/bsa');

/**
 * Base applier function that handles common apply patterns
 * @param {Object} state - The graph state
 * @param {Object} config - The configuration object with PassKey
 * @param {Object} applierConfig - Configuration for this specific applier
 * @returns {Object} Updated state with artifacts
 */
async function baseApplier(state, config, applierConfig) {
  const {
    actionType,       // Type of action (build_workflow, create_task, etc.)
    applyFunction,    // Async function to execute the apply logic
    extractResult     // Function to extract result data for artifacts
  } = applierConfig;

  try {
    // Derive preview/spec from branch state or global state
    const inlinePreview = state.preview || null;
    const globalPreview = findPreviewForAction(state);
    const preview = inlinePreview || globalPreview;
    const spec = (preview && preview.spec) || state.spec;

    if (!spec) {
      const msg = `[APPLIER:${actionType}] No preview/spec found for action ${state.action?.id}`;
      console.error(msg);
      const failed = {
        actionId: state.action?.id,
        error: msg,
        phase: "apply",
        timestamp: new Date().toISOString(),
        retryable: false
      };
      return {
        artifacts: {
          ...state.artifacts,
          failedActions: [ ...(state.artifacts?.failedActions || []), failed ],
          lastApplied: {
            actionId: state.action?.id,
            type: actionType,
            timestamp: new Date().toISOString(),
            success: false,
            error: failed.error
          }
        }
      };
    }

    console.log(`[APPLIER:${actionType}] Applying action ${state.action?.id}...`);

    // Execute the apply function with BSA credentials
    const bsaCredentials = {
      BSA_BASE: bsaConfig.getBaseUrl(),
      passKey: config.configurable?.passKey,  // PassKey from secure config
      orgId: config.configurable?.orgId
    };

    // Validate BSA config
    if (!bsaCredentials.passKey) {
      throw new Error("PassKey not available in config");
    }

    // Apply using the derived spec
    const result = await applyFunction(spec, bsaCredentials, config);

    // Mark action as done
    const doneIds = new Set(state.artifacts?.doneIds || []);
    const actionId = state.actionId || state.action?.id;
    if (actionId) {
      doneIds.add(actionId);
      console.log(`[APPLIER:${actionType}] Marking action ${actionId} as done`);
    }

    // Extract result data for artifacts
    const resultData = extractResult ? extractResult(result) : result;

    // Return updated artifacts
    return {
      artifacts: {
        ...state.artifacts,
        doneIds: Array.from(doneIds),
        [actionType]: resultData,
        lastApplied: {
          actionId: actionId || state.action?.id,
          type: actionType,
          timestamp: new Date().toISOString(),
          success: true
        }
      }
    };

  } catch (error) {
    console.error(`[APPLIER:${actionType}:ERROR]`, error.message);

    // Don't expose sensitive error details
    const safeError = error.message?.includes('PassKey') 
      ? 'Authentication error'
      : error.message;

    // Track this as a failed action to prevent infinite retries
    const failedAction = {
      actionId: state.action?.id || state.actionId,
      error: safeError,
      phase: "apply",
      timestamp: new Date().toISOString(),
      retryable: false // Mark as non-retryable after baseApplier failures
    };

    const existingFailed = state.artifacts?.failedActions || [];
    const alreadyFailed = existingFailed.some(f => f.actionId === failedAction.actionId);

    return {
      artifacts: {
        ...state.artifacts,
        failedActions: alreadyFailed ? existingFailed : [...existingFailed, failedAction],
        lastApplied: {
          actionId: failedAction.actionId,
          type: actionType,
          timestamp: new Date().toISOString(),
          success: false,
          error: safeError
        }
      }
    };
  }
}

/**
 * Find the preview for the current action
 */
function findPreviewForAction(state) {
  // First check if preview was passed directly (from Send object)
  if (state.preview) return state.preview;
  
  // Fall back to searching previews array
  if (!state.action?.id || !state.previews) {
    return null;
  }
  
  // Find preview matching the action ID
  return state.previews.find(p => p.actionId === state.action.id) || null;
}

/**
 * Common patterns for BSA API responses
 */
const responsePatterns = {
  /**
   * Extract ID from various BSA response formats
   */
  extractId: (response) => {
    // BSA returns IDs in different formats
    return response?.id || 
           response?.Id || 
           response?.DataObjectId || 
           response?.ID ||
           response?.data?.id ||
           null;
  },

  /**
   * Check if BSA response indicates success
   */
  isSuccess: (response) => {
    // Check various success indicators
    if (response?.Valid === true) return true;
    if (response?.Success === true) return true;
    if (response?.status === 'success') return true;
    if (response?.id || response?.Id || response?.DataObjectId) return true;
    return false;
  },

  /**
   * Extract error message from BSA response
   */
  extractError: (response) => {
    return response?.Message || 
           response?.error || 
           response?.Error ||
           response?.ErrorMessage ||
           'Unknown error';
  }
};

/**
 * Retry logic for transient failures
 */
async function withRetry(fn, maxRetries = 2, delayMs = 1000) {
  let lastError;
  
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry auth errors
      if (error.message?.includes('PassKey') || 
          error.message?.includes('401') ||
          error.message?.includes('403')) {
        throw error;
      }
      
      // Wait before retry (except on last attempt)
      if (i < maxRetries) {
        console.log(`[APPLIER:RETRY] Attempt ${i + 1} failed, retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  throw lastError;
}

/**
 * Validate required applier config
 */
function validateApplierConfig(config) {
  const required = ['actionType', 'applyFunction'];
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    throw new Error(`Applier config missing required fields: ${missing.join(', ')}`);
  }
}

module.exports = {
  baseApplier,
  findPreviewForAction,
  responsePatterns,
  withRetry,
  validateApplierConfig
};