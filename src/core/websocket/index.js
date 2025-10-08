// WebSocket and polling exports
const { getInterruptWebSocketServer } = require('./interrupts');
const { getInterruptPollingService } = require('./pollingFallback');

module.exports = {
  getInterruptWebSocketServer,
  getInterruptPollingService
};

