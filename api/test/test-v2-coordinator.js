/**
 * Test V2 Coordinator and Architecture
 * Tests the new domain-based subgraph system
 */

require('dotenv').config();

// Force V2 architecture for this test
process.env.USE_V2_ARCHITECTURE = 'true';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testCoordinator() {
  log('\n🚀 V2 COORDINATOR TEST SUITE', 'cyan');
  log('='.repeat(50), 'cyan');

  try {
    // Import coordinator
    const { getCoordinator } = require('../coordinator');
    const coordinator = getCoordinator();

    log('\n✅ Coordinator imported successfully', 'green');
    log(`📋 V2 Architecture enabled: ${process.env.USE_V2_ARCHITECTURE}`, 'blue');

    // Test configuration
    const testConfig = {
      org_id: 'test-org-v2',
      user_id: 'test-user-v2',
      session_id: 'test-session-' + Date.now(),
      thread_id: 'test-thread-' + Date.now(),
      checkpoint_id: 'test-checkpoint-' + Date.now()
    };

    // Test queries with expected behaviors
    const testCases = [
      {
        name: 'Simple Query (No Domain)',
        query: 'Hello, how are you?',
        expectedDomains: [],
        expectedResponse: true
      },
      {
        name: 'Calendar Domain Query',
        query: "What's on my calendar today?",
        expectedDomains: ['calendar'],
        expectedResponse: true
      },
      {
        name: 'Task Domain Query',
        query: 'Create a task to review the report',
        expectedDomains: ['task'],
        expectedResponse: true
      },
      {
        name: 'Workflow Domain Query',
        query: 'Build a client onboarding workflow',
        expectedDomains: ['workflow'],
        expectedResponse: true
      },
      {
        name: 'Multi-Domain Query',
        query: 'Create a financial planning workflow and schedule a meeting to discuss it',
        expectedDomains: ['workflow', 'calendar'],
        expectedResponse: true,
        expectsPlanning: true
      }
    ];

    let passed = 0;
    let failed = 0;

    for (const test of testCases) {
      log(`\n📝 Test: ${test.name}`, 'yellow');
      log(`Query: "${test.query}"`, 'blue');

      try {
        const startTime = Date.now();

        // Process query through coordinator
        const result = await coordinator.processQuery(test.query, testConfig);

        const duration = Date.now() - startTime;

        // Check if successful
        if (!result.success) {
          log(`❌ Test failed: ${result.error}`, 'red');
          failed++;
          continue;
        }

        // Check domains detected
        const detectedDomains = result.domains || [];
        log(`Detected domains: ${detectedDomains.length > 0 ? detectedDomains.join(', ') : 'none'}`, 'cyan');

        // Verify domain detection
        const expectedDomainsSet = new Set(test.expectedDomains);
        const detectedDomainsSet = new Set(detectedDomains);
        const domainsMatch =
          expectedDomainsSet.size === detectedDomainsSet.size &&
          [...expectedDomainsSet].every(d => detectedDomainsSet.has(d));

        if (domainsMatch) {
          log(`✅ Domain detection correct`, 'green');
        } else {
          log(`⚠️  Domain mismatch. Expected: ${test.expectedDomains}, Got: ${detectedDomains}`, 'yellow');
        }

        // Check response
        if (result.response) {
          log(`✅ Response generated in ${duration}ms`, 'green');
          log(`Response preview: ${result.response.substring(0, 100)}...`, 'cyan');
        } else {
          log(`⚠️  No response generated`, 'yellow');
        }

        // Check planning if expected
        if (test.expectsPlanning) {
          if (result.executionPlan) {
            log(`✅ Execution plan created with ${result.executionPlan.steps?.length || 0} steps`, 'green');
          } else {
            log(`⚠️  Expected execution plan but none created`, 'yellow');
          }
        }

        // Check performance
        if (duration < 2000) {
          log(`✅ Performance good: ${duration}ms`, 'green');
        } else {
          log(`⚠️  Performance slow: ${duration}ms (target < 2000ms)`, 'yellow');
        }

        passed++;

      } catch (error) {
        log(`❌ Test error: ${error.message}`, 'red');
        if (error.stack) {
          log(`Stack: ${error.stack.split('\n').slice(0, 3).join('\n')}`, 'red');
        }
        failed++;
      }
    }

    // Test Summary
    log('\n' + '='.repeat(50), 'cyan');
    log('TEST SUMMARY', 'cyan');
    log('='.repeat(50), 'cyan');
    log(`✅ Passed: ${passed}/${testCases.length}`, 'green');
    if (failed > 0) {
      log(`❌ Failed: ${failed}/${testCases.length}`, 'red');
    }

    // Additional checks
    log('\n📊 SYSTEM CHECKS', 'cyan');
    log('='.repeat(50), 'cyan');

    // Check if subgraphs are loaded
    try {
      const { CalendarSubgraph } = require('../subgraphs/calendar');
      log('✅ CalendarSubgraph loaded', 'green');
    } catch (e) {
      log('❌ CalendarSubgraph not found', 'red');
    }

    try {
      const { TaskSubgraph } = require('../subgraphs/task');
      log('✅ TaskSubgraph loaded', 'green');
    } catch (e) {
      log('❌ TaskSubgraph not found', 'red');
    }

    try {
      const { WorkflowSubgraph } = require('../subgraphs/workflow');
      log('✅ WorkflowSubgraph loaded', 'green');
    } catch (e) {
      log('❌ WorkflowSubgraph not found', 'red');
    }

    // Check services
    try {
      const { getMem0Service } = require('../services/mem0Service');
      const mem0 = getMem0Service();
      log('✅ Mem0Service available', 'green');
    } catch (e) {
      log('❌ Mem0Service error: ' + e.message, 'red');
    }

    try {
      const { getContactResolver } = require('../services/contactResolver');
      const resolver = getContactResolver();
      log('✅ ContactResolver available', 'green');
    } catch (e) {
      log('❌ ContactResolver error: ' + e.message, 'red');
    }

    // Final status
    if (passed === testCases.length) {
      log('\n' + '='.repeat(50), 'green');
      log('🎉 ALL TESTS PASSED! V2 ARCHITECTURE IS WORKING!', 'green');
      log('='.repeat(50), 'green');
      return true;
    } else {
      log('\n' + '='.repeat(50), 'yellow');
      log(`⚠️  PARTIAL SUCCESS: ${passed}/${testCases.length} tests passed`, 'yellow');
      log('Review the failed tests above for details', 'yellow');
      log('='.repeat(50), 'yellow');
      return false;
    }

  } catch (error) {
    log('\n❌ COORDINATOR TEST FAILED!', 'red');
    log('='.repeat(50), 'red');
    log(`Error: ${error.message}`, 'red');

    if (error.stack) {
      log('\nStack trace:', 'red');
      log(error.stack, 'red');
    }

    // Diagnostic information
    log('\n📋 DIAGNOSTICS', 'yellow');
    log('='.repeat(50), 'yellow');
    log(`USE_V2_ARCHITECTURE: ${process.env.USE_V2_ARCHITECTURE}`, 'yellow');
    log(`Current directory: ${process.cwd()}`, 'yellow');
    log(`Node version: ${process.version}`, 'yellow');

    return false;
  }
}

// Run the test
console.log('\nV2 COORDINATOR TEST');
console.log('Testing the new domain-based subgraph architecture...');

testCoordinator()
  .then(success => {
    if (success) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });