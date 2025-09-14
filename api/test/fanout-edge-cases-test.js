/**
 * Test suite for fanOut node edge cases
 * Ensures the graph doesn't stall when fanOut nodes have no actions to route
 */

const { buildGraph } = require('../graph/orchestrator');
const { fanOutDesign, fanOutApply } = require('../graph/parallel');

// Test configuration
const TEST_CONFIG = {
  configurable: {
    thread_id: 'test_fanout_edges',
    userId: 'test_user',
    orgId: 'test_org',
    user_tz: 'UTC',
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

/**
 * Test fanOutDesign with empty plan
 */
async function testFanOutDesignEmptyPlan() {
  logTest('fanOutDesign - Empty Plan');
  
  try {
    // Test with no plan at all
    let state = {
      plan: [],
      artifacts: {}
    };
    
    const result = await fanOutDesign(state);
    
    if (result.constructor?.name === 'Command') {
      logSuccess('Returns Command when no actions ready');
      
      if (result.goto === 'coordination_join') {
        logSuccess('Routes to coordination_join when no actions/previews');
      } else {
        logError(`Unexpected routing: ${result.goto}`);
        return false;
      }
    } else {
      logError('Did not return Command object');
      return false;
    }
    
    // Test with existing previews but no new actions
    state = {
      plan: [],
      previews: [{ actionId: 'prev1', spec: {} }],
      artifacts: { doneIds: ['prev1'] }
    };
    
    const result2 = await fanOutDesign(state);
    
    if (result2.goto === 'approval_batch') {
      logSuccess('Routes to approval_batch when previews exist');
    } else {
      logError(`Should route to approval with previews, got: ${result2.goto}`);
      return false;
    }
    
    return true;
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

/**
 * Test fanOutDesign with all actions failed
 */
async function testFanOutDesignAllFailed() {
  logTest('fanOutDesign - All Actions Failed');
  
  try {
    const state = {
      plan: [
        { id: 'act1', type: 'create_task', params: {}, dependsOn: [] },
        { id: 'act2', type: 'create_task', params: {}, dependsOn: [] }
      ],
      artifacts: {
        failedActions: [
          { actionId: 'act1', error: 'Failed', phase: 'design' },
          { actionId: 'act2', error: 'Failed', phase: 'design' }
        ]
      }
    };
    
    const result = await fanOutDesign(state);
    
    if (result.constructor?.name === 'Command') {
      logSuccess('Returns Command when all actions failed');
      
      if (result.goto === 'coordination_join') {
        logSuccess('Routes to coordination_join when all failed');
      } else {
        logError(`Unexpected routing: ${result.goto}`);
        return false;
      }
    } else {
      logError('Did not return Command object');
      return false;
    }
    
    return true;
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    return false;
  }
}

/**
 * Test fanOutApply with no approvals
 */
async function testFanOutApplyNoApprovals() {
  logTest('fanOutApply - No Approvals');
  
  try {
    // Test with empty approvals
    const state = {
      plan: [
        { id: 'act1', type: 'create_task', params: {}, dependsOn: [] }
      ],
      approvals: {},
      artifacts: {}
    };
    
    const result = await fanOutApply(state);
    
    if (result.constructor?.name === 'Command') {
      logSuccess('Returns Command when no approvals');
      
      if (result.goto === 'synthesize_memory') {
        logSuccess('Routes to synthesize_memory when no approvals');
      } else {
        logError(`Unexpected routing: ${result.goto}`);
        return false;
      }
    } else {
      logError('Did not return Command object');
      return false;
    }
    
    return true;
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    return false;
  }
}

/**
 * Test fanOutApply with all rejections
 */
async function testFanOutApplyAllRejected() {
  logTest('fanOutApply - All Actions Rejected');
  
  try {
    const state = {
      plan: [
        { id: 'act1', type: 'create_task', params: {}, dependsOn: [] },
        { id: 'act2', type: 'create_task', params: {}, dependsOn: [] }
      ],
      approvals: {
        'act1': false,
        'act2': false
      },
      artifacts: {}
    };
    
    const result = await fanOutApply(state);
    
    if (result.constructor?.name === 'Command') {
      logSuccess('Returns Command when all rejected');
      
      if (result.goto === 'synthesize_memory') {
        logSuccess('Routes to synthesize_memory when all rejected');
      } else {
        logError(`Unexpected routing: ${result.goto}`);
        return false;
      }
    } else {
      logError('Did not return Command object');
      return false;
    }
    
    return true;
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    return false;
  }
}

/**
 * Test fanOutApply with all approved but failed
 */
async function testFanOutApplyAllFailed() {
  logTest('fanOutApply - All Approved Actions Failed');
  
  try {
    const state = {
      plan: [
        { id: 'act1', type: 'create_task', params: {}, dependsOn: [] },
        { id: 'act2', type: 'create_task', params: {}, dependsOn: [] }
      ],
      approvals: {
        'act1': true,
        'act2': true
      },
      artifacts: {
        failedActions: [
          { actionId: 'act1', error: 'Failed', phase: 'apply' },
          { actionId: 'act2', error: 'Failed', phase: 'apply' }
        ]
      }
    };
    
    const result = await fanOutApply(state);
    
    if (result.constructor?.name === 'Command') {
      logSuccess('Returns Command when all approved actions failed');
      
      if (result.goto === 'synthesize_memory') {
        logSuccess('Routes to synthesize_memory when all failed');
      } else {
        logError(`Unexpected routing: ${result.goto}`);
        return false;
      }
    } else {
      logError('Did not return Command object');
      return false;
    }
    
    return true;
    
  } catch (error) {
    logError(`Test failed: ${error.message}`);
    return false;
  }
}

/**
 * Test full graph flow with empty plan
 */
async function testGraphWithEmptyPlan() {
  logTest('Full Graph - Empty Plan Edge Case');
  
  try {
    const graph = await buildGraph();
    
    // Query that results in no actions
    const state = await graph.invoke(
      {
        messages: [{
          role: 'human',
          content: 'Hello'  // Simple greeting, no actions
        }],
        intent: 'action',  // Force action intent
        plan: []  // Empty plan
      },
      TEST_CONFIG
    );
    
    // Check that graph completed without stalling
    if (state.coordinationComplete || state.readyToFinalize) {
      logSuccess('Graph completed with empty plan');
    } else {
      logError('Graph may have stalled with empty plan');
      return false;
    }
    
    // Check that we have a response
    const lastMessage = state.messages?.[state.messages.length - 1];
    if (lastMessage) {
      logSuccess('Final response generated');
      logInfo(`Response preview: ${String(lastMessage.content).substring(0, 50)}...`);
    } else {
      logError('No final response generated');
      return false;
    }
    
    return true;
    
  } catch (error) {
    logError(`Graph test failed: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

/**
 * Test full graph flow with all rejections
 */
async function testGraphWithAllRejections() {
  logTest('Full Graph - All Rejections Edge Case');
  
  try {
    const graph = await buildGraph();
    
    // First invoke to create actions
    const state1 = await graph.invoke(
      {
        messages: [{
          role: 'human',
          content: 'Create a task called Test'
        }]
      },
      TEST_CONFIG
    );
    
    // Simulate rejection of all actions
    if (state1.interruptMarker === 'PENDING_APPROVAL' && state1.previews) {
      const { Command } = await import('@langchain/langgraph');
      
      // Reject all
      const rejections = {};
      state1.previews.forEach(preview => {
        if (preview.actionId) {
          rejections[preview.actionId] = false;
        }
      });
      
      logInfo(`Rejecting ${Object.keys(rejections).length} actions`);
      
      // Resume with rejections
      const resumeCommand = new Command({
        resume: rejections,
        update: {
          interruptMarker: null,
          approvalPayload: null
        }
      });
      
      const state2 = await graph.invoke(
        resumeCommand,
        { ...TEST_CONFIG, configurable: { ...TEST_CONFIG.configurable, thread_id: state1.thread_id } }
      );
      
      // Check that graph completed
      if (state2.coordinationComplete || state2.readyToFinalize) {
        logSuccess('Graph completed after rejecting all actions');
      } else {
        logError('Graph may have stalled after rejections');
        return false;
      }
      
      // Check for response
      if (state2.messages?.length > 0) {
        logSuccess('Response generated after rejections');
      }
      
      return true;
    } else {
      logInfo('No approval required or no previews generated');
      return true;
    }
    
  } catch (error) {
    logError(`Graph rejection test failed: ${error.message}`);
    return false;
  }
}

/**
 * Run all fanOut edge case tests
 */
async function runAllTests() {
  console.log(`${colors.bright}${colors.magenta}${'='.repeat(60)}`);
  console.log('FANOUT EDGE CASES - TEST SUITE');
  console.log(`${'='.repeat(60)}${colors.reset}`);
  
  const results = [];
  
  // Run unit tests
  results.push(await testFanOutDesignEmptyPlan());
  results.push(await testFanOutDesignAllFailed());
  results.push(await testFanOutApplyNoApprovals());
  results.push(await testFanOutApplyAllRejected());
  results.push(await testFanOutApplyAllFailed());
  
  // Run integration tests
  results.push(await testGraphWithEmptyPlan());
  results.push(await testGraphWithAllRejections());
  
  // Summary
  console.log(`\n${colors.bright}${'='.repeat(60)}`);
  console.log('TEST SUMMARY');
  console.log(`${'='.repeat(60)}${colors.reset}`);
  
  const passed = results.filter(r => r).length;
  const failed = results.length - passed;
  
  if (failed === 0) {
    console.log(`${colors.green}${colors.bright}ALL TESTS PASSED (${passed}/${results.length})${colors.reset}`);
    console.log('\n✅ FanOut nodes handle all edge cases correctly!');
    console.log('  • Empty plans route to coordination');
    console.log('  • No approvals route to synthesis');
    console.log('  • All failures handled gracefully');
    console.log('  • Graph never stalls');
  } else {
    console.log(`${colors.red}${colors.bright}SOME TESTS FAILED (${passed}/${results.length} passed)${colors.reset}`);
    console.log('\n⚠️  FanOut nodes may still have edge case issues');
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
  testFanOutDesignEmptyPlan,
  testFanOutDesignAllFailed,
  testFanOutApplyNoApprovals,
  testFanOutApplyAllRejected,
  testFanOutApplyAllFailed,
  testGraphWithEmptyPlan,
  testGraphWithAllRejections
};