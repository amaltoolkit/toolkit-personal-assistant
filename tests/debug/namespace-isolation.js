/**
 * Test Namespace Isolation Fix
 * 
 * Verifies that the new ltm_semantic_search_v2 function properly isolates
 * memories by org_id and user_id, preventing cross-namespace contamination
 */

require('dotenv').config();
const { PgMemoryStore } = require('../memory/storeAdapter');
const crypto = require('crypto');

// Test organizations and users
const TEST_DATA = {
  org1: {
    id: 'test-org-001',
    users: ['user-001', 'user-002']
  },
  org2: {
    id: 'test-org-002',
    users: ['user-001', 'user-003']  // Note: user-001 exists in both orgs
  }
};

/**
 * Setup test data across multiple namespaces
 */
async function setupTestData() {
  console.log('📋 Setting up test data across namespaces...\n');
  
  const memories = [];
  
  // Create memories for org1/user-001
  const store1 = new PgMemoryStore(TEST_DATA.org1.id, TEST_DATA.org1.users[0]);
  await store1.put(
    [TEST_DATA.org1.id, TEST_DATA.org1.users[0], 'memories'],
    crypto.randomUUID(),
    {
      text: 'Organization 1 User 1 prefers morning meetings',
      kind: 'preference',
      importance: 4
    },
    { source: 'test', ttlDays: 1, index: true }
  );
  memories.push({ org: 'org1', user: 'user-001', text: 'morning meetings' });
  
  // Create memories for org1/user-002
  const store2 = new PgMemoryStore(TEST_DATA.org1.id, TEST_DATA.org1.users[1]);
  await store2.put(
    [TEST_DATA.org1.id, TEST_DATA.org1.users[1], 'memories'],
    crypto.randomUUID(),
    {
      text: 'Organization 1 User 2 works at TechCorp',
      kind: 'fact',
      importance: 3
    },
    { source: 'test', ttlDays: 1, index: true }
  );
  memories.push({ org: 'org1', user: 'user-002', text: 'TechCorp' });
  
  // Create memories for org2/user-001 (same user ID, different org)
  const store3 = new PgMemoryStore(TEST_DATA.org2.id, TEST_DATA.org2.users[0]);
  await store3.put(
    [TEST_DATA.org2.id, TEST_DATA.org2.users[0], 'memories'],
    crypto.randomUUID(),
    {
      text: 'Organization 2 User 1 prefers afternoon meetings',
      kind: 'preference',
      importance: 4
    },
    { source: 'test', ttlDays: 1, index: true }
  );
  memories.push({ org: 'org2', user: 'user-001', text: 'afternoon meetings' });
  
  // Create memories for org2/user-003
  const store4 = new PgMemoryStore(TEST_DATA.org2.id, TEST_DATA.org2.users[1]);
  await store4.put(
    [TEST_DATA.org2.id, TEST_DATA.org2.users[1], 'memories'],
    crypto.randomUUID(),
    {
      text: 'Organization 2 User 3 works at DataCorp',
      kind: 'fact',
      importance: 3
    },
    { source: 'test', ttlDays: 1, index: true }
  );
  memories.push({ org: 'org2', user: 'user-003', text: 'DataCorp' });
  
  console.log('Created 4 test memories across 2 organizations\n');
  
  // Wait for embeddings to be generated
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  return memories;
}

/**
 * Test namespace isolation with semantic search
 */
