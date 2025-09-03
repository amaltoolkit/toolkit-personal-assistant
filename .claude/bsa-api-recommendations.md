# BSA API Recommendations from Developer

## Overview
This document captures the recommended API usage patterns provided by the BSA developer on 2025-09-03. These recommendations highlight that we've been using generic endpoints when purpose-built endpoints exist for calendar and contact operations.

## Current vs Recommended Approach

### Current Implementation Issues
1. Using generic `VCOrgDataEndpoint/list.json` for appointments
2. Client-side date filtering (fetching ALL appointments then filtering)
3. Separate API calls to get appointment attendees
4. Using `listLinked.json` for contact relationships
5. Limited to pagination constraints (100 items default)

### Recommended Implementation
1. Use purpose-built `VCCalendarEndpoint/getActivities.json` for calendar data
2. Server-side date filtering with `From` and `To` parameters
3. Attendees included directly in appointment response
4. Use `getMultiple.json` or `get.json` for contact details
5. No pagination limitations for date-filtered queries

## API Endpoint Details

### 1. Get Calendar Activities (Appointments)

**Endpoint:** `POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.calendar.VCCalendarEndpoint/getActivities.json`

**Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "IncludeAppointments": true,
  "IncludeExtendedProperties": false,
  "IncludeTasks": false,
  "From": "2025-09-01",
  "To": "2025-09-30",
  "IncludeAttendees": true,
  "OrganizationId": "f4116de7-df5f-4b50-ae2c-f5d7bfa74afd",
  "PassKey": "29ClwrATgyG9gc0q4YgPtRVDJG2lYmQHq3NxYu6FSVaDQOFX8ISyydZeXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
  "ObjectName": "appointment"
}
```

**Response Structure:**
```json
[
  {
    "Activities": [
      {
        "Type": "Appointment",
        "Attendees": {
          "CompanyIds": ["bc38d299-0902-44cf-bc74-421d41c54e3b"],
          "UserIds": ["32ad7a84-8108-404e-9ec6-47fb30e4fea6"],
          "ContactIds": [
            "1c12b44b-6e12-4b44-be56-1a2d51f05344",
            "40071328-2515-47da-8f17-c13d0c9b3162"
          ]
        },
        "Activity": {
          "Id": "6932a198-349a-4e55-a340-7f32c8f00338",
          "Subject": "Test Appointment",
          "Description": null,
          "StartTime": "2025-09-03T23:00:00.000Z",
          "EndTime": "2025-09-03T23:15:00.000Z",
          "Location": "https://www.zoom.us/823457283582328",
          "AllDay": false,
          "Complete": false,
          "RollOver": false,
          "AppointmentTypeId": "4c9c3a3d-be15-446b-a3b3-dd341fa25d7c",
          "CreatedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
          "CreatedOn": "2025-08-31T23:11:21.000Z",
          "ModifiedBy": "32ad7a84-8108-404e-9ec6-47fb30e4fea6",
          "ModifiedOn": "2025-09-01T02:33:14.000Z",
          "RecurrenceIndex": 0,
          "RecurringActivityId": null,
          "ExternalScheduleId": null,
          "AppliedAdvocateProcessId": null,
          "AdvocateProcessIndex": 0
        }
      }
    ],
    "Valid": true,
    "StackMessage": null,
    "ResponseMessage": "success"
  }
]
```

**Key Benefits:**
- Native date range filtering (server-side)
- Attendees included automatically (no separate call needed)
- Returns all matching appointments (no pagination issues)
- Includes company and user relationships

### 2. Get Multiple Contacts (Batch)

**Endpoint:** `POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/getMultiple.json`

**Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "IncludeExtendedProperties": false,
  "References": [
    {
      "Fields": [],
      "Id": "40071328-2515-47da-8f17-c13d0c9b3162",
      "OrganizationId": "f4116de7-df5f-4b50-ae2c-f5d7bfa74afd",
      "PassKey": "29ClwrATgyG9gc0q4YgPtRVDJG2lYmQHq3NxYu6FSVaDQOFX8ISyydZeXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
      "ObjectName": "contact"
    },
    {
      "Fields": [],
      "Id": "1c12b44b-6e12-4b44-be56-1a2d51f05344",
      "OrganizationId": "f4116de7-df5f-4b50-ae2c-f5d7bfa74afd",
      "PassKey": "29ClwrATgyG9gc0q4YgPtRVDJG2lYmQHq3NxYu6FSVaDQOFX8ISyydZeXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
      "ObjectName": "contact"
    }
  ],
  "OrganizationId": "f4116de7-df5f-4b50-ae2c-f5d7bfa74afd",
  "PassKey": "29ClwrATgyG9gc0q4YgPtRVDJG2lYmQHq3NxYu6FSVaDQOFX8ISyydZeXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
  "ObjectName": "contact"
}
```

