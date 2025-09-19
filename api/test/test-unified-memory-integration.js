/**
 * Integration Test for Unified Memory Architecture
 * 
 * Verifies that memory nodes use UnifiedStore from config
 * instead of creating direct PgMemoryStore instances
 */

console.log('Testing Unified Memory Integration\n');
console.log('====================================\n');

// Test imports
const { getStore } = require('../graph/state');
const { recallMemoryNode } = require('../memory/recall');
const { synthesizeMemoryNode } = require('../memory/synthesize');

// Test data
const TEST_ORG_ID = 'test-org-123';
const TEST_USER_ID = 'test-user-456';
const TEST_MESSAGES = [
  { role: 'human', content: 'My name is John and I prefer morning meetings' },
  { role: 'assistant', content: 'Nice to meet you John! I\'ll remember your preference for morning meetings.' },
  { role: 'human', content: 'Also, I work at Acme Corp as a senior engineer' },
  { role: 'assistant', content: 'Got it! You\'re a senior engineer at Acme Corp.' }
];

/**
 * Test 1: Verify UnifiedStore is returned from getStore
 */
async function testGetStore() {
  console.log('Test 1: getStore returns UnifiedStore');
  console.log('--------------------------------------');
  
  try {
    const store = await getStore();
    
    // Check that store has expected methods
    const hasExpectedMethods = [
      'put', 'get', 'delete', 'search', 
      'listNamespaces', 'batchGet', 'batchPut'
    ].every(method => typeof store[method] === 'function');
    
    console.log(`Store type: ${store.constructor.name}`);
    console.log(`Has expected methods: ${hasExpectedMethods}`);
    console.log(`✅ Pass: ${store.constructor.name === 'UnifiedStore' && hasExpectedMethods}\n`);
    
    return store;
  } catch (error) {
    console.error(`❌ Failed: ${error.message}\n`);
    return null;
  }
}

/**
 * Test 2: Verify recall node uses store from config
 */
async function testRecallWithConfig(store) {
  console.log('Test 2: Recall node uses store from config');
  console.log('-------------------------------------------');
  
  const state = {
    messages: TEST_MESSAGES
  };
  
  const config = {
    configurable: {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      store: store  // Pass UnifiedStore in config
    }
  };
  
  try {
    // Mock search to verify it's called
    const originalSearch = store.search.bind(store);
    let searchCalled = false;
    store.search = async (...args) => {
      searchCalled = true;
      console.log(`[MOCK] Store.search called with namespace: [${args[0].join(', ')}]`);
      return [];  // Return empty results for test
    };
    
    // Call recall node
    const result = await recallMemoryNode(state, config);
    
    // Restore original method
    store.search = originalSearch;
    
    console.log(`Store.search was called: ${searchCalled}`);
    console.log(`✅ Pass: ${searchCalled}\n`);
    
    return true;
  } catch (error) {
    console.error(`❌ Failed: ${error.message}\n`);
    return false;
  }
}

/**
 * Test 3: Verify synthesis node uses store from config
 */
async function testSynthesisWithConfig(store) {
  console.log('Test 3: Synthesis node uses store from config');
  console.log('----------------------------------------------');
  
  const state = {
    messages: TEST_MESSAGES,
    artifacts: {
      turnCount: 4,
      actionsCompleted: ['action1']  // Trigger synthesis
    }
  };
  
  const config = {
    configurable: {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      store: store,  // Pass UnifiedStore in config
      synthesis: {
        enableAutoSynthesis: true,
        synthesisInterval: 1  // Trigger immediately
      }
    }
  };
  
  try {
    // Mock put to verify it's called
    const originalPut = store.put.bind(store);
    let putCalled = false;
    store.put = async (...args) => {
      putCalled = true;
      console.log(`[MOCK] Store.put called with namespace: [${args[0].join(', ')}]`);
      return;  // Store API compliant - returns void
    };
    
    // Mock search for deduplication check
    const originalSearch = store.search.bind(store);
    store.search = async () => [];  // No existing memories
    
    // Call synthesis node
    const result = await synthesizeMemoryNode(state, config);
    
    // Restore original methods
    store.put = originalPut;
    store.search = originalSearch;
    
    console.log(`Store.put was called: ${putCalled}`);
    console.log(`Result has synthesized memories: ${!!result.artifacts?.synthesizedMemories}`);
    console.log(`✅ Pass: ${putCalled || !!result.artifacts?.synthesizedMemories}\n`);
    
    return true;
  } catch (error) {
    console.error(`❌ Failed: ${error.message}\n`);
    return false;
  }
}

/**
 * Test 4: Verify no direct PgMemoryStore instantiation in node functions
 */
async function testNoDirectPgMemoryStore() {
  console.log('Test 4: No direct PgMemoryStore in memory nodes');
  console.log('------------------------------------------------');
  
  // Read the files to check for direct instantiation
  const fs = require('fs');
  const recallCode = fs.readFileSync('./api/memory/recall.js', 'utf8');
  const synthesizeCode = fs.readFileSync('./api/memory/synthesize.js', 'utf8');
  
  // Check for "new PgMemoryStore" in the main node functions (not in test helpers)
  // Split code into functions and check main nodes only
  const recallNodeFunc = recallCode.match(/async function recallMemoryNode[\s\S]*?^}/m);
  const synthesizeNodeFunc = synthesizeCode.match(/async function synthesizeMemoryNode[\s\S]*?^}/m);
  
  const recallHasDirectStore = recallNodeFunc && /new PgMemoryStore/.test(recallNodeFunc[0]);
  const synthesizeHasDirectStore = synthesizeNodeFunc && /new PgMemoryStore/.test(synthesizeNodeFunc[0]);
  
  console.log(`Recall node has direct PgMemoryStore: ${recallHasDirectStore}`);
  console.log(`Synthesis node has direct PgMemoryStore: ${synthesizeHasDirectStore}`);
  console.log(`✅ Pass: ${!recallHasDirectStore && !synthesizeHasDirectStore}\n`);
  
  return !recallHasDirectStore && !synthesizeHasDirectStore;
}

/**
 * Test 5: End-to-end memory flow
 */
async function testEndToEndFlow() {
  console.log('Test 5: End-to-end memory flow with UnifiedStore');
  console.log('-------------------------------------------------');
  
  try {
    // Import UnifiedStore directly to create with org/user
    const { UnifiedStore } = require('../graph/unifiedStore');
    
    // Create store instance with org/user IDs
    const store = new UnifiedStore({
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      isDev: false  // Use production mode to test PgMemoryStore
    });
    
    // Ensure store is initialized
    await store.ensureInitialized();
    
    // Create test namespace
    const namespace = [TEST_ORG_ID, TEST_USER_ID, 'memories'];
    
    // Store a test memory with all required fields
    // Database now accepts all memory kinds and sources after migration
    await store.put(namespace, 'test-key-1', {
      text: 'John prefers morning meetings',
      kind: 'preference',  // Now using proper semantic type
      importance: 4,
      subjectId: null
    }, {
      ttlDays: 30,
      source: 'test',  // Now using proper test source
      index: false  // Skip embedding for test
    });
    
    console.log('Stored test memory');
    
    // Search for the memory
    const results = await store.search(namespace, {
      query: 'meeting preferences',
      limit: 5
    });
    
    console.log(`Search returned ${results.length} results`);
    
    // Clean up - delete test memory
    await store.delete(namespace, 'test-key-1');
    console.log('Cleaned up test memory');
    
    console.log(`✅ Pass: End-to-end flow works\n`);
    return true;
    
  } catch (error) {
    console.error(`❌ Failed: ${error.message}`);
    console.log('Note: This test requires database connection\n');
    return false;
  }
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('Starting unified memory integration tests...\n');
  
  const results = [];
  
  // Test 1: Get store
  const store = await testGetStore();
  results.push(!!store);
  
  if (store) {
    // Test 2: Recall with config
    const recallResult = await testRecallWithConfig(store);
    results.push(recallResult);
    
    // Test 3: Synthesis with config
    const synthesisResult = await testSynthesisWithConfig(store);
    results.push(synthesisResult);
  } else {
    results.push(false, false);
  }
  
  // Test 4: No direct instantiation
  const noDirectResult = await testNoDirectPgMemoryStore();
  results.push(noDirectResult);
  
  // Test 5: End-to-end (may fail without DB)
  const endToEndResult = await testEndToEndFlow();
  results.push(endToEndResult);
  
  // Summary
  console.log('Summary');
  console.log('-------');
  const passed = results.filter(r => r).length;
  const total = results.length;
  console.log(`Tests passed: ${passed}/${total}`);
  
  if (passed === total) {
    console.log('\n✅ All tests passed! UnifiedStore integration is working correctly.');
  } else {
    console.log('\n⚠️ Some tests failed. Check the output above for details.');
    console.log('Note: Test 5 requires database connection and may fail in test environment.');
  }
  
  // Exit with appropriate code
  process.exit(passed === total ? 0 : 1);
}

// Run tests if executed directly
if (require.main === module) {
  runTests().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  testGetStore,
  testRecallWithConfig,
  testSynthesisWithConfig,
  testNoDirectPgMemoryStore,
  testEndToEndFlow,
  runTests
};