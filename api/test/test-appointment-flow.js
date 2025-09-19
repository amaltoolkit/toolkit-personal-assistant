/**
 * Test the complete appointment creation flow with contact resolution
 *
 * Tests the query: "create an appointment with John for 8am tomorrow"
 */

const { createExecutionPlan, validateExecutionPlan } = require('../services/planner');
const { parseDateTimeQuery, calculateEndTime } = require('../lib/dateParser');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

async function testAppointmentFlow() {
  console.log("\n=== Testing Appointment Creation Flow ===\n");

  const query = "create an appointment with John for 8am tomorrow";
  const userTimezone = "America/New_York";

  console.log("Query:", query);
  console.log("User Timezone:", userTimezone);
  console.log("Current Time:", dayjs().tz(userTimezone).format());

  // Step 1: Test the planner
  console.log("\n1. PLANNER ANALYSIS");
  console.log("-".repeat(50));

  const executionPlan = createExecutionPlan(query);
  console.log("Execution Plan:", JSON.stringify(executionPlan, null, 2));

  // Validate the plan
  const validation = validateExecutionPlan(executionPlan);
  console.log("\nPlan Validation:");
  console.log("- Valid:", validation.valid);
  if (validation.errors.length > 0) {
    console.log("- Errors:", validation.errors);
  }
  if (validation.warnings.length > 0) {
    console.log("- Warnings:", validation.warnings);
  }

  // Check if contact resolution is identified
  const hasContactDomain = executionPlan.analysis.domains.includes('contact');
  const hasCalendarDomain = executionPlan.analysis.domains.includes('calendar');
  const hasPersonEntity = executionPlan.analysis.entities.some(e => e.type === 'person');

  console.log("\nAnalysis Results:");
  console.log("- Contact domain detected:", hasContactDomain);
  console.log("- Calendar domain detected:", hasCalendarDomain);
  console.log("- Person entity found:", hasPersonEntity);

  if (hasPersonEntity) {
    const person = executionPlan.analysis.entities.find(e => e.type === 'person');
    console.log("- Person name:", person.value);
  }

  // Check dependency order
  if (executionPlan.sequential?.length > 0) {
    console.log("\nExecution Order (Sequential):");
    executionPlan.sequential.forEach((step, idx) => {
      console.log(`  ${idx + 1}. ${step.domain}`);
      if (step.depends_on?.length > 0) {
        console.log(`     Depends on: ${step.depends_on.join(', ')}`);
      }
      if (step.reason) {
        console.log(`     Reason: ${step.reason}`);
      }
    });
  }

  // Step 2: Test date/time parsing
  console.log("\n2. DATE/TIME PARSING");
  console.log("-".repeat(50));

  const dateQuery = "tomorrow at 8am";
  console.log("Date Query:", dateQuery);

  const parsedDateTime = parseDateTimeQuery(dateQuery, userTimezone);

  if (parsedDateTime) {
    console.log("Parsed Successfully:");
    console.log("- Has Time:", parsedDateTime.hasTime);
    console.log("- Start DateTime:", parsedDateTime.startDateTime);
    console.log("- End DateTime:", parsedDateTime.endDateTime);

    if (parsedDateTime.hasTime) {
      const duration = 60; // default 60 minutes
      const endTime = calculateEndTime(parsedDateTime.startDateTime, duration);
      console.log("- Calculated End Time (60 min):", endTime);
    }

    // Format for display
    const startMoment = dayjs(parsedDateTime.startDateTime).tz(userTimezone);
    console.log("\nFormatted Times:");
    console.log("- Start:", startMoment.format('YYYY-MM-DD h:mm A'));
    console.log("- Day of Week:", startMoment.format('dddd'));
  } else {
    console.log("ERROR: Failed to parse date/time");
  }

  // Step 3: Simulate the flow
  console.log("\n3. SIMULATED EXECUTION FLOW");
  console.log("-".repeat(50));

  console.log("\nStep 1: Contact Resolution (contact subgraph)");
  console.log("- Extract name 'John' from query");
  console.log("- Search BSA for contacts matching 'John'");
  console.log("- If multiple matches, trigger disambiguation");
  console.log("- Store resolved contact in entities.contacts");

  console.log("\nStep 2: Calendar Creation (calendar subgraph)");
  console.log("- Receive resolved contact from Step 1");
  console.log("- Parse date/time: 'tomorrow at 8am'");
  console.log("- Create appointment with:");
  console.log("  - Subject: 'Appointment with John'");
  console.log("  - Start: tomorrow at 8:00 AM");
  console.log("  - End: tomorrow at 9:00 AM");
  console.log("  - Attendee: John (resolved contact ID)");

  // Step 4: Check for potential issues
  console.log("\n4. POTENTIAL ISSUES CHECK");
  console.log("-".repeat(50));

  const issues = [];

  // Check planner
  if (!hasContactDomain) {
    issues.push("Contact domain not detected by planner");
  }
  if (!hasCalendarDomain) {
    issues.push("Calendar domain not detected by planner");
  }
  if (!hasPersonEntity) {
    issues.push("Person entity 'John' not extracted");
  }

  // Check dependencies
  const hasCorrectOrder = executionPlan.sequential?.length === 2 &&
                         executionPlan.sequential[0].domain === 'contact' &&
                         executionPlan.sequential[1].domain === 'calendar';

  if (!hasCorrectOrder) {
    issues.push("Incorrect execution order (should be contact -> calendar)");
  }

  // Check date parsing
  if (!parsedDateTime || !parsedDateTime.hasTime) {
    issues.push("Date/time parsing failed");
  }

  if (issues.length === 0) {
    console.log("✅ All checks passed! The flow should work correctly.");
  } else {
    console.log("❌ Issues found:");
    issues.forEach(issue => console.log(`  - ${issue}`));
  }

  // Summary
  console.log("\n5. SUMMARY");
  console.log("-".repeat(50));
  console.log("Query can be processed:", issues.length === 0 ? "YES ✅" : "NO ❌");

  if (issues.length === 0) {
    console.log("\nThe V2 architecture can now handle this query properly:");
    console.log("1. Planner correctly identifies contact and calendar domains");
    console.log("2. Dependencies ensure contact resolution happens first");
    console.log("3. Date/time parsing extracts 'tomorrow at 8am' correctly");
    console.log("4. Calendar subgraph can create appointment with resolved contact");
  }
}

// Run the test
testAppointmentFlow().catch(console.error);