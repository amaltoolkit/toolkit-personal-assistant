// Test script for individual graph nodes
// Tests each node in isolation with mock state

require('dotenv').config();

// Test intent classification
async function testIntentNode() {
  console.log("\n=== Testing Intent Node ===\n");
  
  const { intentNode, routeByIntent } = require('../graph/intent');
  
  // Test cases
  const testCases = [
    {
      message: "How do I create a workflow?",
      expected: "help_kb"
    },
    {
      message: "Create a workflow for client onboarding",
      expected: "action"
    },
    {
      message: "Show me how to create tasks and then create one for tomorrow",
      expected: "mixed"
    }
  ];
  
  for (const testCase of testCases) {
    const state = {
      messages: [
        { role: "human", content: testCase.message }
      ]
    };
    
    console.log(`Testing: "${testCase.message}"`);
    const result = await intentNode(state, {});
    console.log(`  Intent: ${result.intent} (expected: ${testCase.expected})`);
    console.log(`  Route: ${routeByIntent(result).join(", ")}`);
    console.log();
  }
}

// Test planning node
async function testPlanNode() {
  console.log("\n=== Testing Plan Node ===\n");
  
  const { planNode, getReadyActions } = require('../graph/plan');
  
  const testQueries = [
    "Create a workflow for client onboarding with 3 steps",
    "Schedule a meeting tomorrow at 3pm and create a follow-up task"
  ];
  
  for (const query of testQueries) {
    const state = {
      messages: [
        { role: "human", content: query }
      ],
      artifacts: {}
    };
    
    console.log(`Testing plan for: "${query}"`);
    const result = await planNode(state, {});
    
    if (result.plan && result.plan.length > 0) {
      console.log(`  Generated ${result.plan.length} actions:`);
      for (const action of result.plan) {
        console.log(`    - ${action.id} (${action.type}): depends on [${action.dependsOn.join(", ")}]`);
      }
      
      // Test ready actions
      const readyActions = getReadyActions(result);
      console.log(`  ${readyActions.length} actions ready immediately`);
    } else {
      console.log("  No plan generated");
    }
    console.log();
  }
}

// Test approval node
async function testApprovalNode() {
  console.log("\n=== Testing Approval Node ===\n");
  
  const { approvalBatchNode, isApprovalPending } = require('../graph/approval');
  
  // Test with safe mode enabled
  console.log("Test 1: Safe mode enabled with previews");
  const state1 = {
    previews: [
      {
        actionId: "act1",
        kind: "workflow",
        spec: { name: "Test Workflow", steps: [] }
      },
      {
        actionId: "act2",
        kind: "task",
        spec: { name: "Test Task", dueDate: "2024-01-15" }
      }
    ]
  };
  
  const config1 = {
    configurable: {}
  };
  
  // Note: This will attempt to call interrupt() which won't work outside graph context
  // We're just testing the logic flow
  try {
    const result1 = await approvalBatchNode(state1, config1);
    console.log("  Interrupt marker:", result1.interruptMarker || "none");
    console.log("  Approvals:", result1.approvals || "none");
  } catch (error) {
    console.log("  Expected error (interrupt not available):", error.message);
  }
  
  console.log();
}

// Test response finalizer
async function testResponseNode() {
  console.log("\n=== Testing Response Node ===\n");
  
  const { responseFinalizerNode } = require('../graph/response');
  
  const state = {
    messages: [
      { role: "human", content: "Create a workflow for client onboarding" }
    ],
    previews: [
      {
        actionId: "act1",
        kind: "workflow",
        spec: { name: "Client Onboarding", steps: [1, 2, 3] }
      }
    ],
    artifacts: {
      doneIds: ["act1"]
    },
    interruptMarker: null
  };
  
  const config = {
    configurable: {
      tone: "professional, direct"
    }
  };
  
  console.log("Generating response for completed workflow creation...");
  const result = await responseFinalizerNode(state, config);
  
  if (result.finalResponse) {
    console.log("\nGenerated message:");
    console.log(`  "${result.finalResponse.message.substring(0, 150)}..."`);
    console.log("\nFollow-up questions:");
    result.finalResponse.followups.forEach((q, i) => {
      console.log(`  Q${i + 1}: ${q}`);
    });
    
    if (result.finalResponse.ui?.actions) {
      console.log("\nUI Actions:", result.finalResponse.ui.actions.length);
    }
  }
  console.log();
}

// Test parallel execution logic
async function testParallelNodes() {
  console.log("\n=== Testing Parallel Nodes ===\n");
  
  const { ready, getExecutionLayers, allActionsDone } = require('../graph/parallel');
  
  // Create a test plan with dependencies
  const testPlan = [
    { id: "act1", type: "build_workflow", params: {}, dependsOn: [] },
    { id: "act2", type: "create_task", params: {}, dependsOn: [] },
    { id: "act3", type: "create_appointment", params: {}, dependsOn: ["act1"] },
    { id: "act4", type: "update_task", params: {}, dependsOn: ["act2", "act3"] }
  ];
  
  console.log("Test plan with 4 actions and dependencies");
  
  // Test execution layers
  const layers = getExecutionLayers(testPlan);
  console.log(`\nExecution will happen in ${layers.length} layers`);
  
  // Simulate execution
  const state = {
    plan: testPlan,
    artifacts: { doneIds: [] }
  };
  
  console.log("\nSimulating execution:");
  
  // Layer 1
  let readyActions = ready(state);
  console.log(`  Layer 1: ${readyActions.map(a => a.id).join(", ")} ready`);
  
  // Mark layer 1 as done
  state.artifacts.doneIds = ["act1", "act2"];
  
  // Layer 2
  readyActions = ready(state);
  console.log(`  Layer 2: ${readyActions.map(a => a.id).join(", ")} ready`);
  
  // Mark layer 2 as done
  state.artifacts.doneIds.push("act3");
  
  // Layer 3
  readyActions = ready(state);
  console.log(`  Layer 3: ${readyActions.map(a => a.id).join(", ")} ready`);
  
  // Mark all done
  state.artifacts.doneIds.push("act4");
  console.log(`\nAll actions done: ${allActionsDone(state)}`);
}

// Run all tests
async function runAllTests() {
  console.log("=" .repeat(60));
  console.log("GRAPH NODES TEST SUITE");
  console.log("=" .repeat(60));
  
  try {
    await testIntentNode();
    await testPlanNode();
    await testApprovalNode();
    await testResponseNode();
    await testParallelNodes();
    
    console.log("\n" + "=" .repeat(60));
    console.log("ALL TESTS COMPLETED");
    console.log("=" .repeat(60));
    
  } catch (error) {
    console.error("\n❌ Test failed:", error.message);
    console.error(error.stack);
  }
}

// Run tests
runAllTests().catch(console.error);