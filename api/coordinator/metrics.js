/**
 * Performance Monitoring for Coordinator
 * 
 * Tracks execution times, memory usage, and cache performance
 * for all subgraphs and coordinator operations.
 */

class PerformanceMetrics {
  constructor() {
    // Timing data
    this.timers = new Map();
    this.completedTimings = new Map();
    
    // Performance thresholds (in milliseconds)
    this.thresholds = {
      memory_recall: 100,
      router: 50,
      calendar: 500,
      task: 600,
      contact: 400,
      workflow: 1000,
      finalize: 100,
      total: 1500
    };
    
    // Cache metrics
    this.cacheMetrics = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
    
    // Memory metrics
    this.memorySnapshots = [];
    this.maxMemorySnapshots = 100;
    
    // Aggregate stats
    this.stats = new Map();
    this.statsWindow = 5 * 60 * 1000; // 5 minute window
  }

  /**
   * Start timing an operation
   */
  startTimer(operation, metadata = {}) {
    const timer = {
      operation,
      startTime: Date.now(),
      startMemory: process.memoryUsage(),
      metadata
    };
    
    this.timers.set(operation, timer);
    console.log(`[Metrics] Started timer for ${operation}`);
    
    return timer;
  }

  /**
   * End timing and record metrics
   */
  endTimer(operation, success = true, metadata = {}) {
    const timer = this.timers.get(operation);
    if (!timer) {
      console.warn(`[Metrics] No timer found for ${operation}`);
      return null;
    }
    
    const endTime = Date.now();
    const duration = endTime - timer.startTime;
    const endMemory = process.memoryUsage();
    
    // Calculate memory delta
    const memoryDelta = {
      heapUsed: endMemory.heapUsed - timer.startMemory.heapUsed,
      external: endMemory.external - timer.startMemory.external
    };
    
    // Create timing record
    const timing = {
      operation,
      duration,
      success,
      memoryDelta,
      timestamp: endTime,
      metadata: { ...timer.metadata, ...metadata }
    };
    
    // Check against threshold
    const threshold = this.thresholds[operation];
    if (threshold && duration > threshold) {
      console.warn(`[Metrics] ${operation} took ${duration}ms (threshold: ${threshold}ms)`);
      timing.exceededThreshold = true;
    } else {
      console.log(`[Metrics] ${operation} completed in ${duration}ms`);
    }
    
    // Store completed timing
    if (!this.completedTimings.has(operation)) {
      this.completedTimings.set(operation, []);
    }
    this.completedTimings.get(operation).push(timing);
    
    // Update aggregate stats
    this.updateStats(operation, duration, success);
    
    // Clean up timer
    this.timers.delete(operation);
    
    // Take memory snapshot if significant change
    if (Math.abs(memoryDelta.heapUsed) > 10 * 1024 * 1024) { // 10MB change
      this.takeMemorySnapshot(operation, memoryDelta);
    }
    
    return timing;
  }

  /**
   * Record cache hit/miss
   */
  recordCacheHit(cacheType = 'default') {
    this.cacheMetrics.hits++;
    console.log(`[Metrics] Cache hit (${cacheType}): ${this.getCacheHitRate()}% hit rate`);
  }

  recordCacheMiss(cacheType = 'default') {
    this.cacheMetrics.misses++;
    console.log(`[Metrics] Cache miss (${cacheType}): ${this.getCacheHitRate()}% hit rate`);
  }

  recordCacheEviction(count = 1) {
    this.cacheMetrics.evictions += count;
  }

  /**
   * Get cache hit rate
   */
  getCacheHitRate() {
    const total = this.cacheMetrics.hits + this.cacheMetrics.misses;
    if (total === 0) return 0;
    return ((this.cacheMetrics.hits / total) * 100).toFixed(1);
  }

  /**
   * Update aggregate statistics
   */
  updateStats(operation, duration, success) {
    const now = Date.now();
    
    if (!this.stats.has(operation)) {
      this.stats.set(operation, []);
    }
    
    const stats = this.stats.get(operation);
    stats.push({
      duration,
      success,
      timestamp: now
    });
    
    // Clean old stats
    const cutoff = now - this.statsWindow;
    const filtered = stats.filter(s => s.timestamp > cutoff);
    this.stats.set(operation, filtered);
  }

