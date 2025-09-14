/**
 * BSA Contacts Module
 * Handles all contact-related operations with BSA API
 */

const { normalizeBSAResponse, buildBSAHeaders } = require('./common');
const bsaConfig = require('../../config/bsa');

/**
 * Search for contacts in BSA
 * @param {string} query - Search query (name, email, phone, etc.)
 * @param {number} limit - Maximum results to return
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Array>} Array of matching contacts
 */
async function searchContacts(query, limit = 50, passKey, orgId) {
  if (!query || query.trim().length === 0) {
    throw new Error('Search query is required');
  }

  console.log(`[BSA:CONTACTS:SEARCH] Searching for "${query}" (limit: ${limit})`);

  const axios = require('axios');

  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/search.json');
  const payload = {
    IncludeExtendedProperties: false,
    OrderBy: "LastName, FirstName",
    AscendingOrder: true,
    ResultsPerPage: limit,
    OrganizationId: orgId,
    PassKey: passKey,
    SearchTerm: query,
    PageOffset: 1,
    ObjectName: "contact"
  };

  try {
    const response = await axios.post(url, payload, {
      headers: buildBSAHeaders(passKey),
      timeout: 10000
    });

    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      console.warn(`[BSA:CONTACTS:SEARCH] No results found for "${query}"`);
      return [];
    }

    // Log total results for debugging
    if (normalized.TotalResults !== undefined) {
      console.log(`[BSA:CONTACTS:SEARCH] Total results available: ${normalized.TotalResults}`);
    }

    // Format contacts consistently - handle new BSA field names
    const contacts = (normalized.Results || normalized.contacts || normalized.data || []).map(c => ({
      id: c.Id || c.id,
      name: c.FullName || c.name || c.Name || `${c.FirstName || ''} ${c.LastName || ''}`.trim(),
      firstName: c.FirstName || c.firstName,
      lastName: c.LastName || c.lastName,
      email: c.EMailAddress1 || c.email || c.Email || c.EmailAddress,
      phone: c.Telephone1 || c.phone || c.Phone || c.PhoneNumber,
      mobile: c.MobilePhone || c.mobile || c.Mobile,
      fax: c.Fax || c.fax,
      company: c.CompanyName || c.company || c.Company || c.AccountName,
      title: c.JobTitle || c.title || c.Title,
      department: c.Department || c.department,
      address: c.AddressLine1 || c.address || c.Address || c.MailingAddress,
      city: c.City || c.city || c.MailingCity,
      state: c.State || c.state || c.MailingState,
      postalCode: c.Postal || c.postalCode || c.PostalCode || c.MailingPostalCode,
      country: c.Country || c.country || c.MailingCountry,
      // Additional fields from BSA
      birthDate: c.BirthDate,
      anniversary: c.Anniversary,
      maritalStatus: c.MaritalStatus,
      nickName: c.NickName,
      clientSince: c.ClientSince
    }));

    console.log(`[BSA:CONTACTS:SEARCH] Found ${contacts.length} contacts`);
    return contacts;
    
  } catch (error) {
    console.error('[BSA:CONTACTS:SEARCH] Error:', error.message);
    throw new Error(`Failed to search contacts: ${error.message}`);
  }
}

/**
 * Get contact details by ID
 * @param {string} contactId - Contact ID
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @param {boolean} includeExtendedProperties - Include custom fields
 * @returns {Promise<Object>} Contact details
 */
