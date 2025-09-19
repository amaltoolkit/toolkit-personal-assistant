/**
 * Test Database Schema Update - Verify all memory kinds and sources work
 */

const { UnifiedStore } = require('../graph/unifiedStore');
const crypto = require('crypto');

const TEST_ORG_ID = 'test-org-schema';
const TEST_USER_ID = 'test-user-schema';

async function testAllMemoryKinds() {
  console.log('Testing All Memory Kinds and Sources');
  console.log('=====================================\n');
  
  const store = new UnifiedStore({
    orgId: TEST_ORG_ID,
    userId: TEST_USER_ID,
    isDev: false
  });
  
  await store.ensureInitialized();
  
  const namespace = [TEST_ORG_ID, TEST_USER_ID, 'schema-test'];
  const testResults = [];
  
  // Test all memory kinds
  const memoryKinds = [
    { kind: 'fact', text: 'The company has 50 employees' },
    { kind: 'preference', text: 'User prefers email over phone calls' },
    { kind: 'instruction', text: 'Always CC the manager on important emails' },
    { kind: 'context', text: 'Currently working on Q4 planning' }
  ];
  
  // Test all sources
  const sources = ['manual', 'synthesis', 'test'];
  
  console.log('Testing Memory Kinds:');
  console.log('--------------------');
  
  for (const memory of memoryKinds) {
    try {
      const key = crypto.randomUUID();
      await store.put(namespace, key, {
        text: memory.text,
        kind: memory.kind,
        importance: 3,
        subjectId: null
      }, {
        ttlDays: 30,
        source: 'test',
        index: false
      });
      
      console.log(`✅ ${memory.kind.padEnd(12)} - Successfully stored`);
      testResults.push({ kind: memory.kind, success: true });
      
      // Clean up
      await store.delete(namespace, key);
    } catch (error) {
      console.log(`❌ ${memory.kind.padEnd(12)} - Failed: ${error.message}`);
      testResults.push({ kind: memory.kind, success: false, error: error.message });
    }
  }
  
  console.log('\nTesting Memory Sources:');
  console.log('----------------------');
  
  for (const source of sources) {
    try {
      const key = crypto.randomUUID();
      await store.put(namespace, key, {
        text: `Test memory for source: ${source}`,
        kind: 'fact',
        importance: 3,
        subjectId: null
      }, {
        ttlDays: 30,
        source: source,
        index: false
      });
      
      console.log(`✅ ${source.padEnd(12)} - Successfully stored`);
      testResults.push({ source: source, success: true });
      
      // Clean up
      await store.delete(namespace, key);
    } catch (error) {
      console.log(`❌ ${source.padEnd(12)} - Failed: ${error.message}`);
      testResults.push({ source: source, success: false, error: error.message });
    }
  }
  
  // Test legacy values (should still work)
  console.log('\nTesting Legacy Values (backward compatibility):');
  console.log('----------------------------------------------');
  
  const legacyKinds = ['user_pref', 'team_info', 'client_note'];
  const legacySources = ['auto', 'suggested'];
  
  for (const kind of legacyKinds) {
    try {
      const key = crypto.randomUUID();
      await store.put(namespace, key, {
        text: `Legacy kind test: ${kind}`,
        kind: kind,
        importance: 3,
        subjectId: null
      }, {
        ttlDays: 30,
        source: 'manual',
        index: false
      });
      
      console.log(`✅ ${kind.padEnd(12)} - Legacy kind still works`);
      await store.delete(namespace, key);
    } catch (error) {
      console.log(`❌ ${kind.padEnd(12)} - Failed: ${error.message}`);
    }
  }
  
  for (const source of legacySources) {
    try {
      const key = crypto.randomUUID();
      await store.put(namespace, key, {
        text: `Legacy source test: ${source}`,
        kind: 'fact',
        importance: 3,
        subjectId: null
      }, {
        ttlDays: 30,
        source: source,
        index: false
      });
      
      console.log(`✅ ${source.padEnd(12)} - Legacy source still works`);
      await store.delete(namespace, key);
    } catch (error) {
      console.log(`❌ ${source.padEnd(12)} - Failed: ${error.message}`);
    }
  }
  
  // Summary
  const allSuccess = testResults.every(r => r.success);
  console.log('\n' + '='.repeat(45));
  console.log(allSuccess ? 
    '✅ All schema tests passed! Database constraints updated successfully.' :
    '⚠️ Some tests failed. Check the errors above.'
  );
  
  return allSuccess;
}

// Run tests if executed directly
if (require.main === module) {
  testAllMemoryKinds()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { testAllMemoryKinds };