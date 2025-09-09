/**
 * Test Monitoring Endpoints
 * 
 * Tests the health check and metrics endpoints
 */

require('dotenv').config();
const axios = require('axios');

// Test configuration
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const TEST_ORG_ID = 'test-monitoring-org';
const TEST_USER_ID = 'test-monitoring-user';

/**
 * Test health check endpoint
 */
async function testHealthCheck() {
  console.log('🏥 Testing Health Check Endpoint');
  console.log('=====================================\n');
  
  try {
    // Basic health check
    console.log('1️⃣ Testing /api/health...');
    const basicHealth = await axios.get(`${BASE_URL}/api/health`);
    console.log('   Status:', basicHealth.data.status);
    console.log('   Service:', basicHealth.data.service);
    
    // Memory health check
    console.log('\n2️⃣ Testing /api/health/memory...');
    const memoryHealth = await axios.get(`${BASE_URL}/api/health/memory`);
    console.log('   Status:', memoryHealth.data.status);
    console.log('   Response Time:', memoryHealth.data.responseTime);
    console.log('   Checks:');
    Object.entries(memoryHealth.data.checks).forEach(([check, status]) => {
      console.log(`     - ${check}: ${status ? '✅' : '❌'}`);
    });
    
    return memoryHealth.data.status === 'healthy';
  } catch (error) {
    console.error('❌ Health check failed:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test metrics endpoint
 */
async function testMetrics() {
  console.log('\n📊 Testing Metrics Endpoint');
  console.log('=====================================\n');
  
  try {
    console.log('Fetching /api/metrics...');
    const response = await axios.get(`${BASE_URL}/api/metrics`);
    
    console.log('Metrics received:');
    const metrics = response.data.metrics;
    
    console.log('  Raw Metrics:');
    console.log(`    - Hits: ${metrics.hits || 0}`);
    console.log(`    - Misses: ${metrics.misses || 0}`);
    console.log(`    - Writes: ${metrics.writes || 0}`);
    console.log(`    - Deletes: ${metrics.deletes || 0}`);
    console.log(`    - Searches: ${metrics.searches || 0}`);
    console.log(`    - Errors: ${metrics.errors || 0}`);
    
    if (metrics.calculated) {
      console.log('  Calculated Metrics:');
      console.log(`    - Hit Rate: ${metrics.calculated.hitRate}`);
      console.log(`    - Error Rate: ${metrics.calculated.errorRate}`);
      console.log(`    - Total Operations: ${metrics.calculated.totalOperations}`);
    }
    
    console.log('  Environment:');
    console.log(`    - Mode: ${metrics.mode || 'unknown'}`);
    console.log(`    - Has Postgres: ${metrics.hasPostgres ? '✅' : '❌'}`);
    console.log(`    - Has InMemory: ${metrics.hasInMemory ? '✅' : '❌'}`);
    
    return response.data.success;
  } catch (error) {
    console.error('❌ Metrics fetch failed:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test memory stats endpoint
 */
async function testMemoryStats() {
  console.log('\n📈 Testing Memory Stats Endpoint');
  console.log('=====================================\n');
  
  try {
    // First, create some test memories
    console.log('Setting up test data...');
    const { UnifiedStore } = require('../graph/unifiedStore');
    const store = new UnifiedStore({
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      isDev: false
    });
    await store.ensureInitialized();
    
    const namespace = [TEST_ORG_ID, TEST_USER_ID, 'memories'];
    
    // Add test memories
    const testMemories = [
      { text: 'Test fact 1', kind: 'fact', importance: 5 },
      { text: 'Test preference 1', kind: 'preference', importance: 4 },
      { text: 'Test instruction 1', kind: 'instruction', importance: 5 },
      { text: 'Test context 1', kind: 'context', importance: 3 },
      { text: 'Test fact 2', kind: 'fact', importance: 3 }
    ];
    
    for (const memory of testMemories) {
      await store.put(namespace, `test-${Date.now()}-${Math.random()}`, memory, {
        source: 'test',
        ttlDays: 1,
        index: false
      });
    }
    
    console.log('Created 5 test memories\n');
    
    // Test the stats endpoint
    console.log('Fetching memory stats...');
    const response = await axios.get(`${BASE_URL}/api/memory/stats`, {
      params: {
        org_id: TEST_ORG_ID,
        user_id: TEST_USER_ID
      }
    });
    
    const stats = response.data.stats;
    console.log('Memory Statistics:');
    console.log(`  Total Memories: ${stats.total}`);
    console.log('  By Kind:');
    Object.entries(stats.byKind).forEach(([kind, count]) => {
      console.log(`    - ${kind}: ${count}`);
    });
    console.log('  By Importance:');
    Object.entries(stats.byImportance).forEach(([imp, count]) => {
      console.log(`    - Level ${imp}: ${count}`);
    });
    console.log(`  Average Importance: ${stats.averageImportance}`);
    
    // Cleanup
    console.log('\nCleaning up test data...');
    const allMemories = await store.search(namespace, { query: 'Test', limit: 100 });
    for (const memory of allMemories) {
      await store.delete(namespace, memory.key);
    }
    
    return response.data.success && stats.total >= 5;
  } catch (error) {
    console.error('❌ Stats fetch failed:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Test error handling
 */
async function testErrorHandling() {
  console.log('\n🚨 Testing Error Handling');
  console.log('=====================================\n');
  
  try {
    console.log('Testing stats endpoint with missing parameters...');
    const response = await axios.get(`${BASE_URL}/api/memory/stats`);
    console.log('❌ Should have returned 400 error');
    return false;
  } catch (error) {
    if (error.response?.status === 400) {
      console.log('✅ Correctly returned 400 for missing parameters');
      return true;
    }
    console.error('❌ Unexpected error:', error.message);
    return false;
  }
}

/**
 * Run all monitoring tests
 */
async function runMonitoringTests() {
  console.log('🔍 Monitoring Endpoints Test Suite');
  console.log('=====================================\n');
  
  const results = {
    health: false,
    metrics: false,
    stats: false,
    errors: false
  };
  
  // Run tests
  results.health = await testHealthCheck();
  results.metrics = await testMetrics();
  results.stats = await testMemoryStats();
  results.errors = await testErrorHandling();
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Results Summary:');
  console.log('- Health Check:', results.health ? '✅ PASSED' : '❌ FAILED');
  console.log('- Metrics:', results.metrics ? '✅ PASSED' : '❌ FAILED');
  console.log('- Memory Stats:', results.stats ? '✅ PASSED' : '❌ FAILED');
  console.log('- Error Handling:', results.errors ? '✅ PASSED' : '❌ FAILED');
  
  const allPassed = Object.values(results).every(r => r);
  if (allPassed) {
    console.log('\n🎉 All monitoring tests passed!');
    process.exit(0);
  } else {
    console.log('\n⚠️ Some monitoring tests failed');
    process.exit(1);
  }
}

// Check if server is running
async function checkServer() {
  try {
    await axios.get(`${BASE_URL}/api/health`);
    return true;
  } catch (error) {
    console.error(`❌ Server not reachable at ${BASE_URL}`);
    console.log('Please start the server with: npm run dev');
    return false;
  }
}

// Run tests if executed directly
if (require.main === module) {
  checkServer().then(isRunning => {
    if (isRunning) {
      runMonitoringTests();
    } else {
      process.exit(1);
    }
  });
}

module.exports = {
  testHealthCheck,
  testMetrics,
  testMemoryStats,
  testErrorHandling
};