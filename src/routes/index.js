// Route aggregation
const express = require('express');
const authRoutes = require('./auth');
const agentRoutes = require('./agent');
const monitoringRoutes = require('./monitoring');

function setupRoutes(app) {
  // Authentication Routes
  console.log('[ROUTES] Mounting auth routes');
  app.use('/auth', authRoutes);
  
  // Multi-Agent Routes
  console.log('[ROUTES] Mounting agent routes');
  app.use('/api/agent', agentRoutes);
  
  // Monitoring Routes
  try {
    app.use('/api', monitoringRoutes);
    console.log('[ROUTES] Monitoring routes loaded');
  } catch (error) {
    console.error('[ROUTES] Error loading monitoring routes:', error.message);
  }
}

module.exports = { setupRoutes };

