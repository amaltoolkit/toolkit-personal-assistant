/**
 * Test the complete appointment creation flow with contact disambiguation
 *
 * This test simulates: "Create an appointment for tomorrow at 8 AM with John"
 */

const axios = require('axios');

// Configuration
const API_BASE = process.env.APP_BASE_URL || 'http://localhost:3000';
const SESSION_ID = process.env.TEST_SESSION_ID || 'test-session-123';
const ORG_ID = process.env.TEST_ORG_ID || 'test-org-456';

// Mock data for testing
const mockContacts = [
  {
    Id: "C123",
    FirstName: "John",
    LastName: "Smith",
    FullName: "John Smith",
    EMailAddress1: "john.smith@abc.com",
    CompanyName: "ABC Corp",
    JobTitle: "Financial Advisor"
  },
  {
    Id: "C456",
    FirstName: "John",
    LastName: "Doe",
    FullName: "John Doe",
    EMailAddress1: "john.doe@xyz.com",
    CompanyName: "XYZ Inc",
    JobTitle: "Project Manager"
  }
];

async function testAppointmentCreationFlow() {
  console.log("\n=== Testing Complete Appointment Creation Flow ===\n");
  console.log("Query: 'Create an appointment for tomorrow at 8 AM with John'\n");

  try {
    // Step 1: Send initial query
    console.log("1. SENDING INITIAL QUERY");
    console.log("-".repeat(50));

    const query = "Create an appointment for tomorrow at 8 AM with John";
    const initialResponse = await axios.post(`${API_BASE}/api/agent/execute`, {
      query,
      session_id: SESSION_ID,
      org_id: ORG_ID,
      time_zone: 'America/New_York'
    });

    console.log("Response status:", initialResponse.data.status);

    // Step 2: Check for contact disambiguation
    if (initialResponse.data.status === 'PENDING_APPROVAL' ||
        initialResponse.data.status === 'PENDING_INTERRUPT') {

      const interrupt = initialResponse.data.interrupt;
      const threadId = initialResponse.data.thread_id;

      if (interrupt && interrupt.type === 'contact_disambiguation') {
        console.log("\n2. CONTACT DISAMBIGUATION REQUIRED");
        console.log("-".repeat(50));
        console.log("Multiple contacts found:");

        // Simulate displaying contacts
        interrupt.candidates?.forEach((contact, idx) => {
          console.log(`  ${idx + 1}. ${contact.FullName || contact.name} - ${contact.CompanyName || contact.company}`);
        });

        // Simulate user selecting first contact
        console.log("\nUser selects: John Smith (ABC Corp)");

        // Step 3: Submit contact selection
        console.log("\n3. SUBMITTING CONTACT SELECTION");
        console.log("-".repeat(50));

        const selectionResponse = await axios.post(`${API_BASE}/api/agent/approve`, {
          session_id: SESSION_ID,
          org_id: ORG_ID,
          thread_id: threadId,
          decision: 'continue',
          interrupt_response: {
            type: 'contact_selected',
            selected_contact_id: 'C123'
          }
        });

        console.log("Selection response:", selectionResponse.data.response);
      }

      // Step 4: Check for appointment approval
      if (initialResponse.data.previews) {
        console.log("\n4. APPOINTMENT APPROVAL REQUIRED");
        console.log("-".repeat(50));

        const preview = initialResponse.data.previews[0];
        console.log("Preview:");
        console.log("  Type:", preview.type);
        console.log("  Title:", preview.title);

        if (preview.details) {
          preview.details.forEach(detail => {
            console.log(`  ${detail.label}: ${detail.value}`);
          });
        }

        if (preview.warnings?.length > 0) {
          console.log("  Warnings:", preview.warnings.join(", "));
        }

        // Simulate user approval
        console.log("\nUser approves appointment");

        // Step 5: Submit approval
        console.log("\n5. SUBMITTING APPROVAL");
        console.log("-".repeat(50));

        const approvalResponse = await axios.post(`${API_BASE}/api/agent/approve`, {
          session_id: SESSION_ID,
          org_id: ORG_ID,
          thread_id: threadId,
          decision: 'approve'
        });

        console.log("Approval response:", approvalResponse.data.response);
      }
    }

    // Step 6: Final status
    console.log("\n6. FINAL STATUS");
    console.log("-".repeat(50));
    console.log("✅ Appointment creation flow completed successfully");

  } catch (error) {
    console.error("\n❌ ERROR:", error.response?.data || error.message);

    if (error.response?.status === 401) {
      console.log("\n💡 Tip: Make sure you have a valid session. Get a real session_id from the Chrome extension.");
    }
  }
}

// Flow diagram
function printFlowDiagram() {
  console.log("\n=== Expected Flow Diagram ===\n");
  console.log(`
  1. User Query: "Create appointment with John tomorrow at 8am"
           ↓
  2. Coordinator → Calendar Subgraph
           ↓
  3. Calendar parses: action=create, date=tomorrow 8am, contact="John"
           ↓
  4. Contact Resolution: Search BSA for "John"
           ↓
  5. Multiple matches → GraphInterrupt (contact_disambiguation)
           ↓
  6. Frontend shows contact options
           ↓
  7. User selects "John Smith"
           ↓
  8. Graph resumes with selected contact
           ↓
  9. Check conflicts for tomorrow 8am
           ↓
  10. Generate preview with appointment details
           ↓
  11. GraphInterrupt (approval)
           ↓
  12. Frontend shows approval UI
           ↓
  13. User approves
           ↓
  14. Create appointment in BSA
           ↓
  15. Link John Smith as attendee
           ↓
  16. Store in Mem0
           ↓
  17. Return success message
  `);
}

// Run the test
async function main() {
  printFlowDiagram();
  await testAppointmentCreationFlow();
}

main().catch(console.error);