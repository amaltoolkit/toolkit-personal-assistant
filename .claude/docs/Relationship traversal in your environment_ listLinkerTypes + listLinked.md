# **Relationship traversal in your environment: listLinkerTypes \+ listLinked (linker-first pattern)**

This guide shows exactly how to discover valid relationship types and then fetch linked records in **your** environment, where `listLinked` expects the **relationship type** as `ObjectName` and the **child type** as `ListObjectName`. It also covers auth, paging, sorting, custom fields, and batch hydration.

---

## **1\) What you’re doing**

* **Discover** which linkers exist for a base entity using **`listLinkerTypes`**. This returns the relationship types you can traverse.

* **Traverse** a specific relationship using **`listLinked`**. In your environment, set:

  * `ObjectName` \= the **linker** name (for example, `linker_appointments_contacts`)

  * `ListObjectName` \= the **child** logical type (for example, `contact`)

  * `LinkParentId` \= the **left-side** parent record Id (for example, the appointment Id)  
     The rest is standard: `PassKey`, `OrganizationId`, paging, sorting, totals, and optional custom fields.

All VCOrgDataEndpoint requests must include **PassKey** and **OrganizationId**. Keep the token fresh and send both on every call.

---

## **2\) Auth prerequisites**

* Obtain or refresh a **PassKey** via the login flow. PassKeys expire roughly every 10 minutes, so refresh before traversals.

* Include the **OrganizationId** you’re operating in on every call.

---

## **3\) Discover linkers with `listLinkerTypes`**

**Endpoint**  
 `POST https://{host}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/listLinkerTypes.json`

**Body (minimal)**

{  
  "PassKey": "\<FRESH\_PASSKEY\>",  
  "OrganizationId": "\<ORG\_UUID\>",  
  "ObjectName": "\<base logical name, e.g. 'appointment'\>"  
}

**Why**  
 This returns the **relationship types** available for the base object in your org. Use the `ObjectName` values from this result as the **linker names** for `listLinked`.

*Example of returned items (excerpt)*

* `ObjectName`: `linker_appointments_contacts` with `LeftObjectName: appointment` and `RightObjectName: contact`

* `ObjectName`: `linker_appointments_companies` with `RightObjectName: company`

* `ObjectName`: `linker_appointments_users` with `RightObjectName: organization_user`  
   (Your shared list came from this call.)

---

## **4\) Traverse links with `listLinked` (linker-first pattern)**

**Endpoint**  
 `POST https://{host}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/listLinked.json`

**Required fields**

* `PassKey`, `OrganizationId`

* `ObjectName`: the **relationship type** (linker)

* `ListObjectName`: the **child** type to return

* `LinkParentId`: the **left-side** parent Id (for example, the appointment Id)

**Paging and sorting**

* `ResultsPerPage`, `PageOffset`

* `AscendingOrder` and optional `OrderBy`

* `ReturnTotal`: include total count when you need it

**Custom fields**

* `IncludeExtendedProperties: true` returns custom fields. Use it only when needed.

**Example: appointment → contacts**

{  
  "PassKey": "\<FRESH\_PASSKEY\>",  
  "OrganizationId": "\<ORG\_UUID\>",  
  "ObjectName": "linker\_appointments\_contacts",  
  "ListObjectName": "contact",  
  "LinkParentId": "\<APPOINTMENT\_ID\>",  
  "AscendingOrder": true,  
  "ResultsPerPage": 50,  
  "PageOffset": 0  
}

Parameters shown above match the published schema for `listLinked` (auth, parent Id, child type, paging, sort, custom fields). You’re simply using your environment’s accepted behavior where `ObjectName` is the **linker** instead of the base.

---

## **5\) End-to-end examples**

### **A) Appointment → Contacts**

1. `listLinkerTypes` with `ObjectName: "appointment"` to discover linkers.

2. `listLinked` with:

{  
  "PassKey": "\<FRESH\>",  
  "OrganizationId": "\<ORG\>",  
  "ObjectName": "linker\_appointments\_contacts",  
  "ListObjectName": "contact",  
  "LinkParentId": "\<APPOINTMENT\_ID\>",  
  "ResultsPerPage": 50,  
  "PageOffset": 0,  
  "AscendingOrder": true  
}

3. `getMultiple` on `"contact"` with the returned Ids for full details.

### **B) Appointment → Companies**

Same as above, but:

"ObjectName": "linker\_appointments\_companies",  
"ListObjectName": "company"

### **C) Appointment → Participant Users**

"ObjectName": "linker\_appointments\_users",  
"ListObjectName": "organization\_user"

