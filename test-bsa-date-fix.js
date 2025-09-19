/**
 * Test script to verify BSA API date format fixes
 * Tests the corrected field names and ISO 8601 date formats
 */

const { getAppointments } = require('./api/tools/bsa/appointments');
const { getTasks } = require('./api/tools/bsa/tasks');

// Test configuration - Replace with your actual values
const TEST_CONFIG = {
  passKey: process.env.TEST_PASSKEY || 'YOUR_PASSKEY_HERE',
  orgId: process.env.TEST_ORG_ID || 'YOUR_ORG_ID_HERE'
};

/**
 * Test getAppointments with corrected payload format
 */
async function testGetAppointments() {
  console.log('\n=== Testing getAppointments with Fixed Format ===');

  try {
    // Test with a date range
    const result = await getAppointments({
      startDate: '2024-09-14',  // Will be converted to ISO format
      endDate: '2024-09-15'
    }, TEST_CONFIG.passKey, TEST_CONFIG.orgId);

    console.log('✅ getAppointments successful!');
    console.log(`Found ${result.count} appointments`);

    if (result.appointments.length > 0) {
      console.log('\nFirst appointment:');
      const appt = result.appointments[0];
      console.log(`  Subject: ${appt.Subject}`);
      console.log(`  StartTime: ${appt.StartTime}`);
      console.log(`  EndTime: ${appt.EndTime}`);
    }

    return true;
  } catch (error) {
    console.error('❌ getAppointments failed:', error.message);
    if (error.response?.data) {
      console.error('BSA Response:', JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
}

/**
 * Test getTasks with corrected payload format
 */
async function testGetTasks() {
  console.log('\n=== Testing getTasks with Fixed Format ===');

  try {
    // Test with a date range
    const result = await getTasks({
      startDate: '2024-09-14',  // Will be converted to ISO format
      endDate: '2024-09-15'
    }, TEST_CONFIG.passKey, TEST_CONFIG.orgId);

    console.log('✅ getTasks successful!');
    console.log(`Found ${result.count} tasks`);

    if (result.tasks.length > 0) {
      console.log('\nFirst task:');
      const task = result.tasks[0];
      console.log(`  Subject: ${task.Subject}`);
      console.log(`  DueDate: ${task.DueDate}`);
      console.log(`  Status: ${task.Status}`);
    }

    return true;
  } catch (error) {
    console.error('❌ getTasks failed:', error.message);
    if (error.response?.data) {
      console.error('BSA Response:', JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
}

/**
 * Show what the fixed payload looks like
 */
function showFixedPayloadStructure() {
  console.log('\n=== Fixed Payload Structure ===');
  console.log('\nBefore (causing error):');
  console.log(JSON.stringify({
    orgId: "org-id-here",
    IncludeAppointments: true,
    IncludeTasks: false,
    From: "2024-09-14",
    To: "2024-09-15",
    IncludeAttendees: true,
    IncludeExtendedProperties: false
  }, null, 2));

  console.log('\nAfter (correct format):');
  console.log(JSON.stringify({
    OrganizationId: "org-id-here",
    PassKey: "passkey-here",
    ObjectName: "appointment",
    IncludeAppointments: true,
    IncludeTasks: false,
    From: "2024-09-14T00:00:00.000Z",
    To: "2024-09-15T23:59:59.999Z",
    IncludeAttendees: true,
    IncludeExtendedProperties: false
  }, null, 2));
}

/**
 * Run all tests
 */
async function runTests() {
  console.log('========================================');
  console.log('BSA API Date Format Fix Test');
  console.log('========================================');

  // Show the fix
  showFixedPayloadStructure();

  // Check if credentials are set
  if (TEST_CONFIG.passKey === 'YOUR_PASSKEY_HERE') {
    console.log('\n⚠️  Please set TEST_PASSKEY and TEST_ORG_ID environment variables');
    console.log('Example: TEST_PASSKEY=xxx TEST_ORG_ID=yyy node test-bsa-date-fix.js');
    return;
  }

  console.log(`\nTesting with PassKey: ${TEST_CONFIG.passKey.substring(0, 10)}...`);
  console.log(`Organization ID: ${TEST_CONFIG.orgId}`);

  // Run tests
  const appointmentTestPassed = await testGetAppointments();
  const taskTestPassed = await testGetTasks();

  // Summary
  console.log('\n========================================');
  console.log('Test Summary:');
  console.log(`  getAppointments: ${appointmentTestPassed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`  getTasks: ${taskTestPassed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('========================================');

  if (appointmentTestPassed && taskTestPassed) {
    console.log('\n🎉 All tests passed! The date format fix is working.');
  } else {
    console.log('\n⚠️  Some tests failed. Check the error messages above.');
  }
}

// Run if executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testGetAppointments, testGetTasks, runTests };