/**
 * Test suite to verify mixed intent handling doesn't terminate early
 * 
 * Tests that when a user asks for both information AND actions,
 * both paths complete properly without the KB path terminating the graph early
 */

const { buildGraph } = require('../graph/orchestrator');

// Test configuration
const TEST_CONFIG = {
  configurable: {
    thread_id: 'test_mixed_intent',
    userId: 'test_user',
    orgId: 'test_org',
    user_tz: 'UTC',
    // Approvals always required (human in the loop)
    passKey: 'test_passkey',
    BSA_BASE: 'https://test.example.com'
  }
};

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function logTest(name) {
  console.log(`\n${colors.bright}${colors.blue}TEST: ${name}${colors.reset}`);
}

function logSuccess(message) {
  console.log(`${colors.green}✓ ${message}${colors.reset}`);
}

function logError(message) {
  console.log(`${colors.red}✗ ${message}${colors.reset}`);
}

function logInfo(message) {
  console.log(`${colors.cyan}ℹ ${message}${colors.reset}`);
}

function logStep(message) {
  console.log(`${colors.magenta}→ ${message}${colors.reset}`);
}

/**
 * Test that help_kb intent works correctly (KB only)
 */
async function testHelpKbIntent() {
  logTest('Help KB Intent (KB path only)');
  
  try {
    const graph = await buildGraph();
    
    // Simulate a help query
    const state = await graph.invoke(
      {
        messages: [{
          role: 'human',
          content: 'How do I create a workflow?'
        }],
        intent: 'help_kb' // Force intent for testing
      },
      TEST_CONFIG
    );
    
    // Check that KB answer is present
    if (state.kb && state.kb.answer) {
      logSuccess('KB answer generated');
      logInfo(`Answer: ${state.kb.answer.substring(0, 100)}...`);
    } else {
      logError('No KB answer found');
      return false;
    }
    
    // Check that no actions were planned
    if (!state.plan || state.plan.length === 0) {
      logSuccess('No actions planned (correct for KB-only)');
    } else {
      logError(`Unexpected actions planned: ${state.plan.length}`);
      return false;
    }
    
    // Check coordination completed
    if (state.coordinationComplete) {
      logSuccess('Coordination completed properly');
    }
    
    return true;
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

/**
 * Test that action intent works correctly (action path only)
 */
async function testActionIntent() {
  logTest('Action Intent (action path only)');
  
  try {
    const graph = await buildGraph();
    
    // Simulate an action query
    const state = await graph.invoke(
      {
        messages: [{
          role: 'human',
          content: 'Create a task called Review Documents'
        }],
        intent: 'action' // Force intent for testing
      },
      TEST_CONFIG
    );
    
    // Check that actions were planned
    if (state.plan && state.plan.length > 0) {
      logSuccess(`Actions planned: ${state.plan.length}`);
      state.plan.forEach(action => {
        logInfo(`  - ${action.type}: ${action.id}`);
      });
    } else {
      logError('No actions planned');
      return false;
    }
    
    // Check that no KB answer was generated
    if (!state.kb?.answer || state.kb.answer.includes('This feature will search')) {
      logSuccess('No real KB answer (correct for action-only)');
    } else {
      logError('Unexpected KB answer for action-only intent');
      return false;
    }
    
    // Check coordination completed
    if (state.coordinationComplete) {
      logSuccess('Coordination completed properly');
    }
    
    return true;
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

/**
 * Test that mixed intent doesn't terminate early
 */
async function testMixedIntent() {
  logTest('Mixed Intent (both KB and action paths)');
  
  try {
    const graph = await buildGraph();
    
    logStep('Invoking with mixed intent query...');
    
    // Simulate a mixed query
    const state = await graph.invoke(
      {
        messages: [{
          role: 'human',
          content: 'How do I create workflows and create one for client onboarding with 3 steps'
        }],
        intent: 'mixed' // Force intent for testing
      },
      TEST_CONFIG
    );
    
    logStep('Checking results...');
    
    // Check that KB answer is present
    const hasKbAnswer = state.kb && state.kb.answer;
    if (hasKbAnswer) {
      logSuccess('KB answer generated');
      logInfo(`KB Answer preview: ${state.kb.answer.substring(0, 80)}...`);
    } else {
      logError('No KB answer found for mixed intent');
      return false;
    }
    
    // Check that actions were planned
    const hasActions = state.plan && state.plan.length > 0;
    if (hasActions) {
      logSuccess(`Actions planned: ${state.plan.length}`);
      state.plan.forEach(action => {
        logInfo(`  - ${action.type}: ${action.id}`);
      });
    } else {
      logError('No actions planned for mixed intent');
      return false;
    }
    
    // Check that actions completed (or at least were processed)
    if (state.artifacts?.doneIds && state.artifacts.doneIds.length > 0) {
      logSuccess(`Actions completed: ${state.artifacts.doneIds.length}`);
      logInfo(`Completed IDs: ${state.artifacts.doneIds.join(', ')}`);
    } else if (state.artifacts?.planGenerated) {
      logSuccess('Plan was generated and processed');
    } else {
      logError('Actions were not processed (likely terminated early!)');
      return false;
    }
    
    // Check coordination status
    if (state.coordinationComplete) {
      logSuccess('Coordination completed successfully');
      
      if (state.kbComplete && state.actionsComplete !== false) {
        logSuccess('Both KB and actions marked complete');
      }
    } else {
      logError('Coordination did not complete');
      return false;
    }
    
    // Check for early termination signs
    if (hasKbAnswer && hasActions) {
      if (!state.artifacts || Object.keys(state.artifacts).length === 0) {
        logError('EARLY TERMINATION DETECTED: Actions planned but no artifacts');
        return false;
      }
      logSuccess('No early termination detected - both paths completed');
    }
    
    return true;
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

/**
 * Test coordination node directly
 */
async function testCoordinationNode() {
  logTest('Coordination Node Logic');
  
  try {
    const { coordinationJoinNode } = require('../graph/orchestrator');
    const { allActionsDone } = require('../graph/parallel');
    
    // Test 1: KB only
    logStep('Testing KB-only coordination...');
    let state = {
      intent: 'help_kb',
      kb: { answer: 'Test answer' }
    };
    let result = await coordinationJoinNode(state, {});
    if (result.readyToFinalize) {
      logSuccess('KB-only ready to finalize');
    } else {
      logError('KB-only not ready to finalize');
      return false;
    }
    
    // Test 2: Action only with completed actions
    logStep('Testing action-only coordination...');
    state = {
      intent: 'action',
      plan: [{ id: 'act1' }],
      artifacts: { doneIds: ['act1'] }
    };
    result = await coordinationJoinNode(state, {});
    if (result.readyToFinalize) {
      logSuccess('Action-only ready to finalize when done');
    } else {
      logError('Action-only not ready when should be');
      return false;
    }
    
    // Test 3: Mixed with only KB done
    logStep('Testing mixed with only KB done...');
    state = {
      intent: 'mixed',
      kb: { answer: 'Test answer' },
      plan: [{ id: 'act1' }],
      artifacts: { doneIds: [] }
    };
    result = await coordinationJoinNode(state, {});
    if (!result.readyToFinalize) {
      logSuccess('Mixed not ready when only KB done');
    } else {
      logError('Mixed ready too early (KB done, actions pending)');
      return false;
    }
    
    // Test 4: Mixed with both done
    logStep('Testing mixed with both done...');
    state = {
      intent: 'mixed',
      kb: { answer: 'Test answer' },
      plan: [{ id: 'act1' }],
      artifacts: { doneIds: ['act1'] }
    };
    result = await coordinationJoinNode(state, {});
    if (result.readyToFinalize) {
      logSuccess('Mixed ready when both done');
    } else {
      logError('Mixed not ready when both complete');
      return false;
    }
    
    return true;
    
  } catch (error) {
    logError(`Coordination test failed: ${error.message}`);
    return false;
  }
}

/**
 * Run all mixed intent tests
 */
async function runAllTests() {
  console.log(`${colors.bright}${colors.magenta}${'='.repeat(60)}`);
  console.log('MIXED INTENT COORDINATION - TEST SUITE');
  console.log(`${'='.repeat(60)}${colors.reset}`);
  
  const results = [];
  
  // Run tests
  results.push(await testCoordinationNode());
  results.push(await testHelpKbIntent());
  results.push(await testActionIntent());
  results.push(await testMixedIntent());
  
  // Summary
  console.log(`\n${colors.bright}${'='.repeat(60)}`);
  console.log('TEST SUMMARY');
  console.log(`${'='.repeat(60)}${colors.reset}`);
  
  const passed = results.filter(r => r).length;
  const failed = results.length - passed;
  
  if (failed === 0) {
    console.log(`${colors.green}${colors.bright}ALL TESTS PASSED (${passed}/${results.length})${colors.reset}`);
    console.log('\n✅ Mixed intent coordination working correctly!');
    console.log('  • KB-only queries complete with KB answer');
    console.log('  • Action-only queries complete all actions');
    console.log('  • Mixed queries wait for BOTH paths to complete');
    console.log('  • No early termination when KB finishes first');
  } else {
    console.log(`${colors.red}${colors.bright}SOME TESTS FAILED (${passed}/${results.length} passed)${colors.reset}`);
    console.log('\n⚠️  Mixed intent may still have issues');
  }
  
  process.exit(failed === 0 ? 0 : 1);
}

// Run tests if executed directly
if (require.main === module) {
  runAllTests().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
  });
}

module.exports = {
  testHelpKbIntent,
  testActionIntent,
  testMixedIntent,
  testCoordinationNode
};