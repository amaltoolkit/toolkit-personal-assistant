/**
 * BSA Workflows Tools
 * Extracted from workflowBuilderAgent.js for modular architecture
 */

const axios = require('axios');
const { normalizeBSAResponse, buildBSAHeaders, handleBSAError, retryWithBackoff } = require('./common');
const bsaConfig = require('../../config/bsa');

/**
 * Create a new workflow process container
 * @param {string} name - Name of the workflow process
 * @param {string} description - Description of the workflow
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Created process data
 */
async function createWorkflow(name, description, passKey, orgId) {
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json';
  
  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process",
    DataObject: {
      Name: name,
      Description: description
    },
    IncludeExtendedProperties: false
  };

  console.log("[BSA:WORKFLOWS] Creating workflow:", name);
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to create workflow');
    }
    
    const processData = normalized.data?.[0]?.DataObject || normalized.data?.DataObject;
    if (!processData?.Id) {
      throw new Error('No workflow ID returned');
    }
    
    console.log("[BSA:WORKFLOWS] Created workflow ID:", processData.Id);
    
    return {
      id: processData.Id,
      name: processData.Name,
      description: processData.Description,
      createdOn: processData.CreatedOn
    };
  } catch (error) {
    console.error('[BSA:WORKFLOWS] Error creating workflow:', error.message);
    throw error;
  }
}

/**
 * Add a step to an existing workflow
 * @param {string} workflowId - Workflow ID to add step to
 * @param {Object} stepData - Step configuration
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Created step data
 */
async function addWorkflowStep(workflowId, stepData, passKey, orgId) {
  // Validate step limit (BSA limit is 22 steps)
  if (stepData.sequence > 22) {
    throw new Error('Workflow cannot have more than 22 steps (BSA limitation)');
  }
  
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json';
  
  // Generate default times for the step (9 AM - 10 AM in UTC)
  const now = new Date();
  const startTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
  const endTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0));

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process_template",
    DataObject: {
      AdvocateProcessId: workflowId,
      Subject: stepData.subject,
      Description: stepData.description || "",
      ActivityType: stepData.activityType || "Task",
      AppointmentTypeId: stepData.appointmentTypeId || null,
      Sequence: stepData.sequence,
      DayOffset: stepData.dayOffset || 1,
      StartTime: stepData.startTime || startTime.toISOString(),
      EndTime: stepData.endTime || endTime.toISOString(),
      AllDay: stepData.allDay !== false,
      AssigneeType: stepData.assigneeType || "ContactsOwner",
      AssigneeId: stepData.assigneeId || null,
      RollOver: stepData.rollOver !== false,
      Location: stepData.location || null
    },
    IncludeExtendedProperties: false
  };

  console.log(`[BSA:WORKFLOWS] Adding step ${stepData.sequence} to workflow ${workflowId}`);
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to add workflow step');
    }
    
    const stepResponse = normalized.data?.[0]?.DataObject || normalized.data?.DataObject;
    
    console.log(`[BSA:WORKFLOWS] Added step ${stepResponse.Sequence}: ${stepResponse.Subject}`);
    
    return {
      id: stepResponse.Id,
      sequence: stepResponse.Sequence,
      subject: stepResponse.Subject,
      activityType: stepResponse.ActivityType
    };
  } catch (error) {
    console.error('[BSA:WORKFLOWS] Error adding step:', error.message);
    throw error;
  }
}

/**
 * List all workflows in the organization
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} List of workflows
 */
async function listWorkflows(passKey, orgId) {
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json';

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process"
  };

  console.log("[BSA:WORKFLOWS] Listing all workflows");
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to list workflows');
    }
    
    const results = normalized.data?.Results || [];
    
    console.log(`[BSA:WORKFLOWS] Found ${results.length} workflows`);
    
    return {
      workflows: results.map(w => ({
        id: w.Id,
        name: w.Name,
        description: w.Description,
        createdOn: w.CreatedOn,
        modifiedOn: w.ModifiedOn
      })),
      count: results.length
    };
  } catch (error) {
    console.error('[BSA:WORKFLOWS] Error listing workflows:', error.message);
    throw error;
  }
}

/**
 * Get all steps for a specific workflow
 * @param {string} workflowId - Workflow ID
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Workflow steps
 */
