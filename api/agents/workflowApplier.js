/**
 * Workflow Applier Agent
 * 
 * Applies approved workflow specifications to BSA by creating:
 * 1. advocate_process (workflow shell)
 * 2. advocate_process_template (individual steps)
 */

const { baseApplier, findPreviewForAction, responsePatterns, withRetry, validateApplierConfig } = require('./baseApplier');
const axios = require('axios');

/**
 * Create advocate_process shell in BSA
 */
async function createProcessShell(name, description, bsaConfig) {
  const url = `${bsaConfig.BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;
  
  const payload = {
    PassKey: bsaConfig.passKey,
    OrganizationId: bsaConfig.orgId,
    ObjectName: "advocate_process",
    DataObject: {
      Name: name,
      Description: description || ""
    },
    IncludeExtendedProperties: false
  };
  
  console.log(`[WORKFLOW:APPLY] Creating advocate_process shell: ${name}`);
  
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000
  });
  
  // BSA responses are wrapped in arrays
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  
  if (!data.Valid) {
    throw new Error(data.ResponseMessage || data.StackMessage || "Failed to create process shell");
  }
  
  const processId = data.DataObject?.Id;
  if (!processId) {
    throw new Error("Process created but no ID returned");
  }
  
  console.log(`[WORKFLOW:APPLY] Process shell created with ID: ${processId}`);
  return {
    processId,
    name: data.DataObject.Name,
    description: data.DataObject.Description,
    createdOn: data.DataObject.CreatedOn
  };
}

/**
 * Add a step to the advocate_process
 */
async function addProcessStep(processId, stepData, bsaConfig) {
  const url = `${bsaConfig.BSA_BASE}/endpoints/ajax/com.platform.vc.endpoints.orgdata.VCOrgDataEndpoint/create.json`;
  
  // Convert times to ISO format if provided
  const formatTime = (timeStr) => {
    if (!timeStr) return null;
    try {
      return new Date(timeStr).toISOString();
    } catch (e) {
      console.warn(`[WORKFLOW:APPLY] Invalid time format: ${timeStr}`);
      return null;
    }
  };
  
  const payload = {
    PassKey: bsaConfig.passKey,
    OrganizationId: bsaConfig.orgId,
    ObjectName: "advocate_process_template",
    DataObject: {
      AdvocateProcessId: processId,
      Subject: stepData.subject,
      Description: stepData.description || "",
      ActivityType: stepData.activityType || "Task",
      AppointmentTypeId: stepData.appointmentTypeId || null,
      Sequence: stepData.sequence,
      DayOffset: stepData.dayOffset || 1,
      StartTime: formatTime(stepData.startTime),
      EndTime: formatTime(stepData.endTime),
      AllDay: stepData.allDay !== false, // Default true
      AssigneeType: stepData.assigneeType || "ContactsOwner",
      AssigneeId: stepData.assigneeId || null,
      RollOver: stepData.rollOver !== false, // Default true
      Location: stepData.location || null
    },
    IncludeExtendedProperties: false
  };
  
  console.log(`[WORKFLOW:APPLY] Adding step ${stepData.sequence}: ${stepData.subject}`);
  
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 10000
  });
  
  // BSA responses are wrapped in arrays
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  
  if (!data.Valid) {
    throw new Error(`Step ${stepData.sequence} failed: ${data.ResponseMessage || data.StackMessage || "Unknown error"}`);
  }
  
  const stepId = data.DataObject?.Id;
  console.log(`[WORKFLOW:APPLY] Step ${stepData.sequence} created with ID: ${stepId}`);
  
  return {
    stepId,
    sequence: data.DataObject.Sequence,
    subject: data.DataObject.Subject
  };
}

/**
 * Apply the complete workflow to BSA
 */
async function applyWorkflowToBSA(spec, bsaConfig, config) {
  const results = {
    processId: null,
    processName: null,
    steps: [],
    errors: []
  };
  
  try {
    // Phase 1: Create the process shell
    console.log(`[WORKFLOW:APPLY] Starting workflow creation: ${spec.name}`);
    const processResult = await withRetry(
      () => createProcessShell(spec.name, spec.description, bsaConfig),
      2, // max retries
      1000 // delay between retries
    );
    
    results.processId = processResult.processId;
    results.processName = processResult.name;
    
    // Phase 2: Add all steps sequentially
    console.log(`[WORKFLOW:APPLY] Adding ${spec.steps.length} steps to process ${results.processId}`);
    
    // Sort steps by sequence to ensure proper order
    const sortedSteps = [...spec.steps].sort((a, b) => a.sequence - b.sequence);
    
    for (const step of sortedSteps) {
      try {
        const stepResult = await withRetry(
          () => addProcessStep(results.processId, step, bsaConfig),
          1, // fewer retries for steps
          1000
        );
        
        results.steps.push({
          ...stepResult,
          success: true
        });
        
      } catch (stepError) {
        console.error(`[WORKFLOW:APPLY] Failed to add step ${step.sequence}:`, stepError.message);
        results.errors.push({
          step: step.sequence,
          subject: step.subject,
          error: stepError.message
        });
        
        // Continue with other steps even if one fails
        results.steps.push({
          sequence: step.sequence,
          subject: step.subject,
          success: false,
          error: stepError.message
        });
      }
    }
    
    // Summary
    const successCount = results.steps.filter(s => s.success).length;
    const totalSteps = spec.steps.length;
    
    console.log(`[WORKFLOW:APPLY] Workflow creation complete: ${successCount}/${totalSteps} steps succeeded`);
    
    if (results.errors.length > 0) {
      console.warn(`[WORKFLOW:APPLY] ${results.errors.length} steps failed`);
    }
    
    return results;
    
  } catch (error) {
    console.error(`[WORKFLOW:APPLY] Critical error during workflow creation:`, error.message);
    results.errors.push({
      step: 0,
      subject: "Process Creation",
      error: error.message
    });
    throw error;
  }
}

/**
 * Extract result data for artifacts
 */
function extractWorkflowResult(result) {
  return {
    processId: result.processId,
    processName: result.processName,
    stepCount: result.steps.length,
    successfulSteps: result.steps.filter(s => s.success).length,
    stepIds: result.steps.filter(s => s.stepId).map(s => s.stepId),
    errors: result.errors,
    summary: {
      totalSteps: result.steps.length,
      successful: result.steps.filter(s => s.success).length,
      failed: result.errors.length
    }
  };
}

/**
 * Main workflow applier function
 * Applies advocate_process workflows to BSA
 */
async function apply_build_workflow(state, config) {
  const applierConfig = {
    actionType: "build_workflow",
    applyFunction: applyWorkflowToBSA,
    extractResult: extractWorkflowResult
  };
  
  // Validate configuration
  validateApplierConfig(applierConfig);
  
  console.log("[WORKFLOW:APPLIER] Applying workflow to BSA...");
  
  try {
    // Use base applier to handle common patterns
    const result = await baseApplier(state, config, applierConfig);
    
    // Add workflow-specific logging
    if (result.artifacts?.build_workflow) {
      const workflow = result.artifacts.build_workflow;
      console.log(`[WORKFLOW:APPLIER] Workflow "${workflow.processName}" created`);
      console.log(`[WORKFLOW:APPLIER] Process ID: ${workflow.processId}`);
      console.log(`[WORKFLOW:APPLIER] Steps: ${workflow.successfulSteps}/${workflow.stepCount} successful`);
      
      if (workflow.errors && workflow.errors.length > 0) {
        console.warn("[WORKFLOW:APPLIER] Some steps failed:", workflow.errors);
      }
    }
    
    return result;
    
  } catch (error) {
    console.error("[WORKFLOW:APPLIER:ERROR]", error);
    throw error;
  }
}

/**
 * Standalone function to apply workflow (for testing)
 */
async function applyWorkflow(spec, passKey, orgId, options = {}) {
  const state = {
    action: { id: `workflow_${Date.now()}` },
    previews: [{
      actionId: `workflow_${Date.now()}`,
      kind: "workflow",
      spec
    }]
  };
  
  const config = {
    configurable: {
      passKey,
      orgId,
      BSA_BASE: options.BSA_BASE || process.env.BSA_BASE || "https://rc.bluesquareapps.com"
    }
  };
  
  const result = await apply_build_workflow(state, config);
  return result.artifacts?.build_workflow;
}

module.exports = {
  apply_build_workflow,
  applyWorkflow,
  createProcessShell,
  addProcessStep,
  applyWorkflowToBSA,
  extractWorkflowResult
};