async function getContactDetails(contactId, passKey, orgId, includeExtendedProperties = false) {
  if (!contactId) {
    throw new Error('Contact ID is required');
  }

  console.log(`[BSA:CONTACTS:GET] Fetching contact ${contactId}`);
  
  const axios = require('axios');
  
  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/get.json');
  const payload = {
    entity: "Contact",
    id: contactId,
    orgId,
    PassKey: passKey,
    OrganizationId: orgId,
    IncludeExtendedProperties: includeExtendedProperties
  };

  try {
    const response = await axios.post(url, payload, {
      headers: buildBSAHeaders(passKey),
      timeout: 10000
    });

    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error('Contact not found');
    }

    const contact = normalized.Contact || normalized.Result || normalized.data;
    if (!contact) {
      throw new Error('Contact not found');
    }

    // Format contact consistently - handle new BSA field names
    return {
      id: contact.Id || contact.id,
      name: contact.FullName || contact.name || contact.Name || `${contact.FirstName || ''} ${contact.LastName || ''}`.trim(),
      firstName: contact.FirstName || contact.firstName,
      lastName: contact.LastName || contact.lastName,
      email: contact.EMailAddress1 || contact.email || contact.Email || contact.EmailAddress,
      phone: contact.Telephone1 || contact.phone || contact.Phone || contact.PhoneNumber,
      mobile: contact.MobilePhone || contact.mobile || contact.Mobile,
      fax: contact.Fax || contact.fax,
      company: contact.CompanyName || contact.company || contact.Company || contact.AccountName,
      title: contact.JobTitle || contact.title || contact.Title,
      department: contact.Department || contact.department,
      address: contact.AddressLine1 || contact.address || contact.Address || contact.MailingAddress,
      city: contact.City || contact.city || contact.MailingCity,
      state: contact.State || contact.state || contact.MailingState,
      postalCode: contact.Postal || contact.postalCode || contact.PostalCode || contact.MailingPostalCode,
      country: contact.Country || contact.country || contact.MailingCountry,
      notes: contact.Description || contact.notes || contact.Notes,
      lastModified: contact.ModifiedOn || contact.lastModified || contact.LastModifiedDate,
      createdDate: contact.CreatedOn || contact.createdDate || contact.CreatedDate,
      ownerId: contact.OwningOrganizationUserId || contact.ownerId || contact.OwnerId,
      birthDate: contact.BirthDate,
      anniversary: contact.Anniversary,
      maritalStatus: contact.MaritalStatus,
      nickName: contact.NickName,
      clientSince: contact.ClientSince,
      ...(includeExtendedProperties ? { extended: contact.ExtendedProperties || contact } : {})
    };
    
  } catch (error) {
    console.error('[BSA:CONTACTS:GET] Error:', error.message);
    throw new Error(`Failed to get contact details: ${error.message}`);
  }
}

/**
 * Get multiple contacts by IDs (batch operation)
 * @param {Array<string>} contactIds - Array of contact IDs
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @param {boolean} includeExtendedProperties - Include custom fields
 * @returns {Promise<Array>} Array of contact details
 */
async function getContactsByIds(contactIds, passKey, orgId, includeExtendedProperties = false) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return [];
  }

  console.log(`[BSA:CONTACTS:BATCH] Fetching ${contactIds.length} contacts`);
  
  const axios = require('axios');
  
  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/getMultiple.json');
  const payload = {
    IncludeExtendedProperties: includeExtendedProperties,
    References: contactIds.map(id => ({
      Fields: [],
      Id: id,
      OrganizationId: orgId,
      PassKey: passKey,
      ObjectName: "contact"
    })),
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "contact"
  };

  try {
    const response = await axios.post(url, payload, {
      headers: buildBSAHeaders(passKey),
      timeout: 15000 // Longer timeout for batch operations
    });

    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      console.warn('[BSA:CONTACTS:BATCH] No contacts found');
      return [];
    }

    const contacts = (normalized.Results || normalized.data || []).map(contact => ({
      id: contact.Id || contact.id,
      name: contact.FullName || contact.name || contact.Name || `${contact.FirstName || ''} ${contact.LastName || ''}`.trim(),
      firstName: contact.FirstName || contact.firstName,
      lastName: contact.LastName || contact.lastName,
      email: contact.EMailAddress1 || contact.email || contact.Email || contact.EmailAddress,
      phone: contact.Telephone1 || contact.phone || contact.Phone || contact.PhoneNumber,
      mobile: contact.MobilePhone || contact.mobile || contact.Mobile,
      company: contact.CompanyName || contact.company || contact.Company || contact.AccountName,
      title: contact.JobTitle || contact.title || contact.Title,
      ...(includeExtendedProperties ? { extended: contact.ExtendedProperties || contact } : {})
    }));

    console.log(`[BSA:CONTACTS:BATCH] Retrieved ${contacts.length} contacts`);
    return contacts;
    
  } catch (error) {
    console.error('[BSA:CONTACTS:BATCH] Error:', error.message);
    throw new Error(`Failed to fetch contacts: ${error.message}`);
  }
}

