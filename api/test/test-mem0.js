/**
 * Mem0 Connection Test Script
 * Tests basic Mem0 operations to verify API key and connectivity
 */

require('dotenv').config();

// Clear the module cache to ensure fresh initialization with env vars
delete require.cache[require.resolve('../services/mem0Service')];

const { getMem0Service } = require('../services/mem0Service');

// Test configuration
const TEST_ORG_ID = 'test-org-123';
const TEST_USER_ID = 'test-user-456';
const TEST_MEMORY_ID = `${TEST_ORG_ID}:${TEST_USER_ID}`;

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testMem0Connection() {
  log('\n=== Mem0 Connection Test ===\n', 'blue');
  
  // Check if API key is configured
  if (!process.env.MEM0_API_KEY) {
    log('❌ MEM0_API_KEY not found in environment variables', 'red');
    log('Please add MEM0_API_KEY to your .env file', 'yellow');
    process.exit(1);
  }
  
  const apiKeyLength = process.env.MEM0_API_KEY.length;
  log(`✓ MEM0_API_KEY found (length: ${apiKeyLength})`, 'green');
  
  // Check if it's a placeholder
  if (apiKeyLength < 30 || process.env.MEM0_API_KEY === 'your-mem0-api-key-here') {
    log('⚠ MEM0_API_KEY appears to be a placeholder', 'yellow');
    log('Please get your API key from https://app.mem0.ai/dashboard/api-keys', 'yellow');
    log('\nTo set the API key:', 'blue');
    log('1. Sign up at https://app.mem0.ai', 'blue');
    log('2. Go to Dashboard > API Keys', 'blue');
    log('3. Create a new API key', 'blue');
    log('4. Replace the placeholder in .env with your actual key', 'blue');
    process.exit(1);
  }
  
  const mem0 = getMem0Service();
  let testMemoryId = null;
  
  try {
    // Test 1: Store a memory
    log('\n1. Testing memory storage...', 'blue');
    const testMessage = {
      role: 'user',
      content: 'This is a test memory for verification purposes'
    };
    
    const storeResult = await mem0.synthesize(
      [testMessage],
      TEST_ORG_ID,
      TEST_USER_ID,
      { source: 'test-script' }
    );
    
    if (storeResult && storeResult.results && storeResult.results.length > 0) {
      testMemoryId = storeResult.results[0].id;
      log(`✓ Successfully stored memory (ID: ${testMemoryId})`, 'green');
    } else {
      log('✓ Memory synthesis completed (no memories extracted)', 'yellow');
    }
    
    // Test 2: Recall memories
    log('\n2. Testing memory recall...', 'blue');
    const recallResult = await mem0.recall(
      'test memory verification',
      TEST_ORG_ID,
      TEST_USER_ID,
      { limit: 5 }
    );
    
    if (recallResult && recallResult.length > 0) {
      log(`✓ Successfully recalled ${recallResult.length} memories`, 'green');
      recallResult.forEach((memory, index) => {
        log(`  Memory ${index + 1}: ${memory.memory.substring(0, 50)}...`, 'blue');
      });
    } else {
      log('✓ Recall completed (no memories found)', 'yellow');
    }
    
    // Test 3: Get memory history
    log('\n3. Testing memory history...', 'blue');
    const historyResult = await mem0.getHistory(
      TEST_ORG_ID,
      TEST_USER_ID,
      { limit: 5 }
    );
    
    if (historyResult && historyResult.length > 0) {
      log(`✓ Successfully retrieved ${historyResult.length} history entries`, 'green');
    } else {
      log('✓ History query completed (no history found)', 'yellow');
    }
    
    // Test 4: Delete test memory (cleanup)
    if (testMemoryId) {
      log('\n4. Testing memory deletion...', 'blue');
      const deleteResult = await mem0.deleteMemory(testMemoryId);
      
      if (deleteResult) {
        log(`✓ Successfully deleted test memory (ID: ${testMemoryId})`, 'green');
      } else {
        log(`⚠ Could not delete test memory (ID: ${testMemoryId})`, 'yellow');
      }
    }
    
    // Summary
    log('\n=== Test Summary ===', 'blue');
    log('✓ Mem0 connection successful', 'green');
    log('✓ All basic operations working', 'green');
    log(`✓ API endpoint: ${mem0.apiUrl}`, 'green');
    log(`✓ User ID format: ${TEST_MEMORY_ID}`, 'green');
    
    process.exit(0);
    
  } catch (error) {
    log('\n=== Test Failed ===', 'red');
    log(`❌ Error: ${error.message}`, 'red');
    
    if (error.response) {
      log(`\nAPI Response:`, 'yellow');
      log(`Status: ${error.response.status}`, 'yellow');
      log(`Data: ${JSON.stringify(error.response.data, null, 2)}`, 'yellow');
    }
    
    log('\nPossible issues:', 'yellow');
    log('1. Invalid API key', 'yellow');
    log('2. Network connectivity issues', 'yellow');
    log('3. Mem0 service is down', 'yellow');
    log('4. API key lacks required permissions', 'yellow');
    
    process.exit(1);
  }
}

// Run the test
testMem0Connection().catch(error => {
  log(`\nUnexpected error: ${error.message}`, 'red');
  process.exit(1);
});