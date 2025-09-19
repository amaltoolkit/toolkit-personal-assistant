/**
 * End-to-End Test for Simplified Workflow Subgraph
 *
 * This test validates the complete flow from query to workflow creation
 * ensuring the simplified workflow agent works correctly.
 */

const { getCoordinator } = require('./coordinator');
const { getCheckpointer } = require('./graph/state');

// Test configuration
const TEST_CONFIG = {
  session_id: 'test_session_123',
  org_id: 'test_org_456',
  user_id: 'test_user_789',
  timezone: 'America/New_York'
};

// Mock PassKey for testing
const mockGetPassKey = async () => 'mock_passkey_123';

/**
 * Test 1: Simple 2-step workflow request
 * Expected: Should generate exactly 2 steps
 */
async function testSimpleTwoStepWorkflow() {
  console.log('\n========================================');
  console.log('TEST 1: Simple 2-step workflow request');
  console.log('========================================\n');

  const query = 'create a 2 step client outreach process';
  console.log(`Query: "${query}"`);

  try {
    const checkpointer = await getCheckpointer();
    const coordinator = getCoordinator(checkpointer);

    const config = {
      configurable: {
        thread_id: `${TEST_CONFIG.session_id}:${TEST_CONFIG.org_id}`,
        checkpoint_id: `checkpoint_${Date.now()}`,
        getPassKey: mockGetPassKey,
        ...TEST_CONFIG
      }
    };

    const result = await coordinator.invoke({
      query,
      ...TEST_CONFIG
    }, config);

    // Validate result
    console.log('\nResult Summary:');
    console.log('- Response:', result.response);
    console.log('- Domains routed:', result.domains);
    console.log('- Subgraph results:', Object.keys(result.subgraph_results || {}));

    // Check workflow result
    const workflowResult = result.subgraph_results?.workflow;
    if (workflowResult) {
      console.log('\nWorkflow Details:');
      console.log('- Design:', workflowResult.workflowDesign?.name);
      console.log('- Step count:', workflowResult.workflowDesign?.steps?.length);
      console.log('- Steps:', workflowResult.workflowDesign?.steps?.map(s => s.name));

      // Validate step count
      const stepCount = workflowResult.workflowDesign?.steps?.length;
      if (stepCount === 2) {
        console.log('✅ TEST PASSED: Generated exactly 2 steps as requested');
      } else {
        console.log(`❌ TEST FAILED: Expected 2 steps, got ${stepCount}`);
      }
    }

  } catch (error) {
    if (error.name === 'GraphInterrupt') {
      console.log('\n⏸️ Approval Required:');
      const interrupt = error.value?.value || error.value;
      const previews = interrupt.previews || [];

      previews.forEach(preview => {
        console.log(`\nWorkflow: ${preview.preview?.title}`);
        console.log(`Description: ${preview.preview?.details?.description}`);
        console.log(`Step Count: ${preview.preview?.details?.stepCount}`);
        console.log('Steps:');
        preview.preview?.details?.steps?.forEach(step => {
          console.log(`  ${step.number}. ${step.name} (${step.type}) - ${step.duration}`);
        });
      });

      // Validate step count in preview
      const stepCount = previews[0]?.preview?.details?.stepCount;
      if (stepCount === 2) {
        console.log('\n✅ TEST PASSED: Preview shows exactly 2 steps');
      } else {
        console.log(`\n❌ TEST FAILED: Expected 2 steps in preview, got ${stepCount}`);
      }
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

/**
 * Test 2: Comprehensive workflow request
 * Expected: Should generate 8-15 steps
 */
async function testComprehensiveWorkflow() {
  console.log('\n========================================');
  console.log('TEST 2: Comprehensive workflow request');
  console.log('========================================\n');

  const query = 'create a comprehensive employee onboarding workflow';
  console.log(`Query: "${query}"`);

  try {
    const checkpointer = await getCheckpointer();
    const coordinator = getCoordinator(checkpointer);

    const config = {
      configurable: {
        thread_id: `${TEST_CONFIG.session_id}:${TEST_CONFIG.org_id}_2`,
        checkpoint_id: `checkpoint_${Date.now()}`,
        getPassKey: mockGetPassKey,
        ...TEST_CONFIG
      }
    };

    const result = await coordinator.invoke({
      query,
      ...TEST_CONFIG
    }, config);

    console.log('\nResult Summary:');
    console.log('- Response:', result.response);

  } catch (error) {
    if (error.name === 'GraphInterrupt') {
      const interrupt = error.value?.value || error.value;
      const previews = interrupt.previews || [];
      const stepCount = previews[0]?.preview?.details?.stepCount;

      console.log(`\n⏸️ Approval Required for ${stepCount}-step workflow`);

      if (stepCount >= 8 && stepCount <= 15) {
        console.log('✅ TEST PASSED: Generated appropriate number of steps (8-15) for comprehensive workflow');
      } else {
        console.log(`❌ TEST FAILED: Expected 8-15 steps, got ${stepCount}`);
      }
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

/**
 * Test 3: Simple workflow request without number
 * Expected: Should generate 2-4 steps
 */
async function testSimpleWorkflow() {
  console.log('\n========================================');
  console.log('TEST 3: Simple workflow without number');
  console.log('========================================\n');

  const query = 'create a simple customer feedback workflow';
  console.log(`Query: "${query}"`);

  try {
    const checkpointer = await getCheckpointer();
    const coordinator = getCoordinator(checkpointer);

    const config = {
      configurable: {
        thread_id: `${TEST_CONFIG.session_id}:${TEST_CONFIG.org_id}_3`,
        checkpoint_id: `checkpoint_${Date.now()}`,
        getPassKey: mockGetPassKey,
        ...TEST_CONFIG
      }
    };

    const result = await coordinator.invoke({
      query,
      ...TEST_CONFIG
    }, config);

    console.log('\nResult Summary:');
    console.log('- Response:', result.response);

  } catch (error) {
    if (error.name === 'GraphInterrupt') {
      const interrupt = error.value?.value || error.value;
      const previews = interrupt.previews || [];
      const stepCount = previews[0]?.preview?.details?.stepCount;

      console.log(`\n⏸️ Approval Required for ${stepCount}-step workflow`);

      if (stepCount >= 2 && stepCount <= 4) {
        console.log('✅ TEST PASSED: Generated appropriate number of steps (2-4) for simple workflow');
      } else {
        console.log(`❌ TEST FAILED: Expected 2-4 steps for simple workflow, got ${stepCount}`);
      }
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('====================================================');
  console.log('E2E TEST SUITE: Simplified Workflow Subgraph');
  console.log('====================================================');

  try {
    await testSimpleTwoStepWorkflow();
    await testComprehensiveWorkflow();
    await testSimpleWorkflow();

    console.log('\n====================================================');
    console.log('TEST SUITE COMPLETE');
    console.log('====================================================\n');
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
  }
}

// Run tests if executed directly
if (require.main === module) {
  runAllTests().then(() => {
    console.log('Tests finished');
    process.exit(0);
  }).catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
}

module.exports = {
  testSimpleTwoStepWorkflow,
  testComprehensiveWorkflow,
  testSimpleWorkflow,
  runAllTests
};