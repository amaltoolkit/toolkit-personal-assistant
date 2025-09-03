# Workflow Builder Agent Documentation

## Overview
The Workflow Builder Agent enables users to create and manage automated workflows/processes in the BSA CRM system. This agent will be part of the Phase II multi-agent system with LangGraph orchestration.

## Architecture Context
- **Phase II Goal**: Multiple specialized agents coordinated by LangGraph
- **Supervisor Agent**: Routes user queries to appropriate agents
- **Current Agents**:
  1. Activities Agent (appointments + tasks) - COMPLETED
  2. Workflow Builder Agent (process automation) - IN PROGRESS
  3. Contact Agent (people/companies) - FUTURE

## Workflow Creation Process

### Step 1: Create Process Shell

The first step is to create a container/shell for the workflow steps to exist in.

#### Endpoint
```
POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json
```

#### Headers
```json
{
  "Content-Type": "application/json"
}
```

#### Request Payload
```json
{
  "PassKey": "[USER_PASSKEY]",
  "OrganizationId": "[ORG_ID]",
  "ObjectName": "advocate_process",
  "DataObject": {
    "Name": "[Process Name]",
    "Description": "[Process Description]"
  },
  "IncludeExtendedProperties": false
}
```

#### Field Descriptions
- **PassKey**: Authentication token (auto-managed by our system)
- **OrganizationId**: Target organization ID
- **ObjectName**: Fixed value `"advocate_process"` for process creation
- **DataObject.Name**: User-friendly process name (e.g., "Financial Planning Process")
- **DataObject.Description**: Detailed description of what the process does
- **IncludeExtendedProperties**: Whether to include custom fields (typically false)

#### Example Request
```json
{
  "PassKey": "2rXfJWI-dVFktFBhdHerEpfY1OvAIfI3r3w24EBgjQbRGhyG1PaR5t5eXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
  "OrganizationId": "f4116de7-df5f-4b50-ae2c-f5d7bfa74afd",
  "ObjectName": "advocate_process",
  "DataObject": {
    "Name": "Financial Planning Process",
    "Description": "Process to streamline the internal financial planning process for the advisor and his team"
  },
  "IncludeExtendedProperties": false
}
```

#### Response Format
```json
[
  {
    "DataObject": {
      "Description": "Process to streamline the internal financial planning process for the advisor and his team",
      "CreatedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
      "ModifiedOn": "2025-09-03T21:29:58.768Z",
      "Id": "892746e5-ac95-4360-8e2b-a5ff50240f7b",
      "CreatedOn": "2025-09-03T21:29:58.768Z",
      "ModifiedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
      "Name": "Financial Planning Process"
    },
    "Valid": true,
    "StackMessage": null,
    "ResponseMessage": "success"
  }
]
```

#### Important Response Fields
- **DataObject.Id**: The created process ID (needed for Step 2 - adding workflow steps)
- **Valid**: Boolean indicating success
- **ResponseMessage**: Success/error message

### Step 2: Create Individual Workflow Steps

After creating the process shell, individual steps are added one by one to define the workflow sequence.

#### Endpoint
```
POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json
```
*Note: Same endpoint as Step 1, but with different ObjectName*

#### Headers
```json
{
  "Content-Type": "application/json"
}
```

#### Request Payload
```json
{
  "PassKey": "[USER_PASSKEY]",
  "OrganizationId": "[ORG_ID]",
  "ObjectName": "advocate_process_template",
  "DataObject": {
    "AdvocateProcessId": "[PROCESS_ID_FROM_STEP_1]",
    "Subject": "[Step Title]",
    "Description": "[Step Description]",
    "ActivityType": "[Task|Appointment]",
    "AppointmentTypeId": null,
    "Sequence": [NUMBER],
    "DayOffset": [DAYS],
    "StartTime": "[ISO_8601_DATETIME]",
    "EndTime": "[ISO_8601_DATETIME]",
    "AllDay": [true|false],
    "AssigneeType": "[ContactsOwner|ContactsOwnersAssistant]",
    "AssigneeId": null,
    "RollOver": [true|false],
    "Location": null
  },
  "IncludeExtendedProperties": false
}
```

#### Field Descriptions
- **ObjectName**: Fixed value `"advocate_process_template"` for step creation
- **AdvocateProcessId**: The process ID from Step 1 (links step to process)
- **Subject**: Brief title for the step
- **Description**: Detailed description of what needs to be done
- **ActivityType**: Either `"Task"` or `"Appointment"` based on the nature
- **AppointmentTypeId**: ID for specific appointment type (null for tasks)
- **Sequence**: Order number of this step in the process (1, 2, 3, etc.)
- **DayOffset**: Number of days allocated for completing this specific step
- **StartTime**: ISO 8601 datetime (for display purposes, shows completion time)
- **EndTime**: ISO 8601 datetime (for display purposes, shows completion time)
- **AllDay**: Whether this is an all-day activity
- **AssigneeType**: 
  - `"ContactsOwner"`: Assigns to the advisor
  - `"ContactsOwnersAssistant"`: Assigns to the advisor's assistant
