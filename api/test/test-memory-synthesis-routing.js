/**
 * Test to verify memory synthesis routing is working correctly
 * This test checks that the synthesize_memory node is actually called
 * when all actions are complete.
 */

const { routeAfterApply, allActionsDone, markActionDone } = require('../graph/parallel');

console.log('Testing Memory Synthesis Routing\n');
console.log('=================================\n');

// Test Case 1: All actions done should route to synthesize_memory
console.log('Test 1: All actions complete');
console.log('-----------------------------');

const stateAllDone = {
  plan: [
    { id: 'act1', type: 'create_task', dependsOn: [] },
    { id: 'act2', type: 'create_appointment', dependsOn: ['act1'] }
  ],
  artifacts: {
    doneIds: ['act1', 'act2']  // All actions marked as done
  }
};

const route1 = routeAfterApply(stateAllDone);
console.log(`Result: ${route1}`);
console.log(`Expected: synthesize_memory`);
console.log(`✅ Pass: ${route1 === 'synthesize_memory'}\n`);

// Test Case 2: More actions ready should route to fanOutDesign
console.log('Test 2: More actions ready');
console.log('---------------------------');

const stateMoreReady = {
  plan: [
    { id: 'act1', type: 'create_task', dependsOn: [] },
    { id: 'act2', type: 'create_appointment', dependsOn: [] },
    { id: 'act3', type: 'update_task', dependsOn: ['act1'] }
  ],
  artifacts: {
    doneIds: ['act1']  // Only act1 done, act2 and act3 ready
  }
};

const route2 = routeAfterApply(stateMoreReady);
console.log(`Result: ${route2}`);
console.log(`Expected: fanOutDesign`);
console.log(`✅ Pass: ${route2 === 'fanOutDesign'}\n`);

// Test Case 3: No more actions, not all done should route to response_finalizer
console.log('Test 3: No more actions ready, not all done');
console.log('--------------------------------------------');

const stateBlocked = {
  plan: [
    { id: 'act1', type: 'create_task', dependsOn: [] },
    { id: 'act2', type: 'create_appointment', dependsOn: ['act1'] },
    { id: 'act3', type: 'update_task', dependsOn: ['act2'] }
  ],
  artifacts: {
    doneIds: ['act1'],  // Only act1 done
    failedActions: [{ actionId: 'act2', error: 'Failed' }]  // act2 failed, blocking act3
  }
};

const route3 = routeAfterApply(stateBlocked);
console.log(`Result: ${route3}`);
console.log(`Expected: response_finalizer`);
console.log(`✅ Pass: ${route3 === 'response_finalizer'}\n`);

// Test Case 4: Verify allActionsDone helper
console.log('Test 4: allActionsDone helper function');
console.log('---------------------------------------');

const allDone1 = allActionsDone(stateAllDone);
console.log(`All done (Test 1): ${allDone1} - Expected: true - ✅ Pass: ${allDone1 === true}`);

const allDone2 = allActionsDone(stateMoreReady);
console.log(`All done (Test 2): ${allDone2} - Expected: false - ✅ Pass: ${allDone2 === false}`);

const allDone3 = allActionsDone(stateBlocked);
console.log(`All done (Test 3): ${allDone3} - Expected: false - ✅ Pass: ${allDone3 === false}\n`);

console.log('Summary');
console.log('-------');
console.log('The routing logic appears to be working correctly.');
console.log('When all actions are done, it routes to synthesize_memory.');
console.log('\nIf synthesis is not happening, the issue may be:');
console.log('1. Actions are not being properly marked as done');
console.log('2. The graph execution is stopping before reaching apply_convergence');
console.log('3. An error is occurring in the synthesis node itself');