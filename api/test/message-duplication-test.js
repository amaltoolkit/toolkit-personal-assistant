/**
 * Test suite to validate that message duplication bug is fixed
 * 
 * MessagesAnnotation concatenates messages, so nodes should either:
 * 1. Return NO messages field (when not adding new messages)
 * 2. Return ONLY new messages (when adding a system/assistant message)
 */

const { buildGraph } = require('../graph/orchestrator');

// Test configuration
const TEST_CONFIG = {
  configurable: {
    thread_id: 'test_msg_dup_123',
    userId: 'test_user',
    orgId: 'test_org',
    user_tz: 'UTC',
    safe_mode: false, // Disable to avoid approval interrupts
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
  cyan: '\x1b[36m'
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
 * Test that messages are not duplicated through the flow
 */
async function testMessageNoDuplication() {
  logTest('Message Non-Duplication Through Flow');
  
  try {
    const graph = await buildGraph();
    
    // Initial message
    const initialMessages = [{
      role: 'human',
      content: 'Create a simple task called Test Task'
    }];
    
    console.log('\nStep 1: Executing with initial message...');
    logInfo(`Initial message count: ${initialMessages.length}`);
    
    const state1 = await graph.invoke(
      { messages: initialMessages },
      TEST_CONFIG
    );
    
    const messageCount1 = state1.messages?.length || 0;
    logInfo(`After first invocation: ${messageCount1} messages`);
    
    // Check that we don't have duplicated messages
    if (messageCount1 > 10) {
      logError(`Too many messages after single invocation: ${messageCount1}`);
      logError('Likely duplication is occurring!');
      
      // Show message types for debugging
      console.log('\nMessage breakdown:');
      state1.messages.forEach((msg, i) => {
        const role = msg.role || msg._getType?.() || 'unknown';
        const preview = (msg.content || '').substring(0, 50);
        console.log(`  ${i + 1}. [${role}] ${preview}...`);
      });
      
      return false;
    }
    
    // Second invocation to check accumulation
    console.log('\nStep 2: Second invocation with new query...');
    const state2 = await graph.invoke(
      {
        messages: [{
          role: 'human',
          content: 'What did I just ask you to do?'
        }]
      },
      TEST_CONFIG
    );
    
    const messageCount2 = state2.messages?.length || 0;
    logInfo(`After second invocation: ${messageCount2} messages`);
    
    // With proper handling, messages should grow linearly, not exponentially
    if (messageCount2 > messageCount1 * 2 + 2) {
      logError(`Message count growing too fast: ${messageCount1} -> ${messageCount2}`);
      logError('Messages are being duplicated!');
      return false;
    }
    
    logSuccess('Messages are not being duplicated');
    logSuccess(`Message growth is linear: ${messageCount1} -> ${messageCount2}`);
    
    return true;
    
  } catch (error) {
    logError(`Test failed with error: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

/**
 * Test that nodes return correct message formats
 */
async function testNodeMessageReturns() {
  logTest('Node Message Return Formats');
  
  try {
    // Test individual nodes
    const nodesToTest = [
      { name: 'intentNode', module: '../graph/intent' },
      { name: 'planNode', module: '../graph/plan' },
      { name: 'approvalBatchNode', module: '../graph/approval' }
    ];
    
    let allPassed = true;
    
    for (const nodeInfo of nodesToTest) {
      console.log(`\nTesting ${nodeInfo.name}...`);
      
      try {
        const { [nodeInfo.name]: nodeFunc } = require(nodeInfo.module);
        
        // Mock state
        const mockState = {
          messages: [
            { role: 'human', content: 'test query' }
          ],
          artifacts: {}
        };
        
        // Call the node
        const result = await nodeFunc(mockState, TEST_CONFIG);
        
        // Check if messages field is returned
        if ('messages' in result) {
          // If messages are returned, they should be NEW messages only
          if (Array.isArray(result.messages)) {
            const returnedCount = result.messages.length;
            
            if (returnedCount === mockState.messages.length) {
              logError(`${nodeInfo.name} returns same number of messages as input (likely duplicating)`);
              allPassed = false;
            } else if (returnedCount > 1 && returnedCount > mockState.messages.length) {
              logError(`${nodeInfo.name} returns more messages than expected`);
              allPassed = false;
            } else {
              logSuccess(`${nodeInfo.name} returns correct message format`);
            }
          } else {
            logError(`${nodeInfo.name} returns non-array messages field`);
            allPassed = false;
          }
        } else {
          // No messages field is correct for most nodes
          logSuccess(`${nodeInfo.name} correctly omits messages field`);
        }
        
      } catch (error) {
        logError(`Failed to test ${nodeInfo.name}: ${error.message}`);
        allPassed = false;
      }
    }
    
    return allPassed;
    
  } catch (error) {
    logError(`Node test failed: ${error.message}`);
    return false;
  }
}

/**
 * Test memory recall returns only new system message
 */
async function testMemoryRecallMessage() {
  logTest('Memory Recall Message Handling');
  
  try {
    const { recallMemoryNode } = require('../memory/recall');
    
    const mockState = {
      messages: [
        { role: 'system', content: 'You are an assistant' },
        { role: 'human', content: 'Remember that I like blue' },
        { role: 'assistant', content: 'I will remember that' },
        { role: 'human', content: 'What is my favorite color?' }
      ]
    };
    
    console.log(`\nInitial message count: ${mockState.messages.length}`);
    
    // Call recall node
    const result = await recallMemoryNode(mockState, TEST_CONFIG);
    
    // Check the result
    if (!result.messages) {
      logInfo('No memories found (expected if no memories stored)');
      logSuccess('Correctly returns empty object when no memories');
      return true;
    }
    
    if (Array.isArray(result.messages)) {
      const returnedCount = result.messages.length;
      
      if (returnedCount === 1) {
        const msg = result.messages[0];
        if (msg.role === 'system' || msg._getType?.() === 'system') {
          logSuccess('Correctly returns single system message with memories');
          return true;
        } else {
          logError('Returned message is not a system message');
          return false;
        }
      } else if (returnedCount === mockState.messages.length) {
        logError('Recall node is returning all original messages (duplication!)');
        return false;
      } else {
        logError(`Unexpected message count returned: ${returnedCount}`);
        return false;
      }
    }
    
    return true;
    
  } catch (error) {
    logError(`Memory recall test failed: ${error.message}`);
    return false;
  }
}

/**
 * Run all message handling tests
 */
async function runAllTests() {
  console.log(`${colors.bright}${colors.cyan}${'='.repeat(60)}`);
  console.log('MESSAGE DUPLICATION FIX - VALIDATION TEST SUITE');
  console.log(`${'='.repeat(60)}${colors.reset}`);
  
  const results = [];
  
  // Run tests
  results.push(await testMessageNoDuplication());
  results.push(await testNodeMessageReturns());
  results.push(await testMemoryRecallMessage());
  
  // Summary
  console.log(`\n${colors.bright}${'='.repeat(60)}`);
  console.log('TEST SUMMARY');
  console.log(`${'='.repeat(60)}${colors.reset}`);
  
  const passed = results.filter(r => r).length;
  const failed = results.length - passed;
  
  if (failed === 0) {
    console.log(`${colors.green}${colors.bright}ALL TESTS PASSED (${passed}/${results.length})${colors.reset}`);
    console.log('\n✅ Message duplication bug is FIXED!');
    console.log('Nodes correctly return:');
    console.log('  • No messages field when not adding messages');
    console.log('  • Only new messages when adding content');
  } else {
    console.log(`${colors.red}${colors.bright}SOME TESTS FAILED (${passed}/${results.length} passed)${colors.reset}`);
    console.log('\n⚠️  Message duplication may still occur in some cases');
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
  testMessageNoDuplication,
  testNodeMessageReturns,
  testMemoryRecallMessage
};