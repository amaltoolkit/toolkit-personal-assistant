/**
 * End-to-End Memory Flow Test
 * 
 * Tests the complete conversation cycle:
 * 1. User input → Memory recall → Action → Synthesis → Storage
 * 2. Second conversation recalls synthesized memories
 * 3. Verifies persistence and search accuracy
 */

require('dotenv').config();
const { getStore } = require('../graph/state');
const { recallMemoryNode } = require('../memory/recall');
const { synthesizeMemoryNode } = require('../memory/synthesize');
const { HumanMessage, AIMessage } = require('@langchain/core/messages');

// Test configuration
const TEST_ORG_ID = 'e2e-test-org';
const TEST_USER_ID = 'e2e-test-user';

/**
 * Simulate a complete conversation with memory operations
 */
async function testCompleteConversationFlow() {
  console.log('🧪 End-to-End Memory Flow Test');
  console.log('================================\n');
  
  // Ensure we get a properly initialized store with org/user context
  const { UnifiedStore } = require('../graph/unifiedStore');
  const store = new UnifiedStore({
    orgId: TEST_ORG_ID,
    userId: TEST_USER_ID,
    isDev: false // Force production mode to use PgMemoryStore
  });
  await store.ensureInitialized();
  const config = {
    configurable: {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      store,
      synthesis: {
        enableAutoSynthesis: true,
        synthesisInterval: 1, // Synthesize after every turn for testing
        minImportance: 2
      }
    }
  };
  
  const namespace = [TEST_ORG_ID, TEST_USER_ID, 'memories'];
  
  // Clean up any existing test data
  console.log('📧 Cleaning up previous test data...');
  try {
    const existingMemories = await store.search(namespace, { query: 'test', limit: 100 });
    for (const memory of existingMemories) {
      await store.delete(namespace, memory.key);
    }
  } catch (e) {
    // Ignore cleanup errors
  }
  
  console.log('\n=== Phase 1: First Conversation ===\n');
  
  // First conversation - introduce user information
  const conversation1 = {
    messages: [
      new HumanMessage("Hi, I'm Sarah Chen and I work at TechCorp as a Product Manager"),
      new AIMessage("Nice to meet you Sarah! I'll remember that you're a Product Manager at TechCorp."),
      new HumanMessage("I prefer video calls over phone calls, and I'm usually available Monday to Wednesday"),
      new AIMessage("Got it! I've noted your preference for video calls and your availability Monday through Wednesday."),
      new HumanMessage("Also, please always include agenda items in meeting invites"),
      new AIMessage("Absolutely! I'll make sure to always include agenda items when sending meeting invites.")
    ],
    artifacts: {
      turnCount: 3,
      actionsCompleted: ['noted_preferences'] // Trigger synthesis
    }
  };
  
  // Test recall (should find nothing initially)
  console.log('1️⃣ Testing initial recall (should be empty)...');
  const recall1 = await recallMemoryNode(conversation1, config);
  const recalledCount1 = recall1.artifacts?.recalledMemories?.length || 0;
  console.log(`   Recalled ${recalledCount1} memories\n`);
  
  // Synthesize memories from first conversation
  console.log('2️⃣ Synthesizing memories from conversation...');
  const synthesis1 = await synthesizeMemoryNode(conversation1, config);
  const synthesized = synthesis1.artifacts?.synthesizedMemories || [];
  console.log(`   Synthesized ${synthesized.length} memories:`);
  synthesized.forEach(m => {
    console.log(`   - [${m.kind}] "${m.text.substring(0, 60)}..."`);
  });
  
  // Wait a moment for consistency
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log('\n=== Phase 2: Second Conversation (Memory Recall) ===\n');
  
  // Second conversation - should recall previous information
  const conversation2 = {
    messages: [
      new HumanMessage("Can you schedule a meeting for me?")
    ]
  };
  
  // Test recall - should find synthesized memories
  console.log('3️⃣ Testing recall of synthesized memories...');
  const recall2 = await recallMemoryNode(conversation2, config);
  // Check if memories were added to messages as context
  const hasMemoryContext = recall2.messages && recall2.messages.length > 0 && 
    recall2.messages[0].content.includes('Memory Context');
  const recalledCount = recall2.artifacts?.recalledMemories?.length || 0;
  console.log(`   Recalled ${recalledCount} memories (context added: ${hasMemoryContext})`);
  
  if (hasMemoryContext) {
    // Parse memories from the system message
    const contextMessage = recall2.messages[0].content;
    const memoryLines = contextMessage.split('\n').filter(line => line.includes(':'));
    memoryLines.slice(1, 5).forEach(line => {
      console.log(`   - ${line.trim()}`);
    });
  }
  
  console.log('\n=== Phase 3: Semantic Search Test ===\n');
  
  // Test semantic search with various queries
  const searchQueries = [
    { query: "What's the user's name?", expected: "Sarah Chen" },
    { query: "meeting preferences", expected: "video calls" },
    { query: "availability schedule", expected: "Monday to Wednesday" },
    { query: "work information", expected: "TechCorp" }
  ];
  
  console.log('4️⃣ Testing semantic search accuracy...');
  let searchSuccess = 0;
  
  for (const test of searchQueries) {
    const results = await store.search(namespace, {
      query: test.query,
      limit: 3
    });
    
    const found = results.some(r => 
      r.value.text.toLowerCase().includes(test.expected.toLowerCase())
    );
    
    if (found) {
      console.log(`   ✅ "${test.query}" → Found "${test.expected}"`);
      searchSuccess++;
    } else {
      console.log(`   ❌ "${test.query}" → Missing "${test.expected}"`);
    }
  }
  
  console.log(`\n   Search accuracy: ${searchSuccess}/${searchQueries.length} (${(searchSuccess/searchQueries.length*100).toFixed(0)}%)`);
  
  console.log('\n=== Phase 4: Memory Persistence Test ===\n');
  
  // Create a new store instance (simulating restart)
  console.log('5️⃣ Creating new store instance (simulating restart)...');
  const { clearStoreCache, UnifiedStore: NewUnifiedStore } = require('../graph/unifiedStore');
  clearStoreCache();
  
  const newStore = new NewUnifiedStore({
    orgId: TEST_ORG_ID,
    userId: TEST_USER_ID,
    isDev: false
  });
  await newStore.ensureInitialized();
  const newConfig = {
    configurable: {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      store: newStore
    }
  };
  
  // Check if memories persist
  const persistedMemories = await newStore.search(namespace, {
    query: "Sarah Chen TechCorp",
    limit: 10
  });
  
  console.log(`   Found ${persistedMemories.length} memories after restart`);
  
  if (persistedMemories.length > 0) {
    console.log('   ✅ Memories persisted across store instances');
  } else {
    console.log('   ❌ Memories not found after restart');
  }
  
  console.log('\n=== Phase 5: Namespace Isolation Test ===\n');
  
  // Test that memories are isolated by org/user
  console.log('6️⃣ Testing namespace isolation...');
  
  const otherOrgStore = new NewUnifiedStore({
    orgId: 'other-org',
    userId: 'other-user',
    isDev: false
  });
  await otherOrgStore.ensureInitialized();
  const otherNamespace = ['other-org', 'other-user', 'memories'];
  
  // Try to access memories from different namespace
  const crossNamespaceResults = await otherOrgStore.search(otherNamespace, {
    query: "Sarah Chen",
    limit: 10
  });
  
  if (crossNamespaceResults.length === 0) {
    console.log('   ✅ Namespace isolation working - no cross-contamination');
  } else {
    console.log('   ❌ Namespace isolation failed - found memories from other org/user');
  }
  
  // Store a memory in the other namespace
  await otherOrgStore.put(otherNamespace, 'test-other', {
    text: 'This is from a different organization',
    kind: 'fact',
    importance: 3
  }, {
    source: 'test',
    index: false
  });
  
  // Verify original namespace doesn't see it  
  // Use a very specific query that should only match the other org's memory
  const originalNamespaceCheck = await store.search(namespace, {
    query: "This is from a different organization",
    limit: 10
  });
  
  if (originalNamespaceCheck.length === 0) {
    console.log('   ✅ Original namespace protected from other orgs');
  } else {
    console.log('   ❌ Original namespace contaminated with other org data');
  }
  
  console.log('\n=== Test Summary ===\n');
  
  const testsPassed = [
    hasMemoryContext,  // Recall test
    searchSuccess >= 3,
    persistedMemories.length > 0,
    crossNamespaceResults.length === 0,
    originalNamespaceCheck.length === 0
  ];
  
  const totalPassed = testsPassed.filter(t => t).length;
  const totalTests = testsPassed.length;
  
  console.log(`Tests Passed: ${totalPassed}/${totalTests}`);
  console.log('- Initial synthesis:', synthesized.length > 0 ? '✅' : '❌');
  console.log('- Memory recall:', hasMemoryContext ? '✅' : '❌');
  console.log('- Semantic search:', searchSuccess >= 3 ? '✅' : '❌');
  console.log('- Persistence:', persistedMemories.length > 0 ? '✅' : '❌');
  console.log('- Namespace isolation:', crossNamespaceResults.length === 0 && originalNamespaceCheck.length === 0 ? '✅' : '❌');
  
  // Cleanup
  console.log('\n🧹 Cleaning up test data...');
  try {
    // Clean test namespace
    const allTestMemories = await store.search(namespace, { query: '', limit: 100 });
    for (const memory of allTestMemories) {
      await store.delete(namespace, memory.key);
    }
    
    // Clean other namespace
    await otherOrgStore.delete(otherNamespace, 'test-other');
    
    console.log('   Cleanup complete');
  } catch (e) {
    console.log('   Cleanup error:', e.message);
  }
  
  if (totalPassed === totalTests) {
    console.log('\n✅ All end-to-end tests passed!');
    return true;
  } else {
    console.log(`\n⚠️ ${totalTests - totalPassed} test(s) failed`);
    return false;
  }
}

