/**
 * ErrorHandler Service
 * 
 * Provides robust error handling with retry logic, circuit breaker pattern,
 * and error classification for the V2 architecture.
 */

class ErrorHandler {
  constructor() {
    // Circuit breaker state
    this.circuitBreakers = new Map();
    this.circuitBreakerConfig = {
      threshold: 5,           // failures before opening
      resetTimeout: 60000,    // 1 minute reset time
      halfOpenRequests: 3     // requests to test in half-open state
    };
    
    // Retry configuration
    this.retryConfig = {
      maxRetries: 3,
      initialDelay: 1000,     // 1 second
      maxDelay: 30000,        // 30 seconds
      backoffMultiplier: 2
    };
    
    // Error metrics
    this.errorMetrics = new Map();
    this.metricsWindow = 5 * 60 * 1000; // 5 minute window
  }

  /**
   * Execute function with retry logic and circuit breaker
   */
  async executeWithRetry(fn, context = {}) {
    const { 
      operation = 'unknown',
      maxRetries = this.retryConfig.maxRetries,
      retryable = true,
      circuitBreakerKey = null
    } = context;

    // Check circuit breaker if key provided
    if (circuitBreakerKey) {
      this.checkCircuitBreaker(circuitBreakerKey);
    }

    let lastError;
    let delay = this.retryConfig.initialDelay;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[ErrorHandler] Attempt ${attempt}/${maxRetries} for ${operation}`);
        
        // Execute the function
        const result = await fn();
        
        // Success - reset circuit breaker if applicable
        if (circuitBreakerKey) {
          this.recordSuccess(circuitBreakerKey);
        }
        
        return result;
        
      } catch (error) {
        lastError = error;
        console.error(`[ErrorHandler] Attempt ${attempt} failed for ${operation}:`, error.message);
        
        // Record failure for circuit breaker
        if (circuitBreakerKey) {
          this.recordFailure(circuitBreakerKey);
        }
        
        // Record error metrics
        this.recordError(operation, error);
        
        // Check if error is retryable
        if (!retryable || !this.isRetryableError(error)) {
          console.log(`[ErrorHandler] Error is not retryable, failing immediately`);
          throw this.enhanceError(error, { operation, attempt, context });
        }
        
        // Don't retry if this was the last attempt
        if (attempt === maxRetries) {
          console.error(`[ErrorHandler] All ${maxRetries} attempts failed for ${operation}`);
          throw this.enhanceError(lastError, { 
            operation, 
            attempts: maxRetries, 
            context,
            exhausted: true 
          });
        }
        
        // Wait before retry with exponential backoff
        console.log(`[ErrorHandler] Waiting ${delay}ms before retry...`);
        await this.sleep(delay);
        delay = Math.min(delay * this.retryConfig.backoffMultiplier, this.retryConfig.maxDelay);
      }
    }
  }

  /**
   * Check if circuit breaker allows request
   */
  checkCircuitBreaker(key) {
    const breaker = this.circuitBreakers.get(key);
    if (!breaker) return; // No breaker, allow request

    const now = Date.now();
    
    // Check state
    if (breaker.state === 'open') {
      // Check if enough time has passed to try half-open
      if (now - breaker.lastFailure > this.circuitBreakerConfig.resetTimeout) {
        console.log(`[CircuitBreaker] Moving ${key} to half-open state`);
        breaker.state = 'half-open';
        breaker.halfOpenAttempts = 0;
      } else {
        throw new Error(`Circuit breaker open for ${key}. Wait ${Math.ceil((this.circuitBreakerConfig.resetTimeout - (now - breaker.lastFailure)) / 1000)}s`);
      }
    }
    
    // In half-open state, limit requests
    if (breaker.state === 'half-open') {
      if (breaker.halfOpenAttempts >= this.circuitBreakerConfig.halfOpenRequests) {
        throw new Error(`Circuit breaker half-open limit reached for ${key}`);
      }
      breaker.halfOpenAttempts++;
    }
  }

  /**
   * Record successful execution
   */
  recordSuccess(key) {
    const breaker = this.circuitBreakers.get(key);
    if (!breaker) return;

    if (breaker.state === 'half-open') {
      // Success in half-open state, check if we can close
      breaker.successCount++;
      if (breaker.successCount >= this.circuitBreakerConfig.halfOpenRequests) {
        console.log(`[CircuitBreaker] Closing circuit for ${key}`);
        breaker.state = 'closed';
        breaker.failureCount = 0;
        breaker.successCount = 0;
      }
    } else if (breaker.state === 'closed') {
      // Reset failure count on success
      breaker.failureCount = 0;
    }
  }

  /**
   * Record failed execution
   */
  recordFailure(key) {
    let breaker = this.circuitBreakers.get(key);
    
    if (!breaker) {
      breaker = {
        state: 'closed',
        failureCount: 0,
        successCount: 0,
        lastFailure: Date.now(),
        halfOpenAttempts: 0
      };
      this.circuitBreakers.set(key, breaker);
    }

    breaker.failureCount++;
    breaker.lastFailure = Date.now();

    // Check if we should open the circuit
    if (breaker.state === 'closed' && breaker.failureCount >= this.circuitBreakerConfig.threshold) {
      console.error(`[CircuitBreaker] Opening circuit for ${key} after ${breaker.failureCount} failures`);
      breaker.state = 'open';
    } else if (breaker.state === 'half-open') {
      // Failure in half-open state, reopen
      console.error(`[CircuitBreaker] Reopening circuit for ${key} after half-open failure`);
      breaker.state = 'open';
      breaker.successCount = 0;
    }
  }

  /**
   * Determine if error is retryable
   */
  isRetryableError(error) {
    // Network errors
    if (error.code === 'ECONNRESET' || 
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ECONNREFUSED') {
      return true;
    }

    // HTTP status codes
    if (error.response) {
      const status = error.response.status;
      // Retry on 5xx errors and specific 4xx errors
      if (status >= 500 || status === 429 || status === 408) {
        return true;
      }
    }

    // BSA specific errors
    if (error.message && (
      error.message.includes('PassKey expired') ||
      error.message.includes('Rate limit') ||
      error.message.includes('Temporary failure')
    )) {
      return true;
    }

    // LangGraph/LangChain errors
    if (error.message && (
      error.message.includes('Model overloaded') ||
      error.message.includes('Context length exceeded')
    )) {
      return false; // These need different handling
    }

    return false;
  }

  /**
   * Enhance error with context
   */
  enhanceError(error, metadata = {}) {
    const enhanced = new Error(error.message);
    enhanced.name = error.name || 'EnhancedError';
    enhanced.stack = error.stack;
    enhanced.originalError = error;
    enhanced.metadata = {
      ...metadata,
      timestamp: new Date().toISOString(),
      circuitBreakerStates: this.getCircuitBreakerStates(),
      errorRate: this.getErrorRate()
    };

    // Add error classification
    enhanced.classification = this.classifyError(error);
    
    return enhanced;
  }

  /**
   * Classify error type
   */
  classifyError(error) {
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return 'network';
    }
    
    if (error.response?.status >= 500) {
      return 'server';
    }
    
    if (error.response?.status === 429) {
      return 'rate_limit';
    }
    
    if (error.response?.status >= 400 && error.response?.status < 500) {
      return 'client';
    }
    
    if (error.message?.includes('PassKey')) {
      return 'auth';
    }
    
    if (error.message?.includes('validation') || error.message?.includes('invalid')) {
      return 'validation';
    }
    
    return 'unknown';
  }

  /**
   * Record error metrics
   */
  recordError(operation, error) {
    const now = Date.now();
    const key = `${operation}:${this.classifyError(error)}`;
    
    if (!this.errorMetrics.has(key)) {
      this.errorMetrics.set(key, []);
    }
    
    const metrics = this.errorMetrics.get(key);
    metrics.push({
      timestamp: now,
      message: error.message,
      code: error.code || error.response?.status
    });
    
    // Clean old metrics
    const cutoff = now - this.metricsWindow;
    const filtered = metrics.filter(m => m.timestamp > cutoff);
    this.errorMetrics.set(key, filtered);
  }

  /**
   * Get current error rate
   */
  getErrorRate() {
    const now = Date.now();
    const cutoff = now - this.metricsWindow;
    let totalErrors = 0;
    
    for (const [key, metrics] of this.errorMetrics.entries()) {
      totalErrors += metrics.filter(m => m.timestamp > cutoff).length;
    }
    
    // Errors per minute
    return (totalErrors / (this.metricsWindow / 60000)).toFixed(2);
  }

  /**
   * Get circuit breaker states
   */
  getCircuitBreakerStates() {
    const states = {};
    for (const [key, breaker] of this.circuitBreakers.entries()) {
      states[key] = {
        state: breaker.state,
        failures: breaker.failureCount
      };
    }
    return states;
  }

  /**
   * Reset circuit breaker for a key
   */
  resetCircuitBreaker(key) {
    console.log(`[CircuitBreaker] Manually resetting ${key}`);
    this.circuitBreakers.delete(key);
  }

  /**
   * Reset all circuit breakers
   */
  resetAllCircuitBreakers() {
    console.log(`[CircuitBreaker] Resetting all circuit breakers`);
    this.circuitBreakers.clear();
  }

  /**
   * Get error report
   */
  getErrorReport() {
    const report = {
      errorRate: this.getErrorRate(),
      circuitBreakers: this.getCircuitBreakerStates(),
      recentErrors: {}
    };
    
    // Get recent errors by type
    for (const [key, metrics] of this.errorMetrics.entries()) {
      if (metrics.length > 0) {
        report.recentErrors[key] = {
          count: metrics.length,
          lastError: metrics[metrics.length - 1]
        };
      }
    }
    
    return report;
  }

  /**
   * Helper: Sleep for specified milliseconds
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Create singleton instance
let instance = null;

module.exports = {
  getErrorHandler: () => {
    if (!instance) {
      instance = new ErrorHandler();
    }
    return instance;
  },
  ErrorHandler
};