async function getWorkflowSteps(workflowId, passKey, orgId) {
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/list.json';

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process_template",
    ParentObjectName: "advocate_process",
    ParentId: workflowId
  };

  console.log(`[BSA:WORKFLOWS] Getting steps for workflow ${workflowId}`);
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to get workflow steps');
    }
    
    const results = normalized.data?.Results || [];
    
    // Sort by sequence number
    results.sort((a, b) => (a.Sequence || 0) - (b.Sequence || 0));
    
    console.log(`[BSA:WORKFLOWS] Found ${results.length} steps`);
    
    return {
      steps: results.map(s => ({
        id: s.Id,
        sequence: s.Sequence,
        subject: s.Subject,
        description: s.Description,
        activityType: s.ActivityType,
        dayOffset: s.DayOffset,
        assigneeType: s.AssigneeType,
        rollOver: s.RollOver,
        allDay: s.AllDay
      })),
      count: results.length,
      workflowId: workflowId
    };
  } catch (error) {
    console.error('[BSA:WORKFLOWS] Error getting steps:', error.message);
    throw error;
  }
}

/**
 * Delete a workflow
 * @param {string} workflowId - Workflow ID to delete
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Deletion result
 */
async function deleteWorkflow(workflowId, passKey, orgId) {
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/delete.json';

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process",
    Id: workflowId
  };

  console.log(`[BSA:WORKFLOWS] Deleting workflow ${workflowId}`);
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to delete workflow');
    }
    
    console.log("[BSA:WORKFLOWS] Successfully deleted workflow");
    
    return { deleted: true, workflowId };
  } catch (error) {
    console.error('[BSA:WORKFLOWS] Error deleting workflow:', error.message);
    throw error;
  }
}

/**
 * Update workflow metadata
 * @param {string} workflowId - Workflow ID to update
 * @param {Object} updates - Fields to update
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Updated workflow
 */
async function updateWorkflow(workflowId, updates, passKey, orgId) {
  const endpoint = '/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/update.json';

  const payload = {
    PassKey: passKey,
    OrganizationId: orgId,
    ObjectName: "advocate_process",
    DataObject: {
      Id: workflowId,
      ...updates
    }
  };

  console.log(`[BSA:WORKFLOWS] Updating workflow ${workflowId}`);
  
  try {
    const response = await axios.post(
      bsaConfig.buildEndpoint(endpoint),
      payload,
      {
        headers: buildBSAHeaders(passKey),
        timeout: 10000
      }
    );
    
    const normalized = normalizeBSAResponse(response.data);
    if (!normalized.valid) {
      throw new Error(normalized.error || 'Failed to update workflow');
    }
    
    const workflowData = normalized.data?.[0]?.DataObject || normalized.data?.DataObject;
    
    console.log("[BSA:WORKFLOWS] Successfully updated workflow");
    
    return {
      id: workflowData.Id,
      name: workflowData.Name,
      description: workflowData.Description,
      modifiedOn: workflowData.ModifiedOn
    };
  } catch (error) {
    console.error('[BSA:WORKFLOWS] Error updating workflow:', error.message);
    throw error;
  }
}

/**
 * Parse natural language workflow description into structured steps
 * @param {string} description - Natural language description
 * @returns {Object} Parsed workflow structure
 */
function parseWorkflowDescription(description) {
  // Extract process name and description
  const lines = description.split('\n').filter(l => l.trim());
  let workflowName = "New Workflow";
  let workflowDescription = description;
  let steps = [];
  
  // Try to find a clear workflow name
  const namePatterns = [
    /create (?:a |an )?(?:new )?(?:workflow|process) (?:for|called|named) ["']?([^"']+)["']?/i,
    /["']([^"']+)["'] (?:workflow|process)/i,
    /(?:workflow|process):?\s*["']?([^"'\n]+)["']?/i
  ];
  
  for (const pattern of namePatterns) {
    const match = description.match(pattern);
    if (match) {
      workflowName = match[1].trim();
      break;
    }
  }
  
  // Look for numbered steps
  const numberedSteps = [...description.matchAll(/(?:step )?(\d+)\.?\s*:?\s*(.+)/gi)];
  if (numberedSteps.length > 0) {
    steps = numberedSteps.map((match, idx) => {
      const stepText = match[2].trim();
      return parseStepText(stepText, idx + 1);
    });
  } else {
    // Try bullet points
    const bulletSteps = [...description.matchAll(/-\s+(.+)/g)];
    if (bulletSteps.length > 0) {
      steps = bulletSteps.map((match, idx) => {
        const stepText = match[1].trim();
        return parseStepText(stepText, idx + 1);
      });
    } else {
      // Try sequential keywords
      const sequentialSteps = [...description.matchAll(/(?:then|next|after that|first|second|third|finally),?\s+(.+)/gi)];
      if (sequentialSteps.length > 0) {
        steps = sequentialSteps.map((match, idx) => {
          const stepText = match[1].trim();
          return parseStepText(stepText, idx + 1);
        });
      }
    }
  }
  
  // If no steps found, create a single step
  if (steps.length === 0) {
    steps = [{
      sequence: 1,
      subject: "Complete workflow",
      description: description,
      activityType: "Task",
      dayOffset: 1,
      assigneeType: "ContactsOwner",
      rollOver: true
    }];
  }
  
  // Validate step count
  if (steps.length > 22) {
    console.warn(`[BSA:WORKFLOWS] Warning: ${steps.length} steps detected, but BSA limit is 22. Truncating.`);
    steps = steps.slice(0, 22);
  }
  
  return {
    workflowName,
    workflowDescription,
    steps
  };
}