async function testNamespaceIsolation() {
  console.log('🔒 Testing Namespace Isolation\n');
  console.log('=' .repeat(50) + '\n');
  
  const results = {
    passed: 0,
    failed: 0,
    tests: []
  };
  
  // Test 1: Org1/User1 should only see their own memories
  console.log('Test 1: Org1/User1 searches for "meetings"');
  const store1 = new PgMemoryStore(TEST_DATA.org1.id, TEST_DATA.org1.users[0]);
  const search1 = await store1.search(
    [TEST_DATA.org1.id, TEST_DATA.org1.users[0], 'memories'],
    { query: 'meetings', limit: 10 }
  );
  
  console.log(`  Found ${search1.length} memories`);
  const hasCorrectMemory = search1.some(m => m.value.text.includes('morning meetings'));
  const hasWrongMemory = search1.some(m => m.value.text.includes('afternoon meetings'));
  
  if (hasCorrectMemory && !hasWrongMemory && search1.length === 1) {
    console.log('  ✅ Correctly found only morning meetings (Org1/User1)');
    results.passed++;
  } else {
    console.log('  ❌ Failed - found wrong memories or wrong count');
    if (hasWrongMemory) console.log('     ERROR: Found Org2 memories!');
    results.failed++;
  }
  results.tests.push({ name: 'Org1/User1 isolation', passed: hasCorrectMemory && !hasWrongMemory });
  
  // Test 2: Org2/User1 should see different memories (same user ID, different org)
  console.log('\nTest 2: Org2/User1 searches for "meetings" (same user ID, different org)');
  const store2 = new PgMemoryStore(TEST_DATA.org2.id, TEST_DATA.org2.users[0]);
  const search2 = await store2.search(
    [TEST_DATA.org2.id, TEST_DATA.org2.users[0], 'memories'],
    { query: 'meetings', limit: 10 }
  );
  
  console.log(`  Found ${search2.length} memories`);
  const hasAfternoon = search2.some(m => m.value.text.includes('afternoon meetings'));
  const hasMorning = search2.some(m => m.value.text.includes('morning meetings'));
  
  if (hasAfternoon && !hasMorning && search2.length === 1) {
    console.log('  ✅ Correctly found only afternoon meetings (Org2/User1)');
    results.passed++;
  } else {
    console.log('  ❌ Failed - cross-org contamination detected');
    if (hasMorning) console.log('     ERROR: Found Org1 memories!');
    results.failed++;
  }
  results.tests.push({ name: 'Cross-org isolation', passed: hasAfternoon && !hasMorning });
  
  // Test 3: Search for company names should be isolated
  console.log('\nTest 3: Org1/User2 searches for "Corp" (company names)');
  const store3 = new PgMemoryStore(TEST_DATA.org1.id, TEST_DATA.org1.users[1]);
  const search3 = await store3.search(
    [TEST_DATA.org1.id, TEST_DATA.org1.users[1], 'memories'],
    { query: 'Corp', limit: 10 }
  );
  
  console.log(`  Found ${search3.length} memories`);
  const hasTechCorp = search3.some(m => m.value.text.includes('TechCorp'));
  const hasDataCorp = search3.some(m => m.value.text.includes('DataCorp'));
  
  if (hasTechCorp && !hasDataCorp) {
    console.log('  ✅ Correctly found only TechCorp (Org1/User2)');
    results.passed++;
  } else {
    console.log('  ❌ Failed - found wrong company data');
    if (hasDataCorp) console.log('     ERROR: Found Org2 company data!');
    results.failed++;
  }
  results.tests.push({ name: 'Company data isolation', passed: hasTechCorp && !hasDataCorp });
  
  // Test 4: Test text search (non-semantic)
  console.log('\nTest 4: Text search isolation');
  const search4 = await store1.searchByText(
    [TEST_DATA.org1.id, TEST_DATA.org1.users[0], 'memories'],
    { text: 'morning', limit: 10 }
  );
  
  console.log(`  Found ${search4.length} memories via text search`);
  const textSearchCorrect = search4.length === 1 && 
    search4[0].value.text.includes('morning meetings');
  
  if (textSearchCorrect) {
    console.log('  ✅ Text search correctly isolated');
    results.passed++;
  } else {
    console.log('  ❌ Text search isolation failed');
    results.failed++;
  }
  results.tests.push({ name: 'Text search isolation', passed: textSearchCorrect });
  
  // Test 5: Empty search should return nothing from other namespaces
  console.log('\nTest 5: Searching in non-existent namespace');
  const store5 = new PgMemoryStore('non-existent-org', 'non-existent-user');
  const search5 = await store5.search(
    ['non-existent-org', 'non-existent-user', 'memories'],
    { query: 'meetings', limit: 10 }
  );
  
  console.log(`  Found ${search5.length} memories`);
  if (search5.length === 0) {
    console.log('  ✅ Correctly found no memories in non-existent namespace');
    results.passed++;
  } else {
    console.log('  ❌ Found memories from other namespaces!');
    results.failed++;
  }
  results.tests.push({ name: 'Non-existent namespace', passed: search5.length === 0 });
  
  return results;
}

/**
 * Cleanup test data
 */
async function cleanupTestData() {
  console.log('\n🧹 Cleaning up test data...');
  
  for (const org of Object.values(TEST_DATA)) {
    for (const userId of org.users) {
      const store = new PgMemoryStore(org.id, userId);
      const namespace = [org.id, userId, 'memories'];
      
      // Use text search to find all test memories
      const memories = await store.searchByText(namespace, { text: '', limit: 100 });
      
      for (const memory of memories) {
        await store.delete(namespace, memory.key);
      }
    }
  }
  
  console.log('  Cleanup complete\n');
}

/**
 * Run all namespace isolation tests
 */
async function runTests() {
  console.log('🚀 Namespace Isolation Test Suite');
  console.log('==================================\n');
  console.log('Testing the new ltm_semantic_search_v2 function');
  console.log('with proper org_id/user_id isolation\n');
  
  try {
    // Setup test data
    await setupTestData();
    
    // Run isolation tests
    const results = await testNamespaceIsolation();
    
    // Summary
    console.log('\n' + '=' .repeat(50));
    console.log('📊 Test Results Summary\n');
    
    results.tests.forEach(test => {
      console.log(`  ${test.name}: ${test.passed ? '✅ PASSED' : '❌ FAILED'}`);
    });
    
    console.log(`\nTotal: ${results.passed}/${results.passed + results.failed} tests passed`);
    
    // Cleanup
    await cleanupTestData();
    
    if (results.failed === 0) {
      console.log('🎉 All namespace isolation tests passed!');
      console.log('\nThe namespace isolation fix is working correctly.');
      console.log('Memories are now properly isolated by org_id and user_id.');
      process.exit(0);
    } else {
      console.log('⚠️ Some tests failed. Namespace isolation may still have issues.');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Test suite failed:', error);
    await cleanupTestData();
    process.exit(1);
  }
}

// Run tests if executed directly
if (require.main === module) {
  runTests();
}

module.exports = {
  setupTestData,
  testNamespaceIsolation,
  cleanupTestData
};