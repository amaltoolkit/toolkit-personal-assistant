/**
 * Test script for verifying contact linking to appointments and tasks
 * Tests the fixes for using correct BSA endpoints and payload structures
 */

require('dotenv').config();

// Import the fixed modules
const { createAppointment, linkAttendees } = require('./api/tools/bsa/appointments');
const { createTask } = require('./api/tools/bsa/tasks');
const { getContactResolver } = require('./api/services/contactResolver');
const { linkContactToActivity } = require('./api/tools/bsa/contacts');

// Test configuration
const TEST_CONFIG = {
  passKey: process.env.TEST_PASSKEY || 'YOUR_PASSKEY_HERE',
  orgId: process.env.TEST_ORG_ID || 'YOUR_ORG_ID_HERE',
  contactName: 'John Doe' // Change to a real contact name in your system
};

async function testContactSearch() {
  console.log('\n=== Testing Contact Search ===');

  try {
    const resolver = getContactResolver();
    const contacts = await resolver.search(
      TEST_CONFIG.contactName,
      5,
      TEST_CONFIG.passKey,
      TEST_CONFIG.orgId
    );

    console.log(`✅ Contact search successful. Found ${contacts.length} contacts:`);
    contacts.forEach(c => {
      console.log(`  - ${c.name} (ID: ${c.id})`);
    });

    return contacts[0]; // Return first contact for linking tests
  } catch (error) {
    console.error('❌ Contact search failed:', error.message);
    throw error;
  }
}

async function testAppointmentCreationWithLinking(contact) {
  console.log('\n=== Testing Appointment Creation with Contact Linking ===');

  try {
    // Step 1: Create appointment
    const appointmentData = {
      subject: `Test Appointment - ${new Date().toISOString()}`,
      startTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Tomorrow
      endTime: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(), // Tomorrow + 1 hour
      location: 'Test Location',
      description: 'Testing appointment creation with fixed endpoints'
    };

    console.log('Creating appointment...');
    const appointment = await createAppointment(
      appointmentData,
      TEST_CONFIG.passKey,
      TEST_CONFIG.orgId
    );

    console.log(`✅ Appointment created with ID: ${appointment.Id}`);

    // Step 2: Link contact to appointment
    if (contact) {
      console.log(`Linking contact ${contact.name} to appointment...`);

      const linkResult = await linkAttendees(
        appointment.Id,
        [contact.id],
        TEST_CONFIG.passKey,
        TEST_CONFIG.orgId
      );

      if (linkResult.successCount > 0) {
        console.log(`✅ Successfully linked ${linkResult.successCount} contact(s)`);
      }
      if (linkResult.failureCount > 0) {
        console.log(`⚠️ Failed to link ${linkResult.failureCount} contact(s)`);
      }
    }

    return appointment;
  } catch (error) {
    console.error('❌ Appointment test failed:', error.message);
    throw error;
  }
}

async function testTaskCreationWithLinking(contact) {
  console.log('\n=== Testing Task Creation with Contact Linking ===');

  try {
    // Step 1: Create task
    const taskData = {
      subject: `Test Task - ${new Date().toISOString()}`,
      description: 'Testing task creation with fixed endpoints',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Next week
      priority: 'High',
      status: 'Not Started'
    };

    console.log('Creating task...');
    const task = await createTask(
      taskData,
      TEST_CONFIG.passKey,
      TEST_CONFIG.orgId
    );

    console.log(`✅ Task created with ID: ${task.Id}`);

    // Step 2: Link contact to task
    if (contact) {
      console.log(`Linking contact ${contact.name} to task...`);

      const linkResult = await linkContactToActivity(
        'task',
        task.Id,
        contact.id,
        TEST_CONFIG.passKey,
        TEST_CONFIG.orgId
      );

      if (linkResult.linked) {
        console.log(`✅ Successfully linked contact using ${linkResult.linkerName}`);
      } else {
        console.log('⚠️ Failed to link contact');
      }
    }

    return task;
  } catch (error) {
    console.error('❌ Task test failed:', error.message);
    throw error;
  }
}

async function testContactResolverLinking(contact) {
  console.log('\n=== Testing ContactResolver linkActivity Method ===');

  try {
    const resolver = getContactResolver();

    // Create a test appointment first
    const appointment = await createAppointment(
      {
        subject: `ContactResolver Test - ${new Date().toISOString()}`,
        startTime: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        endTime: new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString()
      },
      TEST_CONFIG.passKey,
      TEST_CONFIG.orgId
    );

    console.log(`Created test appointment: ${appointment.Id}`);

    // Test linking via ContactResolver
    const linkResult = await resolver.linkActivity(
      'appointment',
      appointment.Id,
      contact.id,
      TEST_CONFIG.passKey,
      TEST_CONFIG.orgId
    );

    if (linkResult.linked) {
      console.log(`✅ ContactResolver.linkActivity successful with ${linkResult.linkerName}`);
    } else {
      console.log('⚠️ ContactResolver.linkActivity failed');
    }

    return linkResult;
  } catch (error) {
    console.error('❌ ContactResolver linking test failed:', error.message);
    throw error;
  }
}

async function runAllTests() {
  console.log('========================================');
  console.log('BSA Contact Linking Implementation Test');
  console.log('========================================');
  console.log(`Testing with PassKey: ${TEST_CONFIG.passKey.substring(0, 10)}...`);
  console.log(`Organization ID: ${TEST_CONFIG.orgId}`);

  try {
    // Test 1: Contact Search
    const contact = await testContactSearch();

    if (!contact) {
      console.log('\n⚠️ No contacts found. Please update TEST_CONFIG.contactName');
      return;
    }

    // Test 2: Appointment Creation with Linking
    await testAppointmentCreationWithLinking(contact);

    // Test 3: Task Creation with Linking
    await testTaskCreationWithLinking(contact);

    // Test 4: ContactResolver linkActivity
    await testContactResolverLinking(contact);

    console.log('\n========================================');
    console.log('✅ All tests completed successfully!');
    console.log('========================================');

  } catch (error) {
    console.log('\n========================================');
    console.log('❌ Test suite failed');
    console.log('========================================');
    console.error('Error details:', error);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  console.log('\nNote: Update TEST_CONFIG with valid PassKey and OrgId before running');
  console.log('You can also set TEST_PASSKEY and TEST_ORG_ID environment variables\n');

  // Uncomment to run tests:
  // runAllTests();
}

module.exports = {
  testContactSearch,
  testAppointmentCreationWithLinking,
  testTaskCreationWithLinking,
  testContactResolverLinking,
  runAllTests
};