**Response Structure:**
```json
{
  "Results": [
    {
      "Id": "40071328-2515-47da-8f17-c13d0c9b3162",
      "FirstName": "Norman",
      "LastName": "Albertson",
      "FullName": "Norman Albertson",
      "EMailAddress1": "norm.albertson@gmail.com",
      "MobilePhone": "(904) 348-5423",
      "JobTitle": "Senior Vice President",
      "CompanyName": null,
      "AddressLine1": "3637 Summit Dr",
      "City": "Jacksonville",
      "State": "FL",
      "Country": "USA",
      "BirthDate": "1985-05-28T12:00:00.000Z",
      "Anniversary": "2002-06-15T12:00:00.000Z",
      "MaritalStatus": "Married",
      "Gender": "Male",
      "Income": 120000,
      "Description": "- Do not call him on Monday and Tuesday\n- The best time to call is from 10 am to 2 pm Wednesday to Friday\n- His wife is diagnosed with chronic pain",
      "OccupationNotes": "- Has been at the company for 10 years. \n- Received an award for best-performing exec of the year\n- He loves what he does",
      "RecreationNotes": "- Big fan of hunting. He has a huge gun collection - 9mm and snipers\n- Avidly also goes to various breweries around the state",
      "ChildrensNames": "Sam Albertson\nTom Albertson\nSally Albertson",
      "ClientSince": "2004-08-04T12:00:00.000Z",
      "WebSiteUrl": "www.joblingosoftware.com",
      "CustomProps": {
        "props": [
          {
            "name": "account_number",
            "id": "2321fe57-4865-4d97-8c9e-af156f6600a0",
            "value": 111212323
          },
          {
            "name": "total_investments",
            "id": "ae3673a5-4e36-4259-8fc4-eed5c630e7fe",
            "value": {
              "ctype": "USD",
              "value": 278000
            }
          }
        ]
      }
    }
  ],
  "Valid": true,
  "StackMessage": null,
  "ResponseMessage": "success"
}
```

**Key Benefits:**
- Batch fetch multiple contacts in one call
- Returns full contact details including custom properties
- Efficient for getting attendee information after appointments

### 3. Get Single Contact Details

**Endpoint:** `POST https://rc.bluesquareapps.com/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/get.json`

**Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "PassKey": "29ClwrATgyG9gc0q4YgPtRVDJG2lYmQHq3NxYu6FSVaDQOFX8ISyydZeXgzffXh3LVwLvXs0muNbXmAP2LxeH0w",
  "OrganizationId": "f4116de7-df5f-4b50-ae2c-f5d7bfa74afd",
  "ObjectName": "contact",
  "ObjectId": "40071328-2515-47da-8f17-c13d0c9b3162",
  "IncludeExtendedProperties": true
}
```

**Response Structure:**
```json
[
  {
    "DataObject": {
      "Id": "40071328-2515-47da-8f17-c13d0c9b3162",
      "FirstName": "Norman",
      "LastName": "Albertson",
      "FullName": "Norman Albertson",
      "CustomProps": {
        "props": [...]
      }
    },
    "Valid": true,
    "StackMessage": null,
    "ResponseMessage": "success"
  }
]
```

**Key Benefits:**
- Get complete contact information
- Includes extended properties when requested
- Useful for detailed contact queries

## Contact Data Structure

### Standard Fields
- Personal: FirstName, LastName, FullName, NickName, Title, Suffix, MiddleName
- Contact: EMailAddress1/2/3, MobilePhone, Telephone1/2/3, Fax, Pager
- Address: AddressLine1/2/3, City, State, Country, Postal, PoBox
- Professional: JobTitle, Department, CompanyName, CompanyId, Income, WebSiteUrl
- Dates: BirthDate, Anniversary, ClientSince, ReviewDate
- Family: MaritalStatus, SpousePartnerName, SpousePartnerId, ChildrensNames
- Notes: Description, OccupationNotes, RecreationNotes, MoneyNotes, FamilyNotes
- Legal: ExecutorName, ExecutorId, PowerofAttorneyName, PowerofAttorneyId
- Government: GovernmentIdent, DriversLicenseNumber, DriversLicenseExpiry
- Financial: CreditLimit, CreditOnHold, Revenue, GroupInsurance, GroupPensionPlan
- System: Id, CreatedBy, CreatedOn, ModifiedBy, ModifiedOn, Private, OwningOrganizationUserId

### Custom Properties (CustomProps)
Contacts can have custom properties defined by the organization, such as:
- account_number (numeric)
- total_investments (currency with type)
- employer (text)
- linkedin (URL)
- goals (HTML/rich text)
- Various financial metrics (bonds, cash, stocks, ETFs percentages)

## Performance Implications

### Current Approach Problems
1. **Data Transfer**: Fetching ALL appointments (potentially thousands) to filter for a date range
2. **Processing**: Client-side filtering in JavaScript is inefficient
3. **Pagination**: Limited to 100 records per request, may miss appointments
4. **Multiple Calls**: Separate API call for each appointment's attendees
5. **Latency**: Multiple round trips increase response time

### Recommended Approach Benefits
1. **Data Transfer**: Only appointments in date range returned (80-90% reduction)
2. **Processing**: Server-side filtering is optimized and faster
3. **No Pagination Issues**: Date filtering returns all matching records
4. **Single Call**: Attendees included with appointments
5. **Latency**: Fewer API calls mean faster responses

## Migration Strategy Considerations

### Breaking Changes
- Response structure is different (Activities array vs Results array)
- Attendees format changed (embedded vs linked)
- Date fields may have different names
- Contact batch fetching requires different request format

### Backward Compatibility
- Keep existing functions temporarily with deprecation warnings
- Create new functions alongside old ones
- Migrate tools one at a time
- Test thoroughly with real data

### Error Handling
- New endpoints may have different error codes
- Validation requirements may differ
- Need to handle both old and new response formats during transition

## Implementation Priority

1. **High Priority**: 
   - Switch to `getActivities.json` for appointments (biggest performance gain)
   - Include attendees in appointment calls (eliminates extra API calls)

2. **Medium Priority**:
   - Implement batch contact fetching (improves efficiency)
   - Add server-side date filtering (better accuracy)

3. **Low Priority**:
   - Add single contact detail fetching (nice to have)
   - Extended properties support (only when needed)

## Testing Requirements

### Functional Tests
- Date range filtering with various formats
- Timezone handling for appointments
- Attendee extraction from new format
- Contact batch fetching with multiple IDs
- Error handling for invalid dates/IDs

### Performance Tests
- Compare response times (old vs new)
- Measure data transfer reduction
- Test with large date ranges
- Verify no pagination issues

### Integration Tests
- End-to-end assistant queries
- Tool compatibility with new data structures
- Error message formatting
- Response formatting for UI

## Notes for Future Implementation

1. The `From` and `To` date parameters appear to accept "YYYY-MM-DD" format
2. The `IncludeAttendees` flag is crucial for getting contact relationships
3. The `IncludeExtendedProperties` flag controls custom property inclusion
4. Contact IDs can be extracted from appointment attendees for batch fetching
5. The response is always wrapped in an array, even for single results
6. The `Valid` field indicates success (true) or failure (false)
7. Custom properties have complex structures (nested values, currency types)
8. Consider caching frequently accessed contacts to reduce API calls