/**
 * Create a new contact in BSA
 * @param {Object} contactData - Contact information
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Created contact with ID
 */
async function createContact(contactData, passKey, orgId) {
  const { firstName, lastName, email, phone, company, title } = contactData;
  
  if (!firstName && !lastName && !email) {
    throw new Error('At least firstName, lastName, or email is required');
  }

  console.log(`[BSA:CONTACTS:CREATE] Creating contact: ${firstName} ${lastName}`);
  
  const axios = require('axios');
  
  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json');
  const payload = {
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "contact",
    DataObject: {
      FirstName: firstName || '',
      LastName: lastName || '',
      FullName: `${firstName || ''} ${lastName || ''}`.trim(),
      EMailAddress1: email || '',
      Telephone1: phone || '',
      CompanyName: company || '',
      JobTitle: title || '',
      MobilePhone: contactData.mobile || '',
      Fax: contactData.fax || '',
      Department: contactData.department || '',
      AddressLine1: contactData.address || '',
      City: contactData.city || '',
      State: contactData.state || '',
      Postal: contactData.postalCode || '',
      Country: contactData.country || '',
      Description: contactData.notes || ''
    }
  };

  try {
    const response = await axios.post(url, payload, {
      headers: buildBSAHeaders(passKey),
      timeout: 10000
    });

    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid || !normalized.Id) {
      throw new Error('Failed to create contact');
    }

    console.log(`[BSA:CONTACTS:CREATE] Created contact with ID: ${normalized.Id}`);
    
    return {
      id: normalized.Id,
      ...contactData,
      name: `${firstName || ''} ${lastName || ''}`.trim()
    };
    
  } catch (error) {
    console.error('[BSA:CONTACTS:CREATE] Error:', error.message);
    throw new Error(`Failed to create contact: ${error.message}`);
  }
}

/**
 * Update an existing contact
 * @param {string} contactId - Contact ID to update
 * @param {Object} updates - Fields to update
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Updated contact
 */
async function updateContact(contactId, updates, passKey, orgId) {
  if (!contactId) {
    throw new Error('Contact ID is required');
  }

  console.log(`[BSA:CONTACTS:UPDATE] Updating contact ${contactId}`);
  
  const axios = require('axios');
  
  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/update.json');
  
  // Map updates to BSA field names
  const dataObject = {
    Id: contactId
  };

  if (updates.firstName !== undefined) dataObject.FirstName = updates.firstName;
  if (updates.lastName !== undefined) dataObject.LastName = updates.lastName;
  if (updates.firstName !== undefined || updates.lastName !== undefined) {
    dataObject.FullName = `${updates.firstName || ''} ${updates.lastName || ''}`.trim();
  }
  if (updates.email !== undefined) dataObject.EMailAddress1 = updates.email;
  if (updates.phone !== undefined) dataObject.Telephone1 = updates.phone;
  if (updates.mobile !== undefined) dataObject.MobilePhone = updates.mobile;
  if (updates.company !== undefined) dataObject.CompanyName = updates.company;
  if (updates.title !== undefined) dataObject.JobTitle = updates.title;
  if (updates.department !== undefined) dataObject.Department = updates.department;
  if (updates.address !== undefined) dataObject.AddressLine1 = updates.address;
  if (updates.city !== undefined) dataObject.City = updates.city;
  if (updates.state !== undefined) dataObject.State = updates.state;
  if (updates.postalCode !== undefined) dataObject.Postal = updates.postalCode;
  if (updates.country !== undefined) dataObject.Country = updates.country;
  if (updates.notes !== undefined) dataObject.Description = updates.notes;

  const payload = {
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "contact",
    DataObject: dataObject
  };

  try {
    const response = await axios.post(url, payload, {
      headers: buildBSAHeaders(passKey),
      timeout: 10000
    });

    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error('Failed to update contact');
    }

    console.log(`[BSA:CONTACTS:UPDATE] Contact ${contactId} updated successfully`);
    
    // Return the updated contact details
    return await getContactDetails(contactId, passKey, orgId);
    
  } catch (error) {
    console.error('[BSA:CONTACTS:UPDATE] Error:', error.message);
    throw new Error(`Failed to update contact: ${error.message}`);
  }
}

/**
 * Delete a contact
 * @param {string} contactId - Contact ID to delete
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<boolean>} Success status
 */
async function deleteContact(contactId, passKey, orgId) {
  if (!contactId) {
    throw new Error('Contact ID is required');
  }

  console.log(`[BSA:CONTACTS:DELETE] Deleting contact ${contactId}`);
  
  const axios = require('axios');
  
  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/delete.json');
  const payload = {
    OrganizationId: orgId,
    PassKey: passKey,
    ObjectName: "contact",
    Id: contactId
  };

  try {
    const response = await axios.post(url, payload, {
      headers: buildBSAHeaders(passKey),
      timeout: 10000
    });

    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error('Failed to delete contact');
    }

    console.log(`[BSA:CONTACTS:DELETE] Contact ${contactId} deleted successfully`);
    return true;
    
  } catch (error) {
    console.error('[BSA:CONTACTS:DELETE] Error:', error.message);
    throw new Error(`Failed to delete contact: ${error.message}`);
  }
}

/**
 * Link a contact to an activity (appointment or task)
 * @param {string} activityType - 'appointment' or 'task'
 * @param {string} activityId - Activity ID
 * @param {string} contactId - Contact ID to link
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<boolean>} Success status
 */
async function linkContactToActivity(activityType, activityId, contactId, passKey, orgId) {
  if (!activityId || !contactId) {
    throw new Error('Activity ID and Contact ID are required');
  }

  // Map activity types to correct linker names (from listLinkerTypes documentation)
  const LINKER_NAMES = {
    'appointment': 'linker_appointments_contacts',
    'task': 'linker_tasks_contacts'
  };

  const linkerName = LINKER_NAMES[activityType];
  if (!linkerName) {
    throw new Error(`Unknown activity type for linking: ${activityType}`);
  }

  console.log(`[BSA:CONTACTS:LINK] Linking contact ${contactId} to ${activityType} ${activityId}`);

  const axios = require('axios');

  // Use the correct OrgData link endpoint with proper payload structure
  const url = bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/link.json');
  const payload = {
    LeftObjectName: activityType,      // 'appointment' or 'task'
    LeftId: activityId,                 // The activity ID
    ObjectName: linkerName,             // The specific linker type
    RightObjectName: 'contact',         // Always linking to contact
    RightId: contactId,                 // The contact ID
    OrganizationId: orgId,
    PassKey: passKey
  };

  try {
    const response = await axios.post(url, payload, {
      headers: buildBSAHeaders(passKey),
      timeout: 10000
    });

    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      console.warn(`[BSA:CONTACTS:LINK] Failed to link contact ${contactId} to ${activityType} ${activityId}`);
      return false;
    }

    console.log(`[BSA:CONTACTS:LINK] Successfully linked contact ${contactId} to ${activityType} ${activityId} using ${linkerName}`);
    return true;
    
  } catch (error) {
    console.error('[BSA:CONTACTS:LINK] Error:', error.message);
    throw new Error(`Failed to link contact: ${error.message}`);
  }
}

/**
 * Get recent interactions with a contact
 * @param {string} contactId - Contact ID
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @param {number} limit - Maximum number of interactions to return
 * @returns {Promise<Object>} Recent appointments and tasks
 */
