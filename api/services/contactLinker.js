/**
 * ContactLinker Service
 * 
 * Links contacts to activities (appointments, tasks, workflows)
 * with batch operations and error recovery.
 */

const axios = require('axios');
const { getErrorHandler } = require('./errorHandler');
const bsaConfig = require('../config/bsa');

class ContactLinker {
  constructor() {
    this.errorHandler = getErrorHandler();
    
    // Batch configuration
    this.batchSize = 10;
    this.batchDelay = 100; // ms between batches
  }

  /**
   * Link a single contact to an activity
   */
  async linkContact(activityType, activityId, contactId, passKey) {
    console.log(`[ContactLinker] Linking contact ${contactId} to ${activityType} ${activityId}`);
    
    const endpoint = this.getEndpoint(activityType);
    const payload = this.buildPayload(activityType, activityId, contactId);
    
    try {
      const response = await this.errorHandler.executeWithRetry(
        async () => {
          const result = await axios.post(
            bsaConfig.buildEndpoint(endpoint),
            payload,
            {
              headers: {
                'Authorization': `Bearer ${passKey}`,
                'Content-Type': 'application/json'
              },
              timeout: 10000
            }
          );
          return result.data;
        },
        {
          operation: `link_${activityType}_contact`,
          maxRetries: 2,
          circuitBreakerKey: 'contact_linking'
        }
      );
      
      console.log(`[ContactLinker] Successfully linked contact ${contactId}`);
      return {
        success: true,
        activityType,
        activityId,
        contactId
      };
      
    } catch (error) {
      console.error(`[ContactLinker] Failed to link contact:`, error.message);
      return {
        success: false,
        activityType,
        activityId,
        contactId,
        error: error.message
      };
    }
  }

  /**
   * Link multiple contacts to an activity
   */
  async linkMultipleContacts(activityType, activityId, contactIds, passKey) {
    console.log(`[ContactLinker] Linking ${contactIds.length} contacts to ${activityType} ${activityId}`);
    
    const results = [];
    
    // Process in batches
    for (let i = 0; i < contactIds.length; i += this.batchSize) {
      const batch = contactIds.slice(i, i + this.batchSize);
      
      console.log(`[ContactLinker] Processing batch ${Math.floor(i / this.batchSize) + 1}`);
      
      // Link contacts in parallel within batch
      const batchPromises = batch.map(contactId =>
        this.linkContact(activityType, activityId, contactId, passKey)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Process results
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            contactId: batch[index],
            error: result.reason?.message || 'Unknown error'
          });
        }
      });
      
      // Delay between batches to avoid rate limiting
      if (i + this.batchSize < contactIds.length) {
        await this.sleep(this.batchDelay);
      }
    }
    
    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`[ContactLinker] Linking complete: ${successful} succeeded, ${failed} failed`);
    
    return {
      total: contactIds.length,
      successful,
      failed,
      results
    };
  }

  /**
   * Link contacts from entities to an activity
   */
  async linkContactsFromEntities(activityType, activityId, entities, passKey) {
    console.log(`[ContactLinker] Linking contacts from entities`);
    
    // Extract contact IDs from entities
    const contactIds = [];
    
    for (const [key, entity] of Object.entries(entities)) {
      if (entity.type === 'contact' && entity.data?.id) {
        contactIds.push(entity.data.id);
      }
    }
    
    if (contactIds.length === 0) {
      console.log(`[ContactLinker] No contacts found in entities`);
      return {
        total: 0,
        successful: 0,
        failed: 0,
        results: []
      };
    }
    
    return await this.linkMultipleContacts(activityType, activityId, contactIds, passKey);
  }

  /**
   * Unlink a contact from an activity
   */
  async unlinkContact(activityType, activityId, contactId, passKey) {
    console.log(`[ContactLinker] Unlinking contact ${contactId} from ${activityType} ${activityId}`);
    
    const endpoint = this.getUnlinkEndpoint(activityType);
    const payload = this.buildPayload(activityType, activityId, contactId);
    
    try {
      const response = await axios.post(
        bsaConfig.buildEndpoint(endpoint),
        payload,
        {
          headers: {
            'Authorization': `Bearer ${passKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      
      console.log(`[ContactLinker] Successfully unlinked contact ${contactId}`);
      return {
        success: true,
        activityType,
        activityId,
        contactId
      };
      
    } catch (error) {
      console.error(`[ContactLinker] Failed to unlink contact:`, error.message);
      return {
        success: false,
        activityType,
        activityId,
        contactId,
        error: error.message
      };
    }
  }

  /**
   * Get all linked contacts for an activity
   */
  async getLinkedContacts(activityType, activityId, passKey) {
    console.log(`[ContactLinker] Getting linked contacts for ${activityType} ${activityId}`);
    
    const endpoint = this.getContactsEndpoint(activityType);
    
    try {
      const response = await axios.get(
        bsaConfig.buildEndpoint(endpoint),
        {
          params: {
            [`${activityType}Id`]: activityId
          },
          headers: {
            'Authorization': `Bearer ${passKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      
      const contacts = response.data?.Results || response.data?.contacts || [];
      
      console.log(`[ContactLinker] Found ${contacts.length} linked contacts`);
      return {
        success: true,
        contacts
      };
      
    } catch (error) {
      console.error(`[ContactLinker] Failed to get linked contacts:`, error.message);
      return {
        success: false,
        contacts: [],
        error: error.message
      };
    }
  }

  // Helper methods

  /**
   * Get the appropriate endpoint for linking
   */
  getEndpoint(activityType) {
    const endpoints = {
      appointment: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/linkContactToAppointment.json',
      task: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/linkContactToTask.json',
      workflow: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/linkContactToWorkflow.json'
    };
    
    return endpoints[activityType] || endpoints.appointment;
  }

  /**
   * Get the appropriate endpoint for unlinking
   */
  getUnlinkEndpoint(activityType) {
    const endpoints = {
      appointment: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/unlinkContactFromAppointment.json',
      task: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/unlinkContactFromTask.json',
      workflow: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/unlinkContactFromWorkflow.json'
    };
    
    return endpoints[activityType] || endpoints.appointment;
  }

  /**
   * Get the appropriate endpoint for retrieving contacts
   */
  getContactsEndpoint(activityType) {
    const endpoints = {
      appointment: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/getAppointmentContacts.json',
      task: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/getTaskContacts.json',
      workflow: '/endpoints/ajax/com.platform.vc.endpoints.data.VCDataEndpoint/getWorkflowContacts.json'
    };
    
    return endpoints[activityType] || endpoints.appointment;
  }

  /**
   * Build the payload for linking/unlinking
   */
  buildPayload(activityType, activityId, contactId) {
    return {
      [`${activityType}Id`]: activityId,
      contactId: contactId
    };
  }

  /**
   * Sleep helper for delays
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
let instance = null;

module.exports = {
  getContactLinker: () => {
    if (!instance) {
      instance = new ContactLinker();
    }
    return instance;
  },
  ContactLinker
};