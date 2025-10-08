/**
 * BSA Configuration Module
 * Centralized configuration for BSA API URLs with smart environment detection
 * Automatically detects RC vs Production based on the URL in BSA_BASE
 */

class BSAConfig {
  constructor() {
    // Get base URL from environment or use default
    this.baseUrl = process.env.BSA_BASE || 'https://rc.bluesquareapps.com';

    // Smart detection of environment based on URL
    this.environment = this.detectEnvironment(this.baseUrl);

    // Validate configuration on initialization
    this.validateConfiguration();

    // Log configuration for debugging
    console.log(`[BSA:CONFIG] Initialized with environment: ${this.environment}, URL: ${this.baseUrl}`);
  }

  /**
   * Detect environment from URL
   * @param {string} url - The BSA base URL
   * @returns {string} - 'rc', 'production', or 'custom'
   */
  detectEnvironment(url) {
    if (!url) return 'rc';

    const lowerUrl = url.toLowerCase();

    if (lowerUrl.includes('rc.bluesquareapps.com')) {
      return 'rc';
    } else if (lowerUrl.includes('toolkit.bluesquareapps.com')) {
      return 'production';
    } else if (lowerUrl.includes('bluesquareapps.com')) {
      // Other BSA domains are considered custom
      return 'custom';
    } else {
      // Non-BSA domains (like localhost for testing)
      return 'custom';
    }
  }

  /**
   * Validate the configuration
   * @throws {Error} if configuration is invalid
   */
  validateConfiguration() {
    if (!this.baseUrl) {
      throw new Error('[BSA:CONFIG] BSA_BASE environment variable is not set');
    }

    // Ensure URL is properly formatted
    try {
      new URL(this.baseUrl);
    } catch (error) {
      throw new Error(`[BSA:CONFIG] Invalid BSA_BASE URL: ${this.baseUrl}`);
    }

    // Remove trailing slash if present
    if (this.baseUrl.endsWith('/')) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }
  }

  /**
   * Get the base URL
   * @returns {string} The BSA base URL
   */
  getBaseUrl() {
    return this.baseUrl;
  }

  /**
   * Get the current environment
   * @returns {string} The detected environment
   */
  getEnvironment() {
    return this.environment;
  }

  /**
   * Build a complete endpoint URL
   * @param {string} path - The endpoint path (e.g., '/oauth2/token')
   * @returns {string} The complete URL
   */
  buildEndpoint(path) {
    // Ensure path starts with /
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${normalizedPath}`;
  }

  /**
   * Build OAuth-specific URLs
   * @param {string} oauthPath - The OAuth path (e.g., 'authorize', 'token', 'passkey')
   * @returns {string} The complete OAuth URL
   */
  buildOAuthUrl(oauthPath) {
    return this.buildEndpoint(`/oauth2/${oauthPath}`);
  }

  /**
   * Build API endpoint URLs
   * @param {string} endpoint - The API endpoint path
   * @returns {string} The complete API URL
   */
  buildApiEndpoint(endpoint) {
    // Handle endpoints that already include /endpoints/ajax/
    if (endpoint.startsWith('/endpoints/ajax/')) {
      return this.buildEndpoint(endpoint);
    }
    // For endpoints that are just the class/method part
    return this.buildEndpoint(`/endpoints/ajax/${endpoint}`);
  }

  /**
   * Check if using RC environment
   * @returns {boolean}
   */
  isRC() {
    return this.environment === 'rc';
  }

  /**
   * Check if using production environment
   * @returns {boolean}
   */
  isProduction() {
    return this.environment === 'production';
  }

  /**
   * Get configuration summary for logging
   * @returns {object}
   */
  getConfigSummary() {
    return {
      environment: this.environment,
      baseUrl: this.baseUrl,
      isRC: this.isRC(),
      isProduction: this.isProduction()
    };
  }
}

// Export singleton instance
const bsaConfig = new BSAConfig();

// Also export the class for testing purposes
module.exports = bsaConfig;
module.exports.BSAConfig = BSAConfig;