async function getContactInteractions(contactId, passKey, orgId, limit = 10) {
  if (!contactId) {
    throw new Error('Contact ID is required');
  }

  console.log(`[BSA:CONTACTS:INTERACTIONS] Getting interactions for contact ${contactId}`);
  
  // Import appointments and tasks modules
  const { getAppointments } = require('./appointments');
  const { getTasks } = require('./tasks');
  
  try {
    // Fetch appointments and tasks in parallel
    const [appointments, tasks] = await Promise.all([
      getAppointments(passKey, orgId, {
        contactId,
        limit: Math.ceil(limit / 2)
      }).catch(err => {
        console.warn('[BSA:CONTACTS:INTERACTIONS] Failed to get appointments:', err.message);
        return [];
      }),
      getTasks(passKey, orgId, {
        contactId,
        limit: Math.ceil(limit / 2)
      }).catch(err => {
        console.warn('[BSA:CONTACTS:INTERACTIONS] Failed to get tasks:', err.message);
        return [];
      })
    ]);

    // Combine and sort by date
    const allInteractions = [
      ...appointments.map(a => ({ ...a, type: 'appointment' })),
      ...tasks.map(t => ({ ...t, type: 'task' }))
    ].sort((a, b) => {
      const dateA = new Date(a.startTime || a.dueDate || a.createdDate);
      const dateB = new Date(b.startTime || b.dueDate || b.createdDate);
      return dateB - dateA; // Most recent first
    }).slice(0, limit);

    console.log(`[BSA:CONTACTS:INTERACTIONS] Found ${allInteractions.length} interactions`);
    
    return {
      contactId,
      totalInteractions: allInteractions.length,
      appointments: appointments.slice(0, Math.ceil(limit / 2)),
      tasks: tasks.slice(0, Math.ceil(limit / 2)),
      combined: allInteractions
    };
    
  } catch (error) {
    console.error('[BSA:CONTACTS:INTERACTIONS] Error:', error.message);
    throw new Error(`Failed to get contact interactions: ${error.message}`);
  }
}

/**
 * Deduplicate contacts by merging duplicates
 * @param {Array<string>} contactIds - IDs of contacts to merge
 * @param {string} primaryContactId - ID of the primary contact to keep
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Merged contact
 */
async function mergeContacts(contactIds, primaryContactId, passKey, orgId) {
  if (!Array.isArray(contactIds) || contactIds.length < 2) {
    throw new Error('At least 2 contact IDs required for merge');
  }
  
  if (!contactIds.includes(primaryContactId)) {
    throw new Error('Primary contact ID must be in the list of contacts to merge');
  }

  console.log(`[BSA:CONTACTS:MERGE] Merging ${contactIds.length} contacts into ${primaryContactId}`);
  
  // Note: BSA may not have a direct merge API, so we'll implement a manual merge
  try {
    // Get all contact details
    const contacts = await getContactsByIds(contactIds, passKey, orgId, true);
    
    // Find the primary contact
    const primaryContact = contacts.find(c => c.id === primaryContactId);
    if (!primaryContact) {
      throw new Error('Primary contact not found');
    }
    
    // Merge data from other contacts into primary
    const mergedData = { ...primaryContact };
    const secondaryContacts = contacts.filter(c => c.id !== primaryContactId);
    
    for (const contact of secondaryContacts) {
      // Merge fields (prefer non-empty values)
      if (!mergedData.email && contact.email) mergedData.email = contact.email;
      if (!mergedData.phone && contact.phone) mergedData.phone = contact.phone;
      if (!mergedData.mobile && contact.mobile) mergedData.mobile = contact.mobile;
      if (!mergedData.company && contact.company) mergedData.company = contact.company;
      if (!mergedData.title && contact.title) mergedData.title = contact.title;
      if (!mergedData.address && contact.address) mergedData.address = contact.address;
      
      // Append notes
      if (contact.notes) {
        mergedData.notes = mergedData.notes 
          ? `${mergedData.notes}\n\nMerged from ${contact.name}:\n${contact.notes}`
          : contact.notes;
      }
    }
    
    // Update primary contact with merged data
    await updateContact(primaryContactId, mergedData, passKey, orgId);
    
    // Delete secondary contacts
    for (const contact of secondaryContacts) {
      try {
        await deleteContact(contact.id, passKey, orgId);
        console.log(`[BSA:CONTACTS:MERGE] Deleted duplicate contact ${contact.id}`);
      } catch (err) {
        console.warn(`[BSA:CONTACTS:MERGE] Failed to delete duplicate ${contact.id}:`, err.message);
      }
    }
    
    console.log(`[BSA:CONTACTS:MERGE] Successfully merged ${contactIds.length} contacts`);
    return mergedData;
    
  } catch (error) {
    console.error('[BSA:CONTACTS:MERGE] Error:', error.message);
    throw new Error(`Failed to merge contacts: ${error.message}`);
  }
}

module.exports = {
  searchContacts,
  getContactDetails,
  getContactsByIds,
  createContact,
  updateContact,
  deleteContact,
  linkContactToActivity,
  getContactInteractions,
  mergeContacts
};