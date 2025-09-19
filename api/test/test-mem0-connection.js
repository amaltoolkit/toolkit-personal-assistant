/**
 * Test Mem0 Service Connection
 * Verifies that the Mem0 API key is valid and the service is working
 */

require('dotenv').config();

async function testMem0Connection() {
  console.log('🔍 Testing Mem0 Connection...\n');

  try {
    // Import the service
    const { getMem0Service } = require('../services/mem0Service');
    const mem0 = getMem0Service();

    console.log('✅ Mem0Service imported successfully');
    console.log(`📋 API Key configured: ${process.env.MEM0_API_KEY ? 'Yes' : 'No'}`);

    if (!process.env.MEM0_API_KEY) {
      throw new Error('MEM0_API_KEY not found in environment variables');
    }

    // Test 1: Basic recall (should return empty array for new query)
    console.log('\n📝 Test 1: Basic Recall');
    console.log('Testing recall with sample query...');
    const testQuery = 'What meetings do I have today?';
    const testOrgId = 'test-org-123';
    const testUserId = 'test-user-456';

    const recallResults = await mem0.recall(testQuery, testOrgId, testUserId, {
      limit: 5,
      threshold: 0.7
    });

    console.log(`✅ Recall succeeded. Found ${recallResults.length} memories`);
    if (recallResults.length > 0) {
      console.log('Sample memory:', recallResults[0]);
    }

    // Test 2: Synthesis (store a test memory)
    console.log('\n📝 Test 2: Memory Synthesis');
    console.log('Storing a test memory...');

    const testMessages = [
      { role: 'user', content: 'Schedule a meeting with John tomorrow at 2pm' },
      { role: 'assistant', content: 'I\'ve scheduled your meeting with John for tomorrow at 2:00 PM' }
    ];

    const synthesisResult = await mem0.synthesize(
      testMessages,
      testOrgId,
      testUserId,
      {
        domain: 'calendar',
        action: 'test_synthesis',
        test: true
      }
    );

    console.log('✅ Synthesis succeeded');
    if (synthesisResult) {
      console.log('Synthesis result:', synthesisResult);
    }

    // Test 3: Recall the synthesized memory
    console.log('\n📝 Test 3: Recall Synthesized Memory');
    console.log('Attempting to recall the memory we just stored...');

    // Wait a moment for indexing
    await new Promise(resolve => setTimeout(resolve, 2000));

    const recallAfterSynthesis = await mem0.recall(
      'meeting with John',
      testOrgId,
      testUserId,
      { limit: 5 }
    );

    console.log(`✅ Found ${recallAfterSynthesis.length} memories after synthesis`);
    if (recallAfterSynthesis.length > 0) {
      console.log('Retrieved memory:', recallAfterSynthesis[0]);
    }

    // Test 4: Get memory history
    console.log('\n📝 Test 4: Memory History');
    const history = await mem0.getHistory(testOrgId, testUserId, 10);
    console.log(`✅ Retrieved ${history.length} memories from history`);

    // Test 5: Delete test memory (cleanup)
    if (history.length > 0 && history[0].id) {
      console.log('\n📝 Test 5: Memory Deletion (Cleanup)');
      const deleted = await mem0.deleteMemory(history[0].id);
      console.log(`✅ Test memory deleted: ${deleted}`);
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ ALL MEM0 TESTS PASSED SUCCESSFULLY!');
    console.log('='.repeat(50));
    console.log('\nMem0 Service is properly configured and working.');
    console.log('The API key is valid and the service is responding correctly.');

    return true;

  } catch (error) {
    console.error('\n❌ MEM0 TEST FAILED!');
    console.error('='.repeat(50));
    console.error('Error:', error.message);

    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }

    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      console.error('\n⚠️  The API key appears to be invalid or expired.');
      console.error('Please check your MEM0_API_KEY in the .env file.');
      console.error('Get a new key from: https://app.mem0.ai');
    }

    console.error('='.repeat(50));
    process.exit(1);
  }
}

// Run the test
console.log('MEM0 CONNECTION TEST');
console.log('='.repeat(50));
testMem0Connection()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });