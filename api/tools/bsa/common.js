/**
 * Common utilities for BSA API interactions
 */

/**
 * Normalize BSA API responses
 * BSA responses have two formats:
 * 1. Most endpoints: Array wrapper [{ Results: [...], Valid: true }]
 * 2. PassKey endpoint: Plain object { passkey: "...", expires_in: 3600 }
 * 
 * @param {any} response - Raw BSA API response
 * @returns {Object} Normalized response with consistent structure
 */
function normalizeBSAResponse(response) {
  // Handle array-wrapped responses (most endpoints)
  if (Array.isArray(response) && response.length > 0) {
    const firstItem = response[0];
    
    // Check for Valid flag
    if ('Valid' in firstItem) {
      if (!firstItem.Valid) {
        return {
          valid: false,
          error: firstItem.ErrorMessage || 'BSA API returned Valid: false'
        };
      }
      
      // Extract results based on known patterns
      if (firstItem.Results) {
        return {
          valid: true,
          activities: firstItem.Results,
          ...firstItem // Include other fields
        };
      }
      
      // Some endpoints return the data directly in the first item
      return {
        valid: true,
        ...firstItem
      };
    }
  }
  
  // Handle plain object responses (e.g., PassKey endpoint)
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return {
      valid: true,
      ...response
    };
  }
  
  // Handle empty or null responses
  if (!response) {
    return {
      valid: false,
      error: 'Empty response from BSA API'
    };
  }
  
  // Fallback for unexpected formats
  return {
    valid: true,
    data: response
  };
}

/**
 * Handle BSA API errors with proper logging and formatting
 * @param {Error} error - Error object from axios or other source
 * @param {string} context - Context for the error (e.g., "fetching appointments")
 * @returns {Object} Formatted error object
 */
function handleBSAError(error, context) {
  const errorInfo = {
    context,
    message: error.message,
    timestamp: new Date().toISOString()
  };
  
  // Extract more details from axios errors
  if (error.response) {
    errorInfo.status = error.response.status;
    errorInfo.statusText = error.response.statusText;
    errorInfo.data = error.response.data;
    
    // Special handling for common BSA errors
    if (error.response.status === 401) {
      errorInfo.type = 'authentication';
      errorInfo.userMessage = 'Authentication failed. PassKey may have expired.';
    } else if (error.response.status === 403) {
      errorInfo.type = 'authorization';
      errorInfo.userMessage = 'Access denied. Check organization permissions.';
    } else if (error.response.status === 429) {
      errorInfo.type = 'rate_limit';
      errorInfo.userMessage = 'Too many requests. Please try again later.';
    } else if (error.response.status >= 500) {
      errorInfo.type = 'server_error';
      errorInfo.userMessage = 'BSA server error. Please try again.';
    }
  } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    errorInfo.type = 'timeout';
    errorInfo.userMessage = 'Request timed out. BSA may be slow.';
  } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    errorInfo.type = 'network';
    errorInfo.userMessage = 'Cannot connect to BSA. Check network connection.';
  }
  
  console.error(`[BSA:ERROR] ${context}:`, errorInfo);
  return errorInfo;
}

/**
 * Retry a BSA API call with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Promise<any>} Result from successful call
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    factor = 2,
    shouldRetry = (error) => {
      // Retry on network errors and 5xx errors
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
        return true;
      }
      if (error.response?.status >= 500) {
        return true;
      }
      // Retry on PassKey expiration
      if (error.response?.status === 401 && error.response?.data?.includes?.('expired')) {
        return true;
      }
      return false;
    }
  } = options;
  
  let lastError;
  let delay = initialDelay;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (!shouldRetry(error) || attempt === maxRetries) {
        throw error;
      }
      
      console.log(`[BSA:RETRY] Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      delay = Math.min(delay * factor, maxDelay);
    }
  }
  
  throw lastError;
}

/**
 * Format date for BSA API (YYYY-MM-DD)
 * @param {Date|string} date - Date to format
 * @returns {string} Formatted date string
 */
function formatBSADate(date) {
  if (!date) return null;
  
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  
  return d.toISOString().split('T')[0];
}

/**
 * Format datetime for BSA API (ISO 8601)
 * @param {Date|string} datetime - Datetime to format
 * @returns {string} Formatted datetime string
 */
function formatBSADateTime(datetime) {
  if (!datetime) return null;
  
  const d = typeof datetime === 'string' ? new Date(datetime) : datetime;
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid datetime: ${datetime}`);
  }
  
  return d.toISOString();
}

/**
 * Parse BSA datetime to JavaScript Date
 * @param {string} bsaDateTime - BSA datetime string
 * @returns {Date|null} Parsed Date object
 */
function parseBSADateTime(bsaDateTime) {
  if (!bsaDateTime) return null;
  
  try {
    const date = new Date(bsaDateTime);
    if (isNaN(date.getTime())) {
      console.warn(`[BSA:PARSE] Invalid datetime: ${bsaDateTime}`);
      return null;
    }
    return date;
  } catch (error) {
    console.warn(`[BSA:PARSE] Error parsing datetime: ${bsaDateTime}`, error);
    return null;
  }
}

/**
 * Validate required fields for BSA operations
 * @param {Object} data - Data object to validate
 * @param {Array<string>} requiredFields - List of required field names
 * @throws {Error} If validation fails
 */
function validateRequiredFields(data, requiredFields) {
  const missing = requiredFields.filter(field => !data[field]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
}

/**
 * Build BSA API headers with authentication
 * @param {string} passKey - BSA PassKey
 * @returns {Object} Headers object
 */
function buildBSAHeaders(passKey) {
  return {
    'Authorization': `Bearer ${passKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Requested-With': 'XMLHttpRequest'
  };
}

module.exports = {
  normalizeBSAResponse,
  handleBSAError,
  retryWithBackoff,
  formatBSADate,
  formatBSADateTime,
  parseBSADateTime,
  validateRequiredFields,
  buildBSAHeaders
};