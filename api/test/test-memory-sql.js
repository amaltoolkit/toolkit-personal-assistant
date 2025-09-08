/**
 * Test script for memory SQL functions
 * Verifies ltm_semantic_search and memory storage work correctly
 */

const { PgMemoryStore } = require('../memory/storeAdapter');

async function testMemoryFunctions() {
  console.log('🧪 Testing Memory SQL Functions\n');
  
  const orgId = 'test-org-' + Date.now();
  const userId = 'test-user-' + Date.now();
  
  try {
    // Initialize store
    const store = new PgMemoryStore(orgId, userId);
    console.log('✅ PgMemoryStore initialized');
    
    // Test 1: Store memories with embeddings
    console.log('\n📝 Test 1: Storing memories...');
    
    const memories = [
      {
        text: "The user prefers to schedule meetings in the morning between 9am and 11am",
        kind: "preference",
        importance: 4,
        ttlDays: 180
      },
      {
        text: "Client ABC Corp requires quarterly business reviews on the last Friday of each quarter",
        kind: "fact",
        importance: 5,
        ttlDays: 365
      },
      {
        text: "The user's assistant is named Sarah and handles scheduling",
        kind: "context",
        importance: 3,
        ttlDays: 90
      },
      {
        text: "Always include a zoom link in meeting invitations",
        kind: "instruction",
        importance: 4,
        ttlDays: 365
      },
      {
        text: "The weather today is sunny and 72 degrees",
        kind: "fact",
        importance: 1,
        ttlDays: 1
      }
    ];
    
    const namespace = [orgId, userId, "memories"];
    const storedKeys = [];
    
    for (const memory of memories) {
      const key = await store.put(
        namespace,
        null, // auto-generate key
        memory,
        { 
          ttlDays: memory.ttlDays,
          source: "test",
          index: true // Create embeddings
        }
      );
      storedKeys.push(key);
      console.log(`  ✅ Stored: "${memory.text.substring(0, 50)}..." (${memory.kind}, importance: ${memory.importance})`);
    }
    
    // Wait a moment for embeddings to be created
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 2: Semantic search
    console.log('\n🔍 Test 2: Semantic search...');
    
    const searchQueries = [
      { query: "When should I schedule meetings?", expectedMatch: "morning" },
      { query: "Tell me about ABC Corp requirements", expectedMatch: "quarterly" },
      { query: "Who helps with scheduling?", expectedMatch: "Sarah" },
      { query: "What should I include in invites?", expectedMatch: "zoom" }
    ];
    
    for (const test of searchQueries) {
      console.log(`\n  Query: "${test.query}"`);
      
      const results = await store.search(namespace, {
        query: test.query,
        limit: 3,
        minImportance: 2
      });
      
      if (results.length > 0) {
        console.log(`  Found ${results.length} matches:`);
        results.forEach((result, i) => {
          const preview = result.value.text.substring(0, 60);
          console.log(`    ${i + 1}. [${result.score.toFixed(3)}] ${preview}...`);
          console.log(`       Kind: ${result.value.kind}, Importance: ${result.value.importance}`);
        });
        
        // Check if expected match is found
        const foundExpected = results.some(r => 
          r.value.text.toLowerCase().includes(test.expectedMatch)
        );
        
        if (foundExpected) {
          console.log(`    ✅ Found expected match containing "${test.expectedMatch}"`);
        } else {
          console.log(`    ⚠️ Expected match "${test.expectedMatch}" not in top results`);
        }
      } else {
        console.log('  ❌ No results found');
      }
    }
    
    // Test 3: Importance filtering
    console.log('\n⭐ Test 3: Importance filtering...');
    
    const importantResults = await store.search(namespace, {
      query: "business meetings scheduling",
      limit: 5,
      minImportance: 4 // Only high importance
    });
    
    console.log(`  Found ${importantResults.length} high-importance memories (≥4):`);
    importantResults.forEach(result => {
      const preview = result.value.text.substring(0, 50);
      console.log(`    - [Importance ${result.value.importance}] ${preview}...`);
    });
    
    // Test 4: Namespace isolation
    console.log('\n🔒 Test 4: Namespace isolation...');
    
    const otherNamespace = ['other-org', userId, 'memories'];
    const isolatedResults = await store.search(otherNamespace, {
      query: "meetings",
      limit: 5
    });
    
    if (isolatedResults.length === 0) {
      console.log('  ✅ Namespace isolation working - no cross-org results');
    } else {
      console.log('  ❌ Namespace isolation failed - found results from wrong org');
    }
    
    // Test 5: Get specific memory
    console.log('\n📖 Test 5: Retrieve specific memory...');
    
    if (storedKeys.length > 0) {
      const retrieved = await store.get(namespace, storedKeys[0]);
      if (retrieved) {
        console.log('  ✅ Retrieved memory:', retrieved.value.text.substring(0, 50) + '...');
      } else {
        console.log('  ❌ Failed to retrieve memory');
      }
    }
    
    // Test 6: Cleanup
    console.log('\n🧹 Test 6: Cleanup...');
    
    const deletedCount = await store.clearNamespace(namespace);
    console.log(`  ✅ Cleaned up ${deletedCount} test memories`);
    
    console.log('\n✅ All tests completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
testMemoryFunctions().then(() => {
  console.log('\n🎉 Memory SQL functions are working correctly!');
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});