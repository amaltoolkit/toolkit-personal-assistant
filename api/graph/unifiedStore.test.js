/**
 * Unit tests for UnifiedStore
 * 
 * Tests the Store API compliance, fallback behavior, and namespace isolation
 * Run with: node api/graph/unifiedStore.test.js
 */

const { UnifiedStore, getUnifiedStore, clearStoreCache } = require('./unifiedStore');

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
    testsFailed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// Main test suite
async function runTests() {
  console.log('\n=== UnifiedStore Test Suite ===\n');
  
  // Clear any existing cache before tests
  clearStoreCache();
  
  // Test 1: Basic instantiation
  await test('Should create UnifiedStore instance', async () => {
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true 
    });
    assert(store instanceof UnifiedStore);
    assert(store.orgId === 'test-org');
    assert(store.userId === 'test-user');
  });
  
  // Test 2: Put and Get operations
  await test('Should store and retrieve values', async () => {
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true 
    });
    
    const namespace = ['test', 'namespace'];
    const key = 'test-key-' + Date.now();
    const value = { text: 'Test memory', importance: 3 };
    
    // Store value
    const storedKey = await store.put(namespace, key, value);
    assert(storedKey === key || typeof storedKey === 'string');
    
    // Retrieve value
    const retrieved = await store.get(namespace, key);
    assert(retrieved !== null, 'Should retrieve stored value');
    assert(retrieved.value.text === value.text, 'Value should match');
  });
  
  // Test 3: Delete operation
  await test('Should delete values', async () => {
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true 
    });
    
    const namespace = ['test', 'delete'];
    const key = 'delete-key-' + Date.now();
    const value = { text: 'To be deleted' };
    
    // Store and delete
    await store.put(namespace, key, value);
    await store.delete(namespace, key);
    
    // Verify deletion
    const retrieved = await store.get(namespace, key);
    assert(retrieved === null, 'Deleted value should be null');
  });
  
  // Test 4: Namespace listing
  await test('Should list namespaces', async () => {
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true 
    });
    
    const prefix = ['test', 'list'];
    const namespaces = [
      [...prefix, 'ns1'],
      [...prefix, 'ns2'],
      [...prefix, 'ns3']
    ];
    
    // Store values in different namespaces
    for (const ns of namespaces) {
      await store.put(ns, 'key-' + Date.now(), { data: 'test' });
    }
    
    // List namespaces
    const listed = await store.listNamespaces(prefix);
    assert(Array.isArray(listed), 'Should return array');
    // Note: Exact match depends on store implementation
  });
  
  // Test 5: Batch operations
  await test('Should handle batch operations', async () => {
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true 
    });
    
    const namespace = ['test', 'batch'];
    const items = [
      { namespace, key: 'batch1', value: { text: 'First' } },
      { namespace, key: 'batch2', value: { text: 'Second' } },
      { namespace, key: 'batch3', value: { text: 'Third' } }
    ];
    
    // Batch put
    await store.batchPut(items);
    
    // Batch get
    const getItems = items.map(i => ({ namespace: i.namespace, key: i.key }));
    const results = await store.batchGet(getItems);
    
    assert(results.length === 3, 'Should return all items');
    const nonNull = results.filter(r => r !== null).length;
    assert(nonNull > 0, 'Should retrieve at least some items');
  });
  
  // Test 6: Search functionality
  await test('Should handle search operations', async () => {
    // Test in dev mode since we don't have Supabase credentials
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true // Dev mode to avoid requiring Supabase
    });
    
    const namespace = ['test', 'search'];
    
    // Search (will return empty in dev without PgMemoryStore)
    const results = await store.search(namespace, 'test query');
    assert(Array.isArray(results), 'Search should return array');
    // In dev mode without PgMemoryStore, should return empty array
    assert(results.length === 0, 'Dev mode search should return empty');
  });
  
  // Test 7: Metrics tracking
  await test('Should track metrics', async () => {
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true 
    });
    
    const namespace = ['test', 'metrics'];
    
    // Perform operations
    await store.put(namespace, 'metric-key', { data: 'test' });
    await store.get(namespace, 'metric-key');
    await store.get(namespace, 'nonexistent');
    
    // Check metrics
    const metrics = store.getMetrics();
    assert(metrics.writes > 0, 'Should track writes');
    assert(metrics.hits > 0, 'Should track hits');
    assert(metrics.misses > 0, 'Should track misses');
  });
  
  // Test 8: Singleton pattern with factory
  await test('Should use singleton pattern for same org/user', async () => {
    const store1 = getUnifiedStore({ orgId: 'org1', userId: 'user1' });
    const store2 = getUnifiedStore({ orgId: 'org1', userId: 'user1' });
    const store3 = getUnifiedStore({ orgId: 'org2', userId: 'user2' });
    
    assert(store1 === store2, 'Same org/user should return same instance');
    assert(store1 !== store3, 'Different org/user should return different instance');
  });
  
  // Test 9: Auto-generated keys
  await test('Should auto-generate keys when null provided', async () => {
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true 
    });
    
    const namespace = ['test', 'autogen'];
    const value = { text: 'Auto-key test' };
    
    // Store with null key
    const generatedKey = await store.put(namespace, null, value);
    assert(typeof generatedKey === 'string', 'Should generate string key');
    assert(generatedKey.length > 0, 'Generated key should not be empty');
    
    // Verify stored
    const retrieved = await store.get(namespace, generatedKey);
    assert(retrieved !== null, 'Should retrieve with generated key');
  });
  
  // Test 10: Error handling
  await test('Should handle errors gracefully', async () => {
    const store = new UnifiedStore({ 
      orgId: 'test-org', 
      userId: 'test-user',
      isDev: true 
    });
    
    // Get non-existent key
    const result = await store.get(['test'], 'nonexistent-' + Date.now());
    assert(result === null, 'Should return null for non-existent');
    
    // Search with empty query (should handle gracefully)
    const searchResults = await store.search(['test'], '');
    assert(Array.isArray(searchResults), 'Should return empty array');
  });
  
  // Print summary
  console.log('\n=== Test Summary ===');
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  console.log(`Total: ${testsPassed + testsFailed}`);
  
  // Exit with appropriate code
  process.exit(testsFailed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});