---

## **6\) Custom fields**

If you need org-specific custom fields, set `IncludeExtendedProperties: true` on `listLinked` and on `getMultiple` when hydrating. Budget for larger payloads when including these.

---

## **7\) Responses and errors**

* Expect `Valid`, `ResponseMessage`, optional `PassKey` rotation, and your data payload.

* Handle standard error envelopes and retry transient failures intelligently. Log `StackMessage` for debugging.

---

## **8\) Best practices**

* **Always** include fresh `PassKey` \+ `OrganizationId`. Tokens expire quickly by design.

* Cache `listLinkerTypes` per base object per session. Reuse the linker names for traversal.

* Keep `ResultsPerPage` modest for interactive UIs.

* Use descriptors to pick safe `OrderBy` fields that actually exist on the child type. This avoids sort errors across customized orgs.

---

## **10\) Quick reference**

* **Discover** relationships: `listLinkerTypes.json` → `{ PassKey, OrganizationId, ObjectName }` → returns linkers.

* **Traverse** using linker: `listLinked.json` → `{ PassKey, OrganizationId, ObjectName: "<linker>", ListObjectName: "<child>", LinkParentId, ResultsPerPage, PageOffset, AscendingOrder, [OrderBy], [ReturnTotal], [IncludeExtendedProperties] }`

---

## Types

[
  {
    "LinkerTypes": [
      {
        "LeftObjectName": "recurring_activity",
        "ObjectName": "linker_recurring_activities_users",
        "RightObjectName": "organization_user"
      },
      {
        "LeftObjectName": "contact",
        "ObjectName": "linker_contacts_companies",
        "RightObjectName": "company"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_contact",
        "RightObjectName": "contact"
      },
      {
        "LeftObjectName": "task",
        "ObjectName": "linker_tasks_companies",
        "RightObjectName": "company"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_addresses",
        "RightObjectName": "address"
      },
      {
        "LeftObjectName": "questionaire_question",
        "ObjectName": "linker_question_option",
        "RightObjectName": "questionaire_question_multiple_choice_option"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_notes",
        "RightObjectName": "note"
      },
      {
        "LeftObjectName": "org_file_entry",
        "ObjectName": "linker_files_file_folders",
        "RightObjectName": "org_folder"
      },
      {
        "LeftObjectName": "recurring_activity",
        "ObjectName": "linker_recurring_activities_contacts",
        "RightObjectName": "contact"
      },
      {
        "LeftObjectName": "recurring_activity",
        "ObjectName": "linker_recurring_activities_companies",
        "RightObjectName": "company"
      },
      {
        "LeftObjectName": "contact",
        "ObjectName": "linker_contacts_addresses",
        "RightObjectName": "address"
      },
      {
        "LeftObjectName": "company",
        "ObjectName": "linker_companies_addresses",
        "RightObjectName": "address"
      },
      {
        "LeftObjectName": "appointment",
        "ObjectName": "linker_appointments_companies",
        "RightObjectName": "company"
      },
      {
        "LeftObjectName": "task",
        "ObjectName": "linker_tasks_users",
        "RightObjectName": "organization_user"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_appointment_types",
        "RightObjectName": "appointment_type"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_custom",
        "RightObjectName": "__custom_entity_object__"
      },
      {
        "LeftObjectName": "appointment",
        "ObjectName": "linker_appointments_contacts",
        "RightObjectName": "contact"
      },
      {
        "LeftObjectName": "event",
        "ObjectName": "linker_event_event_participant",
        "RightObjectName": "contact"
      },
      {
        "LeftObjectName": "task",
        "ObjectName": "linker_tasks_contacts",
        "RightObjectName": "contact"
      },
      {
        "LeftObjectName": "contact",
        "ObjectName": "linker_contacts_recreations",
        "RightObjectName": "recreation"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_appointment",
        "RightObjectName": "appointment"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_task",
        "RightObjectName": "task"
      },
      {
        "LeftObjectName": "appointment",
        "ObjectName": "linker_appointments_users",
        "RightObjectName": "organization_user"
      },
      {
        "LeftObjectName": "event",
        "ObjectName": "linker_event_file_entry",
        "RightObjectName": "org_file_entry"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_company",
        "RightObjectName": "company"
      },
      {
        "LeftObjectName": "data_import",
        "ObjectName": "linker_data_import_entry_client_class",
        "RightObjectName": "client_class"
      }
    ],
    "Valid": true,
    "StackMessage": null,
    "ResponseMessage": "success"
  }
]
 
---