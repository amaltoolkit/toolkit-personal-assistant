/**
 * Quick verification script for General Agent integration
 *
 * Tests:
 * 1. General subgraph can be loaded
 * 2. LLM Planner routes conversational queries to 'general'
 * 3. LLM Planner routes action queries to appropriate domains
 */

const { createExecutionPlan } = require('./services/llmPlanner');
const { createSubgraph } = require('./subgraphs/general');

async function testGeneralAgent() {
  console.log('=== Testing General Agent Integration ===\n');

  // Test 1: Load general subgraph
  console.log('Test 1: Loading general subgraph...');
  try {
    const generalGraph = await createSubgraph();
    console.log('✅ General subgraph loaded successfully\n');
  } catch (error) {
    console.error('❌ Failed to load general subgraph:', error.message);
    process.exit(1);
  }

  // Test 2: Planner routes conversational queries to 'general'
  console.log('Test 2: Testing planner routing for conversational queries...');
  const conversationalQueries = [
    "Hey, what's up?",
    "What was the second step?",
    "Show all my workflows",
    "How many workflows did I create?",
    "Thanks, goodbye"
  ];

  for (const query of conversationalQueries) {
    try {
      const plan = await createExecutionPlan(query);
      const hasGeneral = plan.parallel.includes('general') ||
                        plan.sequential.some(s => s.domain === 'general');

      if (hasGeneral) {
        console.log(`✅ "${query}" → general (confidence: ${plan.confidence || 'N/A'}, intent: ${plan.analysis?.intent || 'N/A'})`);
      } else {
        console.log(`⚠️  "${query}" → NOT routed to general. Domains:`, plan.parallel, plan.sequential);
      }
    } catch (error) {
      console.error(`❌ Error planning "${query}":`, error.message);
    }
  }

  console.log();

  // Test 3: Planner routes action queries to appropriate domains
  console.log('Test 3: Testing planner routing for action queries...');
  const actionQueries = [
    { query: "Create a client onboarding workflow", expectedDomains: ['workflow'] },
    { query: "Schedule a meeting for tomorrow at 2pm", expectedDomains: ['calendar'] },
    { query: "Add a task to follow up with John", expectedDomains: ['task'] },
    { query: "Find contact Sarah Smith", expectedDomains: ['contact'] }
  ];

  for (const { query, expectedDomains } of actionQueries) {
    try {
      const plan = await createExecutionPlan(query);
      const allDomains = [...plan.parallel, ...(plan.sequential.map(s => s.domain) || [])];

      const hasExpectedDomains = expectedDomains.every(d => allDomains.includes(d));
      const hasNoGeneral = !allDomains.includes('general');

      if (hasExpectedDomains && hasNoGeneral) {
        console.log(`✅ "${query}" → ${allDomains.join(', ')}`);
      } else if (!hasNoGeneral) {
        console.log(`⚠️  "${query}" → includes 'general' (should be action-only). Domains:`, allDomains);
      } else {
        console.log(`⚠️  "${query}" → missing expected domains. Expected: ${expectedDomains.join(', ')}, Got:`, allDomains);
      }
    } catch (error) {
      console.error(`❌ Error planning "${query}":`, error.message);
    }
  }

  console.log();

  // Test 4: Context-aware routing with entity state
  console.log('Test 4: Testing context-aware routing with entity state...');

  // Simulate having a workflow in the session
  const entityStatsWithWorkflow = {
    totalEntities: 1,
    byType: { workflow: 1, appointment: 0, task: 0 }
  };

  // Simulate conversation history
  const recentMessages = [
    { role: 'user', content: 'Create a client onboarding workflow' },
    { role: 'assistant', content: 'Successfully created workflow "Client Onboarding" with 3 steps.' }
  ];

  const contextAwareQueries = [
    { query: "What was step 2?", expectedDomain: 'general', context: 'has workflow' },
    { query: "Show all my workflows", expectedDomain: 'general', context: 'has workflow' },
  ];

  for (const { query, expectedDomain, context } of contextAwareQueries) {
    try {
      const plan = await createExecutionPlan(query, null, entityStatsWithWorkflow, recentMessages);
      const allDomains = [...plan.parallel, ...(plan.sequential.map(s => s.domain) || [])];

      if (allDomains.includes(expectedDomain)) {
        console.log(`✅ "${query}" → ${expectedDomain} (${context}, confidence: ${plan.confidence || 'N/A'})`);
      } else {
        console.log(`⚠️  "${query}" → ${allDomains.join(', ')} (expected ${expectedDomain})`);
      }
    } catch (error) {
      console.error(`❌ Error planning "${query}":`, error.message);
    }
  }

  console.log('\n=== Test Complete ===');
}

// Run tests
testGeneralAgent().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});
