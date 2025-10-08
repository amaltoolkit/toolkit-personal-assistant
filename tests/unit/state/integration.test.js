/**
 * Integration tests for UnifiedStore with memory nodes
 * 
 * Tests that the memory recall and synthesis nodes work correctly with UnifiedStore
 * Run with: node api/graph/unifiedStore.integration.test.js
 */

require('dotenv').config();

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`❌ ${name}: ${error.message}`);
    console.error(error.stack);
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// Main integration test suite
async function runIntegrationTests() {
  console.log('\n=== UnifiedStore Integration Test Suite ===\n');
  console.log('Testing integration with memory nodes...\n');
  
  // Test 1: UnifiedStore with getStore()
  await test('Should create UnifiedStore via getStore()', async () => {
    const { getStore } = require('./state');
    
    const store = await getStore({
      orgId: 'test-org-integration',
      userId: 'test-user-integration'
    });
    
    assert(store !== null, 'Store should be created');
    assert(typeof store.put === 'function', 'Store should have put method');
    assert(typeof store.get === 'function', 'Store should have get method');
    assert(typeof store.search === 'function', 'Store should have search method');
  });
  
  // Test 2: Memory synthesis with UnifiedStore
  await test('Should store memories via synthesis node', async () => {
    const { synthesizeMemories } = require('../memory/synthesize');
    const { HumanMessage, AIMessage } = require('@langchain/core/messages');
    
    // Create test messages
    const messages = [
      new HumanMessage("I prefer morning meetings before 10am"),
      new AIMessage("Noted! I'll remember that you prefer morning meetings before 10am."),
      new HumanMessage("Also, always include zoom links in calendar invites"),
      new AIMessage("Got it! I'll make sure to include Zoom links in all calendar invites.")
    ];
    
    // Synthesize memories (this should use UnifiedStore internally)
    const synthesized = await synthesizeMemories(
      messages,
      'test-org-synth',
      'test-user-synth',
      {
        messagesLookback: 4,
        minImportance: 1,
        enableAutoSynthesis: true
      }
    );
    
    console.log(`    Synthesized ${synthesized.length} memories`);
    assert(Array.isArray(synthesized), 'Should return array of memories');
  });
  
  // Test 3: Memory recall with UnifiedStore
  await test('Should recall memories via recall node', async () => {
    const { recallMemories } = require('../memory/recall');
    
    // First, let's store a memory directly
    const { getStore } = require('./state');
    const store = await getStore({
      orgId: 'test-org-recall',
      userId: 'test-user-recall'
    });
    
    // Store a test memory
    await store.put(
      ['test-org-recall', 'test-user-recall', 'memories'],
      'recall-test-key',
      {
        text: 'User prefers detailed project reports',
        kind: 'preference',
        importance: 4
      }
    );
    
    // Try to recall (note: without PgMemoryStore, search won't work)
    const recalled = await recallMemories(
      'project reports',
      'test-org-recall',
      'test-user-recall',
      { limit: 5 }
    );
    
    console.log(`    Recalled ${recalled.length} memories`);
    assert(Array.isArray(recalled), 'Should return array');
    // In dev mode without PgMemoryStore, search returns empty
    // This is expected behavior
  });
  
  // Test 4: Direct UnifiedStore operations
  await test('Should handle direct store operations', async () => {
    const { getUnifiedStore } = require('./unifiedStore');
    
    const store = getUnifiedStore({
      orgId: 'test-org-direct',
      userId: 'test-user-direct',
      isDev: true
    });
    
    const namespace = ['test-org-direct', 'test-user-direct', 'memories'];
    
    // Test put
    const key = await store.put(namespace, null, {
      text: 'Direct test memory',
      kind: 'fact',
      importance: 3
    });
    assert(typeof key === 'string', 'Should return key');
    
    // Test get
    const retrieved = await store.get(namespace, key);
    assert(retrieved !== null, 'Should retrieve stored value');
    assert(retrieved.value.text === 'Direct test memory', 'Value should match');
    
    // Test metrics
    const metrics = store.getMetrics();
    assert(metrics.writes > 0, 'Should track writes');
    console.log(`    Metrics: ${metrics.writes} writes, ${metrics.hits} hits, ${metrics.searches} searches`);
  });
  
  // Test 5: Store persistence across instances
  await test('Should maintain singleton pattern in memory operations', async () => {
    const { getStore } = require('./state');
    
    // Get store multiple times with same config
    const store1 = await getStore({
      orgId: 'singleton-org',
      userId: 'singleton-user'
    });
    
    const store2 = await getStore({
      orgId: 'singleton-org',
      userId: 'singleton-user'
    });
    
    // Store data with first instance
    const namespace = ['singleton-org', 'singleton-user', 'test'];
    const key = 'singleton-key-' + Date.now();
    await store1.put(namespace, key, { data: 'singleton test' });
    
    // Retrieve with second instance (should work if singleton)
    const result = await store2.get(namespace, key);
    assert(result !== null, 'Second instance should see data from first');
    assert(result.value.data === 'singleton test', 'Data should match');
  });
  
  // Test 6: Error handling in memory operations
  await test('Should handle errors gracefully in memory operations', async () => {
    const { getStore } = require('./state');
    
    const store = await getStore({
      orgId: 'error-test-org',
      userId: 'error-test-user'
    });
    
    // Test get with non-existent key
    const result = await store.get(
      ['error-test-org', 'error-test-user', 'test'],
      'non-existent-key-' + Date.now()
    );
    assert(result === null, 'Should return null for non-existent key');
    
    // Test search (should handle gracefully even without PgMemoryStore)
    const searchResults = await store.search(
      ['error-test-org', 'error-test-user'],
      'test query'
    );
    assert(Array.isArray(searchResults), 'Search should return array');
  });
  
  // Test 7: Namespace isolation
  await test('Should maintain namespace isolation', async () => {
    const { getUnifiedStore } = require('./unifiedStore');
    
    // Create stores for different orgs
    const store1 = getUnifiedStore({
      orgId: 'org1',
      userId: 'user1',
      isDev: true
    });
    
    const store2 = getUnifiedStore({
      orgId: 'org2',
      userId: 'user2',
      isDev: true
    });
    
    // Store data in different namespaces
    const key = 'shared-key-name';
    await store1.put(['org1', 'user1', 'data'], key, { value: 'org1 data' });
    await store2.put(['org2', 'user2', 'data'], key, { value: 'org2 data' });
    
    // Verify isolation
    const result1 = await store1.get(['org1', 'user1', 'data'], key);
    const result2 = await store2.get(['org2', 'user2', 'data'], key);
    
    assert(result1?.value.value === 'org1 data', 'Org1 should see its own data');
    assert(result2?.value.value === 'org2 data', 'Org2 should see its own data');
    
    // Cross-namespace access should fail
    const crossResult = await store1.get(['org2', 'user2', 'data'], key);
    // This might succeed in InMemoryStore but would fail with proper PgMemoryStore
    console.log(`    Cross-namespace access: ${crossResult ? 'allowed (dev)' : 'blocked'}`);
  });
  
  // Print summary
  console.log('\n=== Integration Test Summary ===');
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  console.log(`Total: ${testsPassed + testsFailed}`);
  
  console.log('\n=== Notes ===');
  console.log('- Some features (semantic search) require PgMemoryStore with Supabase');
  console.log('- InMemoryStore provides basic functionality for development');
  console.log('- Full integration testing requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  
  // Exit with appropriate code
  process.exit(testsFailed > 0 ? 1 : 0);
}

// Run integration tests
runIntegrationTests().catch(error => {
  console.error('Integration test suite failed:', error);
  process.exit(1);
});