/**
 * Parse individual step text into structured data
 * @private
 */
function parseStepText(text, sequence) {
  // Determine activity type
  const taskKeywords = /send|prepare|review|complete|fill|create|write|analyze|document|email|submit/i;
  const appointmentKeywords = /meeting|appointment|call|consultation|conference|presentation|interview/i;
  
  const activityType = appointmentKeywords.test(text) ? "Appointment" : "Task";
  
  // Determine assignee
  const assistantKeywords = /assistant|secretary|admin|support/i;
  const assigneeType = assistantKeywords.test(text) ? "ContactsOwnersAssistant" : "ContactsOwner";
  
  // Extract day offset
  let dayOffset = 1;
  const dayPatterns = [
    /within (\d+) days?/i,
    /(\d+) days? to/i,
    /takes? (\d+) days?/i,
    /(\d+) days? deadline/i
  ];
  
  for (const pattern of dayPatterns) {
    const match = text.match(pattern);
    if (match) {
      dayOffset = parseInt(match[1], 10);
      break;
    }
  }
  
  if (/same day|immediately|today|urgent/i.test(text)) {
    dayOffset = 0;
  } else if (/next day|tomorrow/i.test(text)) {
    dayOffset = 1;
  } else if (/week/i.test(text)) {
    dayOffset = 7;
  }
  
  // Extract subject (first part of text up to punctuation or keyword)
  let subject = text;
  const subjectMatch = text.match(/^([^,.:\-]+)/);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
  }
  
  // Limit subject length
  if (subject.length > 100) {
    subject = subject.substring(0, 97) + "...";
  }
  
  return {
    sequence,
    subject,
    description: text,
    activityType,
    dayOffset,
    assigneeType,
    rollOver: true,
    allDay: activityType === "Task"
  };
}

/**
 * Build complete workflow from natural language description
 * @param {string} description - Natural language workflow description
 * @param {string} passKey - BSA authentication key
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object>} Created workflow with steps
 */
async function buildWorkflowFromDescription(description, passKey, orgId) {
  // Parse the natural language description
  const parsed = parseWorkflowDescription(description);
  
  console.log(`[BSA:WORKFLOWS] Building workflow "${parsed.workflowName}" with ${parsed.steps.length} steps`);
  
  try {
    // Create the workflow container
    const workflow = await createWorkflow(
      parsed.workflowName,
      parsed.workflowDescription,
      passKey,
      orgId
    );
    
    // Add each step sequentially
    const addedSteps = [];
    for (const step of parsed.steps) {
      try {
        const result = await addWorkflowStep(workflow.id, step, passKey, orgId);
        addedSteps.push({
          sequence: step.sequence,
          subject: step.subject,
          success: true,
          id: result.id
        });
      } catch (stepError) {
        console.error(`[BSA:WORKFLOWS] Failed to add step ${step.sequence}:`, stepError.message);
        addedSteps.push({
          sequence: step.sequence,
          subject: step.subject,
          success: false,
          error: stepError.message
        });
      }
    }
    
    const successCount = addedSteps.filter(s => s.success).length;
    
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowDescription: workflow.description,
      stepsAdded: successCount,
      totalSteps: parsed.steps.length,
      steps: addedSteps,
      success: successCount === parsed.steps.length
    };
  } catch (error) {
    console.error('[BSA:WORKFLOWS] Error building workflow:', error.message);
    throw error;
  }
}

module.exports = {
  createWorkflow,
  addWorkflowStep,
  listWorkflows,
  getWorkflowSteps,
  deleteWorkflow,
  updateWorkflow,
  parseWorkflowDescription,
  buildWorkflowFromDescription
};