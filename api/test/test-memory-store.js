// Test script for PgMemoryStore adapter
// Tests Store-compatible API with ltm_memories table

require('dotenv').config();
const { PgMemoryStore } = require('../memory/storeAdapter');

async function testPgMemoryStore() {
  console.log("=== PgMemoryStore Test Suite ===\n");
  
  try {
    // Initialize store with defaults
    const store = new PgMemoryStore("test_org", "test_user");
    console.log("✅ Store initialized successfully");
    
    // Test 1: Put and Get
    console.log("\nTest 1: Put and Get");
    console.log("-".repeat(30));
    
    const namespace = ["test_org", "test_user", "memories"];
    const testKey = `test-${Date.now()}`;
    const testValue = {
      text: "User prefers 30-minute meetings",
      kind: "user_pref",
      importance: 4
    };
    
    // Store a memory
    const storedKey = await store.put(namespace, testKey, testValue, {
      index: true,
      ttlDays: 30
    });
    console.log(`✅ Stored memory with key: ${storedKey}`);
    
    // Retrieve it
    const retrieved = await store.get(namespace, storedKey);
    if (retrieved && retrieved.value.text === testValue.text) {
      console.log("✅ Retrieved memory successfully");
      console.log(`  Text: ${retrieved.value.text}`);
      console.log(`  Kind: ${retrieved.value.kind}`);
      console.log(`  Importance: ${retrieved.value.importance}`);
    } else {
      console.error("❌ Failed to retrieve memory");
    }
    
    // Test 2: Search
    console.log("\nTest 2: Semantic Search");
    console.log("-".repeat(30));
    
    // Add more test memories
    await store.put(namespace, null, {
      text: "Assistant should be formal in tone",
      kind: "user_pref",
      importance: 3
    }, { index: true });
    
    await store.put(namespace, null, {
      text: "Client ABC Corp has budget of $50k",
      kind: "client_note",
      importance: 5
    }, { index: true });
    
    // Wait a moment for indexing
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Search for memories
    const searchResults = await store.search(namespace, {
      query: "meeting duration preferences",
      limit: 5,
      minImportance: 2
    });
    
    console.log(`Found ${searchResults.length} search results:`);
    for (const result of searchResults) {
      console.log(`  - Score: ${result.score.toFixed(3)}, Text: ${result.value.text.substring(0, 50)}...`);
    }
    
    if (searchResults.length > 0) {
      console.log("✅ Search functionality working");
    }
    
    // Test 3: List Namespaces
    console.log("\nTest 3: List Namespaces");
    console.log("-".repeat(30));
    
    const namespaces = await store.listNamespaces(["test_org"], 10);
    console.log(`Found ${namespaces.length} namespace(s):`);
    for (const ns of namespaces) {
      console.log(`  - [${ns.join(", ")}]`);
    }
    
    if (namespaces.length > 0) {
      console.log("✅ Namespace listing working");
    }
    
    // Test 4: Delete
    console.log("\nTest 4: Delete");
    console.log("-".repeat(30));
    
    const deleteResult = await store.delete(namespace, storedKey);
    if (deleteResult.deleted === 1) {
      console.log("✅ Memory deleted successfully");
    } else {
      console.error("❌ Failed to delete memory");
    }
    
    // Verify deletion
    const afterDelete = await store.get(namespace, storedKey);
    if (afterDelete === null) {
      console.log("✅ Confirmed memory is deleted");
    } else {
      console.error("❌ Memory still exists after deletion");
    }
    
    // Test 5: Namespace Isolation
    console.log("\nTest 5: Namespace Isolation");
    console.log("-".repeat(30));
    
    const otherNamespace = ["other_org", "other_user", "memories"];
    const isolatedKey = `isolated-${Date.now()}`;
    
    await store.put(otherNamespace, isolatedKey, {
      text: "This is in a different namespace",
      kind: "fact"
    });
    
    // Try to get from wrong namespace
    const wrongNamespaceGet = await store.get(namespace, isolatedKey);
    if (wrongNamespaceGet === null) {
      console.log("✅ Namespace isolation working - can't access other namespace's data");
    } else {
      console.error("❌ Namespace isolation failed - accessed data from wrong namespace");
    }
    
    // Clean up test data
    console.log("\nCleaning up test data...");
    const cleaned = await store.clearNamespace(["test_org"]);
    console.log(`✅ Cleaned up ${cleaned} test memories`);
    
    console.log("\n=== All Tests Complete ===");
    
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    console.error(error.stack);
  }
}

// Run tests
testPgMemoryStore().catch(console.error);