- **AssigneeId**: Specific user ID (null uses AssigneeType logic)
- **RollOver**: If true, uncompleted steps automatically move to next day
- **Location**: Physical location for appointments (null for tasks)

#### Example Request
```json
{
  "PassKey": "2rXfJWI-dVFktFBhdHerEpfY1OvAIfI3r3w24EBgjQbRGhyG1PaR5t5eXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
  "OrganizationId": "f4116de7-df5f-4b50-ae2c-f5d7bfa74afd",
  "ObjectName": "advocate_process_template",
  "DataObject": {
    "AdvocateProcessId": "892746e5-ac95-4360-8e2b-a5ff50240f7b",
    "Subject": "Send discovery questionnaire",
    "Description": "Send a copy of the Discovery Questionnaire to the client via email",
    "ActivityType": "Task",
    "AppointmentTypeId": null,
    "Sequence": 1,
    "DayOffset": 1,
    "StartTime": "2025-06-27T09:00:00.000Z",
    "EndTime": "2025-06-27T10:00:00.000Z",
    "AllDay": true,
    "AssigneeType": "ContactsOwnersAssistant",
    "AssigneeId": null,
    "RollOver": true,
    "Location": null
  },
  "IncludeExtendedProperties": false
}
```

#### Response Format
```json
[
  {
    "DataObject": {
      "DayOffset": 1,
      "Description": "Send a copy of the Discovery Questionnaire to the client via email",
      "CreatedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
      "EndTime": "2025-06-27T10:00:00.000Z",
      "ModifiedOn": "2025-09-03T21:55:04.856Z",
      "RollOver": true,
      "ActivityType": "Task",
      "AppointmentTypeId": null,
      "StartTime": "2025-06-27T09:00:00.000Z",
      "Sequence": 1,
      "ModifiedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
      "Subject": "Send discovery questionnaire",
      "AdvocateProcessId": "892746e5-ac95-4360-8e2b-a5ff50240f7b",
      "AssigneeId": null,
      "AllDay": true,
      "AssigneeType": "ContactsOwnersAssistant",
      "Id": "5de36150-c56e-48f0-9246-824fc2b78b01",
      "CreatedOn": "2025-09-03T21:55:04.856Z",
      "Location": null
    },
    "Valid": true,
    "StackMessage": null,
    "ResponseMessage": "success"
  }
]
```

#### Important Response Fields
- **DataObject.Id**: The created step ID
- **Sequence**: Confirms the step order
- **Valid**: Boolean indicating success

#### Implementation Notes
1. Steps must be created sequentially (Sequence: 1, 2, 3, etc.)
2. Each step links to the process via AdvocateProcessId
3. DayOffset determines timeline progression
4. RollOver ensures critical steps aren't missed
5. AssigneeType determines automatic assignment logic

### Step 3: List Existing Processes

To retrieve all existing processes or specific process steps, use the list endpoint.

#### Endpoint
```
POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json
```

#### Headers
```json
{
  "Content-Type": "application/json"
}
```

#### List All Processes - Request Payload
```json
{
  "PassKey": "[USER_PASSKEY]",
  "OrganizationId": "[ORG_ID]",
  "ObjectName": "advocate_process"
}
```

#### List All Processes - Response Format
```json
[
  {
    "Results": [
      {
        "Description": "Process to streamline the internal financial planning process for the advisor and his team",
        "CreatedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
        "ModifiedOn": "2023-04-26T15:28:53.000Z",
        "Id": "01d88e2e-19e5-42bd-8c7f-0856302a9be5",
        "CreatedOn": "2023-04-26T15:28:53.000Z",
        "ModifiedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
        "Name": "Financial Planning and Projection"
      },
      {
        "Description": "A comprehensive process to onboard new clients...",
        "CreatedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
        "ModifiedOn": "2025-07-04T19:57:20.000Z",
        "Id": "07a15b4d-b645-4c13-9b0e-1f4d5920c255",
        "CreatedOn": "2025-07-04T19:57:20.000Z",
        "ModifiedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
        "Name": "New Client Onboarding Process"
      }
      // ... more processes
    ],
    "Valid": true,
    "TotalResults": 19,
    "StackMessage": null,
    "ResponseMessage": "success"
  }
]
```

