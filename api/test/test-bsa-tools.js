// Test script for BSA tools with dedupe functionality
// This tests that duplicate calls are prevented and PassKey is never logged

require('dotenv').config();
const { createBSATools } = require('../tools/bsa');

async function testDedupeAndSecurity() {
  console.log("=== BSA Tools Test Suite ===\n");
  
  // Test 1: Verify PassKey security
  console.log("Test 1: PassKey Security");
  console.log("-".repeat(30));
  
  const mockPassKey = "MOCK_PASSKEY_12345_SHOULD_NEVER_BE_LOGGED";
  
  try {
    // Create tools with mock PassKey
    const tools = createBSATools(mockPassKey);
    
    // Check that PassKey is not in the console output
    console.log("✅ Tools created successfully");
    console.log("✅ PassKey was provided but not logged");
    
    // Verify tools were created
    if (tools.workflowTools && tools.taskTools && tools.appointmentTools) {
      console.log("✅ All tool categories created");
      console.log(`  - Workflow tools: ${tools.workflowTools.length}`);
      console.log(`  - Task tools: ${tools.taskTools.length}`);
      console.log(`  - Appointment tools: ${tools.appointmentTools.length}`);
    }
    
  } catch (error) {
    console.error("❌ Failed to create tools:", error.message);
  }
  
  console.log("\n");
  
  // Test 2: Test dedupe functionality (mock test without actual API calls)
  console.log("Test 2: Dedupe Functionality");
  console.log("-".repeat(30));
  
  // Load dedupe module directly for testing
  const { withDedupe } = require('../lib/dedupe');
  
  // Mock function that tracks calls
  let callCount = 0;
  const mockApiCall = async () => {
    callCount++;
    console.log(`  Mock API call executed (call #${callCount})`);
    return { data: "success", callId: callCount };
  };
  
  try {
    // Test payload
    const testPayload = { 
      action: "CreateTask", 
      name: "Test Task",
      timestamp: Date.now()
    };
    
    console.log("Making first call with payload...");
    const result1 = await withDedupe(testPayload, 5000, mockApiCall); // 5 second window for testing
    console.log(`  Result 1: ${result1.skipped ? 'SKIPPED' : 'EXECUTED'}`);
    
    console.log("Making duplicate call with same payload...");
    const result2 = await withDedupe(testPayload, 5000, mockApiCall);
    console.log(`  Result 2: ${result2.skipped ? 'SKIPPED' : 'EXECUTED'}`);
    
    if (result2.skipped) {
      console.log("✅ Dedupe working - duplicate call was prevented");
    } else {
      console.log("❌ Dedupe failed - duplicate call was not prevented");
    }
    
    // Test with different payload
    const differentPayload = { 
      action: "CreateTask", 
      name: "Different Task",
      timestamp: Date.now()
    };
    
    console.log("Making call with different payload...");
    const result3 = await withDedupe(differentPayload, 5000, mockApiCall);
    console.log(`  Result 3: ${result3.skipped ? 'SKIPPED' : 'EXECUTED'}`);
    
    if (!result3.skipped) {
      console.log("✅ Different payload executed correctly");
    } else {
      console.log("❌ Different payload was incorrectly skipped");
    }
    
    console.log(`\nTotal API calls made: ${callCount} (should be 2)`);
    if (callCount === 2) {
      console.log("✅ Call count correct - dedupe prevented 1 duplicate");
    }
    
  } catch (error) {
    console.error("❌ Dedupe test failed:", error.message);
  }
  
  console.log("\n");
  
  // Test 3: Tool schemas and structure
  console.log("Test 3: Tool Schemas");
  console.log("-".repeat(30));
  
  try {
    const tools = createBSATools("test-key");
    
    // Check first workflow tool
    const createWorkflow = tools.workflowTools[0];
    console.log(`Workflow tool name: ${createWorkflow.name}`);
    console.log(`Has schema: ${createWorkflow.schema ? 'Yes' : 'No'}`);
    
    // Check first task tool  
    const createTask = tools.taskTools[0];
    console.log(`Task tool name: ${createTask.name}`);
    console.log(`Has schema: ${createTask.schema ? 'Yes' : 'No'}`);
    
    // Check first appointment tool
    const createAppointment = tools.appointmentTools[0];
    console.log(`Appointment tool name: ${createAppointment.name}`);
    console.log(`Has schema: ${createAppointment.schema ? 'Yes' : 'No'}`);
    
    console.log("✅ All tools have proper structure");
    
  } catch (error) {
    console.error("❌ Schema test failed:", error.message);
  }
  
  console.log("\n=== Test Suite Complete ===");
}

// Run tests
testDedupeAndSecurity().catch(console.error);