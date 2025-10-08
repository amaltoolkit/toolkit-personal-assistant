/**
 * Monitoring Routes for Memory System Health
 * 
 * Provides metrics and health check endpoints for the memory system
 */

const express = require('express');
const router = express.Router();

/**
 * GET /api/metrics
 * Returns memory system metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    const { getStore } = require('../graph/state');
    const store = await getStore();
    
    // Get metrics from UnifiedStore
    const metrics = store.getMetrics ? store.getMetrics() : {};
    
    // Calculate derived metrics
    const hitRate = metrics.hits && metrics.misses 
      ? (metrics.hits / (metrics.hits + metrics.misses) * 100).toFixed(2)
      : 0;
    
    const errorRate = metrics.errors && metrics.writes
      ? (metrics.errors / metrics.writes * 100).toFixed(2)
      : 0;
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      metrics: {
        ...metrics,
        calculated: {
          hitRate: `${hitRate}%`,
          errorRate: `${errorRate}%`,
          totalOperations: (metrics.hits || 0) + (metrics.misses || 0) + 
                          (metrics.writes || 0) + (metrics.deletes || 0) + 
                          (metrics.searches || 0)
        }
      }
    });
  } catch (error) {
    console.error('[MONITORING] Metrics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve metrics'
    });
  }
});

/**
 * GET /api/health/memory
 * Health check for memory system
 */
router.get('/health/memory', async (req, res) => {
  const healthChecks = {
    store: false,
    database: false,
    search: false,
    synthesis: false
  };
  
  const startTime = Date.now();
  
  try {
    // Check 1: Can we get the store?
    const { getStore } = require('../graph/state');
    const store = await getStore();
    healthChecks.store = !!store;
    
    // Check 2: Can we write and read?
    if (store) {
      const testNamespace = ['health-check', 'test', 'memories'];
      const testKey = `health-${Date.now()}`;
      
      try {
        // Test write
        await store.put(testNamespace, testKey, {
          text: 'Health check test memory',
          kind: 'fact',
          importance: 1
        }, {
          source: 'test',
          ttlDays: 1,
          index: false
        });
        
        // Test read
        const result = await store.get(testNamespace, testKey);
        healthChecks.database = result !== null;
        
        // Clean up
        await store.delete(testNamespace, testKey);
      } catch (dbError) {
        console.error('[HEALTH] Database check failed:', dbError.message);
      }
    }
    
    // Check 3: Can we search?
    if (store && store.search) {
      try {
        const testNamespace = ['health-check', 'test', 'memories'];
        const results = await store.search(testNamespace, {
          query: 'test',
          limit: 1
        });
        healthChecks.search = Array.isArray(results);
      } catch (searchError) {
        console.error('[HEALTH] Search check failed:', searchError.message);
      }
    }
    
    // Check 4: Is synthesis available?
    try {
      const { synthesizeMemoryNode } = require('../memory/synthesize');
      healthChecks.synthesis = typeof synthesizeMemoryNode === 'function';
    } catch (synthError) {
      console.error('[HEALTH] Synthesis check failed:', synthError.message);
    }
    
    const responseTime = Date.now() - startTime;
    const allHealthy = Object.values(healthChecks).every(check => check);
    const status = allHealthy ? 'healthy' : 'degraded';
    
    res.status(allHealthy ? 200 : 503).json({
      status,
      timestamp: new Date().toISOString(),
      responseTime: `${responseTime}ms`,
      checks: healthChecks,
      details: {
        store: healthChecks.store ? 'Connected' : 'Failed to initialize',
        database: healthChecks.database ? 'Read/Write OK' : 'Database operations failed',
        search: healthChecks.search ? 'Vector search available' : 'Search unavailable',
        synthesis: healthChecks.synthesis ? 'LLM synthesis ready' : 'Synthesis unavailable'
      }
    });
    
  } catch (error) {
    console.error('[HEALTH] Critical error:', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
      checks: healthChecks
    });
  }
});

/**
 * GET /api/health
 * Basic health check
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'memory-monitoring',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/memory/stats
 * Get memory statistics by organization/user
 */
router.get('/memory/stats', async (req, res) => {
  try {
    const { org_id, user_id } = req.query;
    
    if (!org_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'org_id and user_id are required'
      });
    }
    
    const { UnifiedStore } = require('../graph/unifiedStore');
    const store = new UnifiedStore({
      orgId: org_id,
      userId: user_id,
      isDev: false
    });
    await store.ensureInitialized();
    
    const namespace = [org_id, user_id, 'memories'];
    
    // Get all memories for stats (limited to 100 for performance)
    const memories = await store.search(namespace, {
      query: '',
      limit: 100
    });
    
    // Calculate statistics
    const stats = {
      total: memories.length,
      byKind: {},
      byImportance: {},
      averageImportance: 0
    };
    
    let totalImportance = 0;
    
    memories.forEach(memory => {
      // Count by kind
      const kind = memory.value?.kind || 'unknown';
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      
      // Count by importance
      const importance = memory.value?.importance || 0;
      stats.byImportance[importance] = (stats.byImportance[importance] || 0) + 1;
      totalImportance += importance;
    });
    
    stats.averageImportance = memories.length > 0 
      ? (totalImportance / memories.length).toFixed(2)
      : 0;
    
    res.json({
      success: true,
      orgId: org_id,
      userId: user_id,
      stats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[MONITORING] Stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve memory statistics'
    });
  }
});

module.exports = router;