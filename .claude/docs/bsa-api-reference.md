# BSA API Reference Documentation

## Table of Contents
1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Common Patterns](#common-patterns)
4. [Calendar & Activities](#calendar--activities)
5. [Appointments](#appointments)
6. [Contacts](#contacts)
7. [Relationships & Linking](#relationships--linking)
8. [Descriptors](#descriptors)
9. [Error Handling](#error-handling)
10. [Best Practices](#best-practices)

## Overview

The BlueSquare Apps (BSA) API provides comprehensive access to CRM functionality including calendar management, contact management, and relationship linking. This document serves as a complete reference for API integration.

**Base URL:** `https://rc.bluesquareapps.com`

**Key Principles:**
- All responses are wrapped in arrays, even single results
- PassKey authentication required for all data endpoints
- Organization ID required for all operations
- Server-side filtering preferred over client-side
- Purpose-built endpoints preferred over generic ones

## Authentication

### PassKey System
All API calls require a valid PassKey obtained through the OAuth flow:

1. **OAuth Token Exchange** → Bearer Token
2. **Bearer Token Exchange** → PassKey (1-hour expiry)
3. **PassKey Refresh** using existing PassKey before expiry

### Required Headers
```
Content-Type: application/json
```

### Required Authentication Fields
Every request must include:
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid"
}
```

## Common Patterns

### Response Structure
All API responses follow this pattern:
```json
[
  {
    "DataObject": { /* or specific field like "Activities", "Results" */ },
    "Valid": true,
    "ResponseMessage": "success",
    "StackMessage": null
  }
]
```

### Success Validation
Always check the `Valid` field:
```javascript
const normalized = normalizeBSAResponse(response.data);
if (!normalized.valid) {
  throw new Error(normalized.error || 'Invalid response');
}
```

### Date Formats
- Input: `YYYY-MM-DD` for date-only fields
- DateTime: ISO 8601 with timezone (e.g., `2025-09-10T14:00:00.000Z`)

## Calendar & Activities

### Get Activities (Appointments & Tasks)
**Endpoint:** `POST /endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivities.json`

**CRITICAL:** This is the ONLY endpoint to use for fetching appointments. Never use generic `get.json` for appointments.

**Why getActivities is mandatory:**
- Includes attendee relationships automatically
- Provides proper Type/Activity structure
- Server-side date filtering for performance
- Returns complete appointment context

**Request:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "IncludeAppointments": true,
  "IncludeTasks": false,
  "From": "2025-09-01",
  "To": "2025-09-30",
  "IncludeAttendees": true,
  "IncludeExtendedProperties": false,
  "ObjectName": "appointment"  // Optional, for appointments only
}
```

**Response:**
```json
[
  {
    "Activities": [
      {
        "Type": "Appointment",
        "Attendees": {
          "ContactIds": ["uuid"],
          "CompanyIds": ["uuid"],
          "UserIds": ["uuid"]
        },
        "Activity": {
          "Id": "uuid",
          "Subject": "string",
          "Description": "string",
          "StartTime": "2025-09-03T23:00:00.000Z",
          "EndTime": "2025-09-03T23:15:00.000Z",
          "Location": "string",
          "AllDay": false,
          "Complete": false,
          "AppointmentTypeId": "uuid",
          "CreatedBy": "uuid",
          "CreatedOn": "datetime",
          "ModifiedBy": "uuid",
          "ModifiedOn": "datetime"
        }
      }
    ],
    "Valid": true,
    "ResponseMessage": "success"
  }
]
```

**IMPORTANT Date Range Behavior:**
The BSA API has a specific requirement for date ranges. Using the same date for both `From` and `To` will return EMPTY results. You must expand the date range:

**Usage Examples:**

Fetch single day (e.g., today's appointments):
```json
{
  "From": "2025-09-09",  // Yesterday
  "To": "2025-09-10",    // Today
  "IncludeAppointments": true,
  "IncludeAttendees": true
}
```

**WRONG - This returns empty:**
```json
{
  "From": "2025-09-10",  // Same date
  "To": "2025-09-10",    // Same date - RETURNS NOTHING!
  "IncludeAppointments": true,
  "IncludeAttendees": true
}
```

Fetch week:
```json
{
  "From": "2025-09-08",  // Day before start
  "To": "2025-09-15",    // Actual end date
  "IncludeAppointments": true,
  "IncludeTasks": true,
  "IncludeAttendees": true
}
```

## Appointments

### Create Appointment
**Endpoint:** `POST /endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`

**Request:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "ObjectName": "appointment",
  "DataObject": {
    "Subject": "Client Meeting",           // Required
    "StartTime": "2025-09-10T14:00:00Z",  // Required
    "EndTime": "2025-09-10T15:00:00Z",    // Required
    "Description": "Quarterly review",
    "Location": "Conference Room A",
    "AllDay": false,
    "Complete": false,
    "RollOver": false,
    "AppointmentTypeId": null
  },
  "IncludeExtendedProperties": false
}
```

**Response:**
```json
[
  {
    "DataObject": {
      "Id": "656d48cd-c3b4-44af-9f4d-fc93fd85c705",
      "Subject": "Client Meeting",
      "StartTime": "2025-09-10T14:00:00.000Z",
      "EndTime": "2025-09-10T15:00:00.000Z",
      "CreatedOn": "2025-09-06T21:20:59.000Z",
      "CreatedBy": "uuid",
      "ModifiedOn": "2025-09-06T21:20:59.000Z",
      "ModifiedBy": "uuid"
    },
    "Valid": true,
    "ResponseMessage": "success"
  }
]
```

### Appointment Fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| Subject | String | Yes | Appointment title |
| StartTime | DateTime | Yes | ISO 8601 format |
| EndTime | DateTime | Yes | ISO 8601 format |
| Description | String | No | Detailed description |
| Location | String | No | Meeting location |
| AllDay | Boolean | No | All-day event flag |
| Complete | Boolean | No | Completion status |
| RollOver | Boolean | No | Auto-rollover incomplete |
| AppointmentTypeId | UUID | No | Type categorization |

## Contacts

### Get Multiple Contacts (Batch)
**Endpoint:** `POST /endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/getMultiple.json`

**Request:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "ObjectName": "contact",
  "IncludeExtendedProperties": false,
  "References": [
    {
      "Id": "contact-uuid-1",
      "OrganizationId": "uuid",
      "PassKey": "string",
      "ObjectName": "contact",
      "Fields": []
    },
    {
      "Id": "contact-uuid-2",
      "OrganizationId": "uuid",
      "PassKey": "string",
      "ObjectName": "contact",
      "Fields": []
    }
  ]
}
```

**Response:**
```json
[
  {
    "Results": [
      {
        "Id": "uuid",
        "FirstName": "John",
        "LastName": "Doe",
        "FullName": "John Doe",
        "EMailAddress1": "john@example.com",
        "MobilePhone": "(555) 123-4567",
        "JobTitle": "CEO",
        "CompanyName": "Acme Corp",
        "CustomProps": {
          "props": [
            {
              "name": "account_number",
              "id": "uuid",
              "value": 12345
            }
          ]
        }
      }
    ],
    "Valid": true,
    "ResponseMessage": "success"
  }
]
```

### Get Single Contact
**Endpoint:** `POST /endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/get.json`

**Request:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "ObjectName": "contact",
  "ObjectId": "contact-uuid",
  "IncludeExtendedProperties": true
}
```

### Contact Field Categories

#### Personal Information
- FirstName, LastName, FullName, NickName
- Title, Suffix, MiddleName
- BirthDate, Gender

#### Contact Details
- EMailAddress1, EMailAddress2, EMailAddress3
- MobilePhone, Telephone1, Telephone2, Telephone3
- Fax, Pager

#### Address
- AddressLine1, AddressLine2, AddressLine3
- City, State, Country, PostalCode

#### Professional
- JobTitle, Department, CompanyName, CompanyId
- Income, WebSiteUrl

#### Family
- MaritalStatus, SpousePartnerName, SpousePartnerId
- ChildrensNames

#### Notes
- Description, OccupationNotes, RecreationNotes
- MoneyNotes, FamilyNotes

#### System Fields
- Id, CreatedBy, CreatedOn
- ModifiedBy, ModifiedOn
- Private, OwningOrganizationUserId

## Relationships & Linking

### Link Entities (Attendees to Appointments)
**Endpoint:** `POST /endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/link.json`

**Linker Types:**
| Linker Type | Left Object | Right Object |
|-------------|-------------|--------------|
| linker_appointments_contacts | appointment | contact |
| linker_appointments_companies | appointment | company |
| linker_appointments_users | appointment | organization_user |

**Link Contact to Appointment:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "ObjectName": "linker_appointments_contacts",
  "LeftObjectName": "appointment",
  "LeftId": "appointment-uuid",
  "RightObjectName": "contact",
  "RightId": "contact-uuid"
}
```

**Link Company to Appointment:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "ObjectName": "linker_appointments_companies",
  "LeftObjectName": "appointment",
  "LeftId": "appointment-uuid",
  "RightObjectName": "company",
  "RightId": "company-uuid"
}
```

**Link User to Appointment:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "ObjectName": "linker_appointments_users",
  "LeftObjectName": "appointment",
  "LeftId": "appointment-uuid",
  "RightObjectName": "organization_user",  // Note: not "user"
  "RightId": "user-uuid"
}
```

### Discover Available Linkers
**Endpoint:** `POST /endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/listLinkerTypes.json`

**Request:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "ObjectName": "appointment"
}
```

**Response includes available linker types with their left/right object names.**

### List Linked Records
**Endpoint:** `POST /endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/listLinked.json`

**Request:**
```json
{
  "PassKey": "string",
  "OrganizationId": "uuid",
  "ObjectName": "linker_appointments_contacts",
  "ListObjectName": "contact",
  "LinkParentId": "appointment-uuid",
  "ResultsPerPage": 50,
  "PageOffset": 0,
  "AscendingOrder": true
}
```

## Descriptors

### Get Object Descriptor
**Endpoint:** `GET /endpoints/ajax/descriptors/com.platform.vc.data.{ObjectType}.json`

**Examples:**
- Appointment: `/descriptors/com.platform.vc.data.Appointment.json`
- Contact: `/descriptors/com.platform.vc.data.Contact.json`
- Task: `/descriptors/com.platform.vc.data.Task.json`

**Response:**
```json
[
  {
    "FieldName": {
      "type": "String|DateTime|UUID|Boolean|WholeNumber",
      "label": "Display Name",
      "description": "Field description",
      "required": true|false,
      "auto": true|false,
      "order": 1
    }
  }
]
```

## Error Handling

### Common Error Patterns
1. **Invalid PassKey:** Token expired or invalid
2. **Missing Required Fields:** Check descriptor for required fields
3. **Invalid Organization:** Verify organization ID
4. **Malformed Dates:** Use proper ISO 8601 format

### Error Response Structure
```json
[
  {
    "Valid": false,
    "ResponseMessage": "error description",
    "StackMessage": "detailed error stack"
  }
]
```

### Validation Function
```javascript
function normalizeBSAResponse(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return { valid: false, error: 'Invalid response format' };
  }
  
  const response = data[0];
  if (!response.Valid) {
    return { 
      valid: false, 
      error: response.ResponseMessage || 'Unknown error' 
    };
  }
  
  return {
    valid: true,
    data: response.DataObject || response.Activities || response.Results || response
  };
}
```

## Best Practices

### 1. Appointment Fetching
- **ALWAYS** use `getActivities.json` endpoint
- **NEVER** use generic `get.json` for appointments
- Include `IncludeAttendees: true` for relationship data
- Use server-side date filtering with From/To parameters

### 2. Performance Optimization
- Use batch endpoints (`getMultiple`) when possible
- Leverage server-side filtering over client-side
- Cache frequently accessed data (contacts, appointment types)
- Use HTTP Keep-Alive for connection reuse

### 3. Date Handling
- Always use ISO 8601 format for DateTime fields
- Use YYYY-MM-DD format for date-only parameters
- Consider timezone implications for appointments
- **CRITICAL:** Single-day queries MUST be expanded:
  - To fetch today: From = yesterday, To = today
  - To fetch specific date: From = date-1, To = date
  - Same date for From/To returns EMPTY results

### 4. Relationship Management
- Create entities first, then link relationships
- Use proper linker types (discover with `listLinkerTypes`)
- Remember: organization_user not user for RightObjectName
- Batch link operations when possible

### 5. Error Recovery
- Implement exponential backoff for retries
- Refresh PassKey proactively (before 5 minutes remaining)
- Log full error responses for debugging
- Handle both array and non-array response formats

### 6. Custom Properties
- Check `IncludeExtendedProperties` flag usage
- Custom props have complex structures (nested values)
- Currency fields include type (e.g., "USD")
- HTML/rich text fields may need sanitization

## Complete Workflows

### Create Appointment with Attendees
```javascript
// 1. Create appointment
const appointment = await createAppointment({
  Subject: "Team Meeting",
  StartTime: "2025-09-10T14:00:00Z",
  EndTime: "2025-09-10T15:00:00Z"
});

// 2. Link contact attendee
await linkAttendee({
  appointmentId: appointment.Id,
  contactId: "contact-uuid",
  type: "contact"
});

// 3. Link company attendee
await linkAttendee({
  appointmentId: appointment.Id,
  companyId: "company-uuid",
  type: "company"
});

// 4. Verify with getActivities
const activities = await getActivities({
  From: "2025-09-10",
  To: "2025-09-10",
  IncludeAttendees: true
});
```

### Fetch and Enrich Appointments
```javascript
// 1. Get appointments with attendees
const activities = await getActivities({
  From: startDate,
  To: endDate,
  IncludeAppointments: true,
  IncludeAttendees: true
});

// 2. Extract unique contact IDs
const contactIds = new Set();
activities.forEach(activity => {
  activity.Attendees?.ContactIds?.forEach(id => contactIds.add(id));
});

// 3. Batch fetch contact details
const contacts = await getMultipleContacts(Array.from(contactIds));

// 4. Enrich appointments with contact details
const enriched = activities.map(activity => ({
  ...activity,
  _enrichedContacts: contacts.filter(c => 
    activity.Attendees?.ContactIds?.includes(c.Id)
  )
}));
```

## API Limitations

1. **PassKey Expiry:** 1 hour, requires refresh
2. **Pagination:** Default 100 items (use date filtering to avoid)
3. **Response Arrays:** All responses wrapped in arrays
4. **Date Range Quirk:** Same From/To date returns empty - MUST expand by at least 1 day
5. **Linker Naming:** Right object names differ from linker names
6. **Single-Day Fetching:** To get today's data, use From=yesterday, To=today

## Migration Notes

When migrating from generic endpoints to purpose-built ones:

1. **Response Structure Changes:**
   - `Results` array → `Activities` array
   - Different field names and nesting
   - Attendees embedded vs separate calls

2. **Date Handling:**
   - Client-side filtering → Server-side From/To
   - Pagination concerns eliminated
   - More accurate date range queries

3. **Performance Gains:**
   - 80-90% reduction in data transfer
   - Fewer API calls needed
   - Server-side optimization

## Support Resources

- **API Base:** https://rc.bluesquareapps.com
- **OAuth Flow:** See authentication documentation
- **Descriptors:** Available at `/descriptors/` endpoints
- **Test Environment:** Use rc.bluesquareapps.com for testing