#### List Steps for a Specific Process - Request Payload
```json
{
  "PassKey": "[USER_PASSKEY]",
  "OrganizationId": "[ORG_ID]",
  "ObjectName": "advocate_process_template",
  "ParentObjectName": "advocate_process",
  "ParentId": "[PROCESS_ID]"
}
```

#### Field Descriptions for Step Listing
- **ObjectName**: `"advocate_process_template"` to list steps
- **ParentObjectName**: `"advocate_process"` to indicate parent type
- **ParentId**: The process ID obtained from listing processes

#### Example: List Steps for "New Client Onboarding Process"
```json
{
  "PassKey": "2uQW2wOB32I1mQHgCIqVr0BZsw-0d4ZY0lSGdEtCD7ya3U6UjFfuKkZeXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
  "OrganizationId": "f4116de7-df5f-4b50-ae2c-f5d7bfa74afd",
  "ObjectName": "advocate_process_template",
  "ParentObjectName": "advocate_process",
  "ParentId": "07a15b4d-b645-4c13-9b0e-1f4d5920c255"
}
```

#### Implementation Notes for Listing
1. Use same `/list.json` endpoint for both processes and steps
2. Differentiate by ObjectName and presence of ParentId
3. Results include metadata like CreatedBy, ModifiedOn, etc.
4. TotalResults field indicates count of items returned

## Implementation Considerations

### Agent Design
1. **Tool Structure**:
   - `create_process`: Creates the process shell (returns process ID)
   - `add_process_step`: Adds individual steps to a process
   - `list_processes`: Lists all existing processes in the organization
   - `get_process_steps`: Gets all steps for a specific process using ParentId
   - `build_complete_workflow`: Orchestrates creation of process and all steps

2. **Natural Language Processing**:
   - Parse user's workflow description
   - Extract process name and description
   - Identify individual steps from user input
   - Map to BSA process structure

3. **Integration with LangGraph**:
   - Agent will be a node in the graph
   - Supervisor determines when to route to this agent
   - May need to coordinate with Activities Agent for task creation

### Security Considerations
- PassKey handled by backend (never exposed to frontend)
- Organization ID validation
- Process ownership tracking (CreatedBy/ModifiedBy)

### Error Handling
- Validate required fields before API call
- Handle BSA API errors (Valid: false scenarios)
- Provide user-friendly error messages
- Rollback strategy if step creation fails

## Complete Workflow Management

### API Operations Summary

1. **Create Process**: POST `/create.json` with ObjectName: `"advocate_process"`
2. **Add Steps**: POST `/create.json` with ObjectName: `"advocate_process_template"`
3. **List Processes**: POST `/list.json` with ObjectName: `"advocate_process"`
4. **Get Process Steps**: POST `/list.json` with ObjectName: `"advocate_process_template"` and ParentId

### Full Example: Creating a Financial Planning Process

1. **Create Process Shell**:
   - POST to `/create.json` with ObjectName: `"advocate_process"`
   - Returns Process ID: `892746e5-ac95-4360-8e2b-a5ff50240f7b`

2. **Add Steps Sequentially**:
   - Step 1: Send discovery questionnaire (Task, Assistant, 1 day)
   - Step 2: Schedule initial meeting (Appointment, Advisor, 1 day)
   - Step 3: Prepare financial analysis (Task, Advisor, 3 days)
   - Continue adding steps with incrementing Sequence numbers

3. **Verify Process**:
   - List all processes to see the new process
   - Get process steps using ParentId to verify all steps were added correctly

### Key Implementation Details

1. **Process Creation Flow**:
   - User describes workflow in natural language
   - Agent extracts process name and description
   - Create process shell (Step 1)
   - Parse individual steps from description
   - Add each step sequentially (Step 2)
   - Validate complete workflow

2. **Step Properties**:
   - **Tasks**: ActivityType="Task", often AllDay=true
   - **Appointments**: ActivityType="Appointment", specific times
   - **Assignment**: ContactsOwner (advisor) vs ContactsOwnersAssistant
   - **Timeline**: DayOffset creates cumulative timeline
   - **Rollover**: Critical steps should have RollOver=true

## Next Steps
1. ✅ Step 1 documentation (process shell creation)
2. ✅ Step 2 documentation (individual step creation)
3. ✅ Step 3 documentation (listing processes and steps)
4. Design agent tool schemas with Zod
5. Implement workflow builder functions
6. Create agent prompt and tools
7. Integrate with LangGraph orchestration

## Questions for Clarification
1. Can processes be updated after creation?
2. Can processes be deleted?
3. Is there a limit on number of steps per process?
4. Can steps have conditional logic/branching?
5. How are process templates handled?

---

*Last Updated: 2025-09-03*
*Status: Ready for implementation - All API operations documented (Create, Add Steps, List)*