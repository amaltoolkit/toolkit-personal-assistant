// BSA API Client Wrapper
// Provides a clean interface for making BSA API calls

const axios = require('axios');
const bsaConfig = require('./config');
const http = require('http');
const https = require('https');

// Performance optimizations - connection reuse
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10
});

const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10
});

// Axios config with keep-alive for connection reuse
const axiosConfig = {
  timeout: 10000,
  httpAgent: keepAliveAgent,
  httpsAgent: keepAliveHttpsAgent
};

/**
 * BSA response normalization helper
 * Unwraps array format: [{ Results/Organizations/etc: [...], Valid: true, ... }]
 */
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
    console.error('[BSA_CLIENT] Error normalizing response:', error);
    return {
      data: response,
      valid: false,
      error: 'Failed to normalize BSA response'
    };
  }
}

/**
 * Make a POST request to BSA API
 * @param {string} endpoint - The BSA endpoint path
 * @param {object} data - Request body data
 * @param {object} options - Additional axios options
 * @returns {Promise<object>} Normalized response
 */
async function post(endpoint, data, options = {}) {
  try {
    const url = bsaConfig.buildApiEndpoint(endpoint);
    const response = await axios.post(
      url,
      data,
      {
        headers: { "Content-Type": "application/json" },
        ...axiosConfig,
        ...options
      }
    );
    
    return normalizeBSAResponse(response.data);
  } catch (error) {
    console.error('[BSA_CLIENT] POST error:', error.message);
    throw error;
  }
}

/**
 * Make a GET request to BSA API
 * @param {string} endpoint - The BSA endpoint path
 * @param {object} options - Additional axios options
 * @returns {Promise<object>} Normalized response
 */
async function get(endpoint, options = {}) {
  try {
    const url = bsaConfig.buildApiEndpoint(endpoint);
    const response = await axios.get(
      url,
      {
        ...axiosConfig,
        ...options
      }
    );
    
    return normalizeBSAResponse(response.data);
  } catch (error) {
    console.error('[BSA_CLIENT] GET error:', error.message);
    throw error;
  }
}

module.exports = {
  post,
  get,
  normalizeBSAResponse,
  axiosConfig
};

