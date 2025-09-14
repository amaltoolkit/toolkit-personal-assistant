/**
 * Test script for V2 Architecture
 * Tests the Coordinator and CalendarSubgraph
 */

require('dotenv').config();

// Set V2 flag
process.env.USE_V2_ARCHITECTURE = 'true';

const { getCoordinator } = require('../coordinator');
const { getPassKeyManager } = require('../services/passKeyManager');

// Test configuration
const TEST_SESSION_ID = 'test-session-123';
const TEST_ORG_ID = 'test-org-456';
const TEST_USER_ID = 'test-user-789';

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

async function runTests() {
  log('\n=== V2 Architecture Test Suite ===\n', 'blue');
  
  const coordinator = getCoordinator();
  
  // Test queries
  const testQueries = [
    {
      name: 'Simple calendar view',
      query: "What's on my calendar today?",
      expectedDomains: ['calendar']
    },
    {
      name: 'No domain query',
      query: "Hello, how are you?",
      expectedDomains: []
    },
    {
      name: 'Calendar creation',
      query: "Schedule a meeting tomorrow at 2pm",
      expectedDomains: ['calendar']
    }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of testQueries) {
    log(`\nTest: ${test.name}`, 'yellow');
    log(`Query: "${test.query}"`, 'blue');
    
    try {
      const result = await coordinator.processQuery(test.query, {
        org_id: TEST_ORG_ID,
        user_id: TEST_USER_ID,
        session_id: TEST_SESSION_ID,
        thread_id: `test-thread-${Date.now()}`,
        checkpoint_id: `test-checkpoint-${Date.now()}`
      });
      
      if (!result.success) {
        log(`✗ Test failed: ${result.error}`, 'red');
        failed++;
        continue;
      }
      
      // Check domains
      const detectedDomains = result.domains || [];
      const domainsMatch = JSON.stringify(detectedDomains.sort()) === 
                           JSON.stringify(test.expectedDomains.sort());
      
      if (domainsMatch) {
        log(`✓ Domains correct: ${detectedDomains.join(', ') || 'none'}`, 'green');
      } else {
        log(`✗ Domains mismatch. Expected: ${test.expectedDomains}, Got: ${detectedDomains}`, 'red');
        failed++;
        continue;
      }
      
      // Check response
      if (result.response) {
        log(`✓ Response: ${result.response.substring(0, 100)}...`, 'green');
        passed++;
      } else {
        log(`✗ No response generated`, 'red');
        failed++;
      }
      
    } catch (error) {
      log(`✗ Error: ${error.message}`, 'red');
      if (error.stack) {
        console.error(error.stack);
      }
      failed++;
    }
  }
  
  // Summary
  log('\n=== Test Summary ===', 'blue');
  log(`Passed: ${passed}/${testQueries.length}`, passed > 0 ? 'green' : 'red');
  log(`Failed: ${failed}/${testQueries.length}`, failed > 0 ? 'red' : 'green');
  
  if (passed === testQueries.length) {
    log('\n✓ All tests passed!', 'green');
    process.exit(0);
  } else {
    log('\n✗ Some tests failed', 'red');
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  log(`\nFatal error: ${error.message}`, 'red');
  console.error(error.stack);
  process.exit(1);
});