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
    // Find the preview for this action
    const preview = findPreviewForAction(state);
    
    if (!preview) {
      console.error(`[APPLIER:${actionType}] No preview found for action ${state.action?.id}`);
      return {
        messages: state.messages,
        artifacts: {
          ...state.artifacts,
          error: `No preview found for ${actionType}`
        }
      };
    }

    // Validate preview has required spec
    if (!preview.spec) {
      console.error(`[APPLIER:${actionType}] Preview missing spec`);
      return {
        messages: state.messages,
        artifacts: {
          ...state.artifacts,
          error: `Preview missing spec for ${actionType}`
        }
      };
    }

    console.log(`[APPLIER:${actionType}] Applying action ${state.action?.id}...`);

    // Execute the apply function with BSA credentials
    const bsaConfig = {
      BSA_BASE: config.configurable?.BSA_BASE || process.env.BSA_BASE,
      passKey: config.configurable?.passKey,  // PassKey from secure config
      orgId: config.configurable?.orgId
    };

    // Validate BSA config
    if (!bsaConfig.passKey) {
      throw new Error("PassKey not available in config");
    }

    // Apply the action
    const result = await applyFunction(preview.spec, bsaConfig, config);

    // Mark action as done
    const doneIds = new Set(state.artifacts?.doneIds || []);
    doneIds.add(state.action?.id);

    // Extract result data for artifacts
    const resultData = extractResult ? extractResult(result) : result;

    // Return updated artifacts
    return {
      messages: state.messages,
      artifacts: {
        ...state.artifacts,
        doneIds: Array.from(doneIds),
        [actionType]: resultData,
        lastApplied: {
          actionId: state.action?.id,
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

    return {
      messages: state.messages,
      artifacts: {
        ...state.artifacts,
        lastApplied: {
          actionId: state.action?.id,
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
  if (!state.action?.id || !state.previews) {
    return null;
  }

  // Find preview matching the action ID
  return state.previews.find(p => p.actionId === state.action.id);
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