  /**
   * Take memory snapshot
   */
  takeMemorySnapshot(operation, delta) {
    const snapshot = {
      timestamp: Date.now(),
      operation,
      memory: process.memoryUsage(),
      delta
    };
    
    this.memorySnapshots.push(snapshot);
    
    // Limit snapshots
    if (this.memorySnapshots.length > this.maxMemorySnapshots) {
      this.memorySnapshots.shift();
    }
    
    // Check for memory leak indicators
    if (this.memorySnapshots.length >= 10) {
      const recent = this.memorySnapshots.slice(-10);
      const trend = recent.reduce((sum, s) => sum + s.delta.heapUsed, 0);
      
      if (trend > 50 * 1024 * 1024) { // 50MB growth over 10 snapshots
        console.warn(`[Metrics] Potential memory leak detected: ${(trend / 1024 / 1024).toFixed(2)}MB growth`);
      }
    }
  }

  /**
   * Get performance statistics for an operation
   */
  getOperationStats(operation) {
    const stats = this.stats.get(operation);
    if (!stats || stats.length === 0) {
      return null;
    }
    
    const durations = stats.map(s => s.duration);
    const successes = stats.filter(s => s.success).length;
    
    return {
      count: stats.length,
      successRate: ((successes / stats.length) * 100).toFixed(1),
      min: Math.min(...durations),
      max: Math.max(...durations),
      avg: (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(0),
      p50: this.percentile(durations, 50),
      p95: this.percentile(durations, 95),
      p99: this.percentile(durations, 99)
    };
  }

  /**
   * Calculate percentile
   */
  percentile(values, percentile) {
    if (values.length === 0) return 0;
    
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Get complete performance report
   */
  getReport() {
    const report = {
      timestamp: new Date().toISOString(),
      activeTimers: Array.from(this.timers.keys()),
      cache: {
        hitRate: this.getCacheHitRate() + '%',
        hits: this.cacheMetrics.hits,
        misses: this.cacheMetrics.misses,
        evictions: this.cacheMetrics.evictions
      },
      operations: {},
      memory: {
        current: process.memoryUsage(),
        snapshots: this.memorySnapshots.length
      },
      thresholdViolations: []
    };
    
    // Add operation stats
    for (const [operation, _] of this.stats.entries()) {
      const stats = this.getOperationStats(operation);
      if (stats) {
        report.operations[operation] = stats;
        
        // Check threshold violations
        const threshold = this.thresholds[operation];
        if (threshold && stats.p95 > threshold) {
          report.thresholdViolations.push({
            operation,
            p95: stats.p95,
            threshold,
            exceeded: ((stats.p95 - threshold) / threshold * 100).toFixed(1) + '%'
          });
        }
      }
    }
    
    // Add warnings
    report.warnings = [];
    
    if (report.cache.hitRate < 50) {
      report.warnings.push(`Low cache hit rate: ${report.cache.hitRate}`);
    }
    
    if (report.thresholdViolations.length > 0) {
      report.warnings.push(`${report.thresholdViolations.length} operations exceeding thresholds`);
    }
    
    const memoryMB = report.memory.current.heapUsed / 1024 / 1024;
    if (memoryMB > 500) {
      report.warnings.push(`High memory usage: ${memoryMB.toFixed(1)}MB`);
    }
    
    return report;
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.timers.clear();
    this.completedTimings.clear();
    this.stats.clear();
    this.memorySnapshots = [];
    this.cacheMetrics = {
      hits: 0,
      misses: 0,
      evictions: 0
    };
    console.log('[Metrics] All metrics reset');
  }

  /**
   * Export metrics for external monitoring
   */
  exportMetrics() {
    const metrics = [];
    
    // Export operation metrics
    for (const [operation, stats] of this.stats.entries()) {
      if (stats.length > 0) {
        const operationStats = this.getOperationStats(operation);
        metrics.push({
          name: `coordinator.${operation}.duration`,
          type: 'histogram',
          values: {
            p50: operationStats.p50,
            p95: operationStats.p95,
            p99: operationStats.p99
          },
          tags: { operation }
        });
        
        metrics.push({
          name: `coordinator.${operation}.success_rate`,
          type: 'gauge',
          value: parseFloat(operationStats.successRate),
          tags: { operation }
        });
      }
    }
    
    // Export cache metrics
    metrics.push({
      name: 'coordinator.cache.hit_rate',
      type: 'gauge',
      value: parseFloat(this.getCacheHitRate()),
      tags: { cache: 'default' }
    });
    
    // Export memory metrics
    const memory = process.memoryUsage();
    metrics.push({
      name: 'coordinator.memory.heap_used',
      type: 'gauge',
      value: memory.heapUsed,
      tags: { unit: 'bytes' }
    });
    
    return metrics;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getPerformanceMetrics: () => {
    if (!instance) {
      instance = new PerformanceMetrics();
    }
    return instance;
  },
  PerformanceMetrics
};