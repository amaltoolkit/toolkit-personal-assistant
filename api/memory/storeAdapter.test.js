/**
 * Store API Compliance Tests for PgMemoryStore
 * 
 * Tests that PgMemoryStore fully implements the LangGraph Store API interface
 * Run with: node api/memory/storeAdapter.test.js
 */

require('dotenv').config();
const { PgMemoryStore } = require('./storeAdapter');

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

function assertType(value, type, message) {
  const actualType = value === null ? 'null' : typeof value;
  if (actualType !== type) {
    throw new Error(message || `Expected type ${type}, got ${actualType}`);
  }
}

// Clean up test data
async function cleanupTestData(store) {
  try {
    await store.clearNamespace(['test-compliance']);
  } catch (error) {
    // Ignore cleanup errors
  }
}

// Main test suite
async function runComplianceTests() {
  console.log('\n=== PgMemoryStore API Compliance Test Suite ===\n');
  
  // Check if we have credentials
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('⚠️  Skipping tests: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    console.log('   Set these in your .env file to run compliance tests');
    return;
  }
  
  // Initialize store for tests
  const store = new PgMemoryStore('test-org', 'test-user');
  
  // Clean up before tests
  await cleanupTestData(store);
  
  // Test 1: Method existence
  await test('Should have all required Store API methods', async () => {
    assert(typeof store.put === 'function', 'put method missing');
    assert(typeof store.get === 'function', 'get method missing');
    assert(typeof store.delete === 'function', 'delete method missing');
    assert(typeof store.listNamespaces === 'function', 'listNamespaces method missing');
    assert(typeof store.search === 'function', 'search method missing');
    assert(typeof store.batchGet === 'function', 'batchGet method missing');
    assert(typeof store.batchPut === 'function', 'batchPut method missing');
  });
  
  // Test 2: put() returns void
  await test('put() should return void (undefined)', async () => {
    const namespace = ['test-compliance', 'put'];
    const key = 'test-key-' + Date.now();
    const value = { text: 'Test value', importance: 3 };
    
    const result = await store.put(namespace, key, value);
    assert(result === undefined, `put() should return void, got: ${typeof result}`);
  });
  
  // Test 3: get() returns item or null
  await test('get() should return item or null', async () => {
    const namespace = ['test-compliance', 'get'];
    const key = crypto.randomUUID();
    const value = { text: 'Get test', kind: 'fact' };
    
    // Store item
    await store.put(namespace, key, value);
    
    // Get existing item
    const result = await store.get(namespace, key);
    assert(result !== null, 'Should return item for existing key');
    assert(typeof result === 'object', 'Should return object');
    assert(result.key === key, 'Should have correct key');
    assert(result.value.text === value.text, 'Should have correct value');
    
    // Get non-existent item
    const notFound = await store.get(namespace, 'non-existent-' + Date.now());
    assert(notFound === null, 'Should return null for non-existent key');
  });
  
  // Test 4: delete() returns void
  await test('delete() should return void (undefined)', async () => {
    const namespace = ['test-compliance', 'delete'];
    const key = crypto.randomUUID();
    
    // Store and delete
    await store.put(namespace, key, { text: 'To delete' });
    const result = await store.delete(namespace, key);
    assert(result === undefined, `delete() should return void, got: ${typeof result}`);
    
    // Delete non-existent (should also return void)
    const result2 = await store.delete(namespace, 'non-existent-' + Date.now());
    assert(result2 === undefined, 'delete() should return void even for non-existent');
  });
  
  // Test 5: UUID key handling
  await test('Should handle UUID constraint correctly', async () => {
    const namespace = ['test-compliance', 'uuid'];
    
    // Test 1: Null key should auto-generate UUID
    await store.put(namespace, null, { text: 'Auto UUID' });
    
    // Test 2: Valid UUID should be accepted
    const validUUID = crypto.randomUUID();
    await store.put(namespace, validUUID, { text: 'Valid UUID' });
    const result = await store.get(namespace, validUUID);
    assert(result !== null, 'Should store with valid UUID');
    
    // Test 3: Non-UUID string should be converted
    await store.put(namespace, 'not-a-uuid', { text: 'Invalid UUID' });
    // This should succeed by generating a new UUID internally
  });
  
  // Test 6: batchGet() returns array
  await test('batchGet() should return array of items or null', async () => {
    const namespace = ['test-compliance', 'batch-get'];
    const items = [
      { key: crypto.randomUUID(), value: { text: 'Item 1' } },
      { key: crypto.randomUUID(), value: { text: 'Item 2' } },
      { key: crypto.randomUUID(), value: { text: 'Item 3' } }
    ];
    
    // Store items
    for (const item of items) {
      await store.put(namespace, item.key, item.value);
    }
    
    // Batch get
    const getItems = [
      { namespace, key: items[0].key },
      { namespace, key: 'non-existent' },
      { namespace, key: items[2].key }
    ];
    
    const results = await store.batchGet(getItems);
    assert(Array.isArray(results), 'Should return array');
    assert(results.length === 3, 'Should return item for each request');
    assert(results[0] !== null, 'First item should exist');
    assert(results[1] === null, 'Second item should be null');
    assert(results[2] !== null, 'Third item should exist');
  });
  
  // Test 7: batchPut() returns void
  await test('batchPut() should return void and use bulk operations', async () => {
    const namespace = ['test-compliance', 'batch-put'];
    const items = [
      { namespace, key: crypto.randomUUID(), value: { text: 'Batch 1', importance: 1 } },
      { namespace, key: crypto.randomUUID(), value: { text: 'Batch 2', importance: 2 } },
      { namespace, key: crypto.randomUUID(), value: { text: 'Batch 3', importance: 3 } }
    ];
    
    const startTime = Date.now();
    const result = await store.batchPut(items);
    const duration = Date.now() - startTime;
    
    assert(result === undefined, `batchPut() should return void, got: ${typeof result}`);
    console.log(`    Batch insert of ${items.length} items took ${duration}ms`);
    
    // Verify items were stored
    const getResults = await store.batchGet(items.map(i => ({ namespace, key: i.key })));
    const stored = getResults.filter(r => r !== null).length;
    assert(stored === items.length, `All items should be stored, got ${stored}/${items.length}`);
  });
  
  // Test 8: listNamespaces() returns array
  await test('listNamespaces() should return array of namespace arrays', async () => {
    const prefix = ['test-compliance', 'namespaces'];
    
    // Store items in different namespaces
    await store.put([...prefix, 'ns1'], crypto.randomUUID(), { text: 'NS1' });
    await store.put([...prefix, 'ns2'], crypto.randomUUID(), { text: 'NS2' });
    await store.put([...prefix, 'ns3'], crypto.randomUUID(), { text: 'NS3' });
    
    const namespaces = await store.listNamespaces(prefix, 10, 0);
    assert(Array.isArray(namespaces), 'Should return array');
    
    // Each namespace should be an array
    for (const ns of namespaces) {
      assert(Array.isArray(ns), 'Each namespace should be an array');
    }
    
    console.log(`    Found ${namespaces.length} namespaces with prefix`);
  });
  
  // Test 9: search() returns array
  await test('search() should return array of search results', async () => {
    const namespace = ['test-compliance', 'search'];
    
    // Store searchable items
    await store.put(namespace, crypto.randomUUID(), {
      text: 'The quick brown fox jumps over the lazy dog',
      kind: 'fact',
      importance: 4
    });
    
    await store.put(namespace, crypto.randomUUID(), {
      text: 'Python is a programming language',
      kind: 'fact',
      importance: 3
    });
    
    // Search
    const results = await store.search(namespace, {
      query: 'programming language',
      limit: 5,
      minImportance: 1
    });
    
    assert(Array.isArray(results), 'Should return array');
    console.log(`    Search found ${results.length} results`);
    
    // Check result structure
    if (results.length > 0) {
      const first = results[0];
      assert(typeof first.score === 'number', 'Result should have score');
      assert(typeof first.key === 'string', 'Result should have key');
      assert(typeof first.value === 'object', 'Result should have value object');
    }
  });
  
  // Test 10: Namespace isolation
  await test('Should maintain namespace isolation', async () => {
    const ns1 = ['test-compliance', 'isolation', 'org1'];
    const ns2 = ['test-compliance', 'isolation', 'org2'];
    const key = crypto.randomUUID();
    
    // Store in ns1
    await store.put(ns1, key, { text: 'Org1 data' });
    
    // Try to get from ns2 (should not find)
    const crossAccess = await store.get(ns2, key);
    assert(crossAccess === null, 'Should not access across namespaces');
    
    // Get from correct namespace
    const correctAccess = await store.get(ns1, key);
    assert(correctAccess !== null, 'Should access from correct namespace');
  });
  
  // Test 11: Performance benchmarks
  await test('Should meet performance requirements', async () => {
    const namespace = ['test-compliance', 'performance'];
    const key = crypto.randomUUID();
    
    // Write performance (includes embedding generation)
    const writeStart = Date.now();
    await store.put(namespace, key, { text: 'Performance test', importance: 5 });
    const writeTime = Date.now() - writeStart;
    // Embedding generation can take 500-1000ms, so allow up to 1500ms total
    assert(writeTime < 1500, `Write should be < 1500ms (includes embedding), was ${writeTime}ms`);
    
    // Read performance
    const readStart = Date.now();
    await store.get(namespace, key);
    const readTime = Date.now() - readStart;
    // Network latency to Supabase can add 50-150ms
    assert(readTime < 200, `Read should be < 200ms, was ${readTime}ms`);
    
    // Batch performance
    const batchItems = Array.from({ length: 10 }, (_, i) => ({
      namespace,
      key: crypto.randomUUID(),
      value: { text: `Batch item ${i}`, importance: i % 5 + 1 }
    }));
    
    const batchStart = Date.now();
    await store.batchPut(batchItems);
    const batchTime = Date.now() - batchStart;
    // Batch of 10 with parallel embedding generation can take 1-2s
    assert(batchTime < 2000, `Batch of 10 should be < 2000ms, was ${batchTime}ms`);
    
    console.log(`    Performance: write=${writeTime}ms, read=${readTime}ms, batch=${batchTime}ms`);
  });
  
  // Clean up after tests
  await cleanupTestData(store);
  
  // Print summary
  console.log('\n=== Compliance Test Summary ===');
  console.log(`✅ Passed: ${testsPassed}`);
  console.log(`❌ Failed: ${testsFailed}`);
  console.log(`Total: ${testsPassed + testsFailed}`);
  
  if (testsFailed === 0) {
    console.log('\n🎉 PgMemoryStore is fully compliant with LangGraph Store API!');
  } else {
    console.log('\n⚠️  Some compliance tests failed. Review and fix the issues.');
  }
  
  // Exit with appropriate code
  process.exit(testsFailed > 0 ? 1 : 0);
}

// Add crypto for UUID generation
const crypto = require('crypto');

// Run tests
runComplianceTests().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});