/**
 * Test memory operations under concurrent load
 */
async function testConcurrentAccess() {
  console.log('\n🔄 Concurrent Access Test');
  console.log('==========================\n');
  
  const { UnifiedStore } = require('../graph/unifiedStore');
  const store = new UnifiedStore({
    orgId: 'concurrent-test',
    userId: 'user',
    isDev: false
  });
  await store.ensureInitialized();
  const namespace = ['concurrent-test', 'user', 'memories'];
  
  // Clean up first
  try {
    const existing = await store.search(namespace, { query: '', limit: 100 });
    for (const m of existing) {
      await store.delete(namespace, m.key);
    }
  } catch (e) {}
  
  console.log('Running 10 concurrent writes...');
  const writePromises = [];
  const startTime = Date.now();
  
  for (let i = 0; i < 10; i++) {
    writePromises.push(
      store.put(namespace, `concurrent-${i}`, {
        text: `Concurrent memory ${i}`,
        kind: 'fact',
        importance: 3
      }, {
        source: 'test',
        index: false
      })
    );
  }
  
  await Promise.all(writePromises);
  const writeTime = Date.now() - startTime;
  console.log(`   Completed in ${writeTime}ms (${(writeTime/10).toFixed(1)}ms per write)`);
  
  console.log('\nRunning 10 concurrent reads...');
  const readPromises = [];
  const readStart = Date.now();
  
  for (let i = 0; i < 10; i++) {
    readPromises.push(store.get(namespace, `concurrent-${i}`));
  }
  
  const results = await Promise.all(readPromises);
  const readTime = Date.now() - readStart;
  const successfulReads = results.filter(r => r !== null).length;
  
  console.log(`   Completed in ${readTime}ms (${(readTime/10).toFixed(1)}ms per read)`);
  console.log(`   Success rate: ${successfulReads}/10`);
  
  // Cleanup
  for (let i = 0; i < 10; i++) {
    await store.delete(namespace, `concurrent-${i}`);
  }
  
  return successfulReads === 10;
}

// Main test runner
async function runAllTests() {
  console.log('🚀 Starting Comprehensive Memory E2E Tests\n');
  console.log('=' .repeat(50));
  
  try {
    const flowTestPassed = await testCompleteConversationFlow();
    const concurrentTestPassed = await testConcurrentAccess();
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 Final Results:');
    console.log('- E2E Flow Test:', flowTestPassed ? '✅ PASSED' : '❌ FAILED');
    console.log('- Concurrent Access:', concurrentTestPassed ? '✅ PASSED' : '❌ FAILED');
    
    if (flowTestPassed && concurrentTestPassed) {
      console.log('\n🎉 All E2E tests passed successfully!');
      process.exit(0);
    } else {
      console.log('\n⚠️ Some tests failed. Check the output above.');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Test suite failed with error:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  runAllTests();
}

module.exports = {
  testCompleteConversationFlow,
  testConcurrentAccess
};