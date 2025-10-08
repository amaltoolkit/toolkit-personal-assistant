/**
 * WebSocket Server for Interrupt Handling
 * 
 * Manages real-time communication between backend graph interrupts
 * and frontend UI for approval flows.
 */

const WebSocket = require('ws');

class InterruptWebSocketServer {
  constructor() {
    this.wss = null;
    this.connections = new Map(); // sessionId -> WebSocket
    this.pendingInterrupts = new Map(); // sessionId -> interrupt data
    this.heartbeatInterval = null;
  }

  /**
   * Initialize WebSocket server attached to HTTP server
   * @param {http.Server} server - HTTP server instance
   */
  initialize(server) {
    console.log('[WS:INTERRUPTS] Initializing WebSocket server');
    
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws',
      clientTracking: true
    });

    this.wss.on('connection', this.handleConnection.bind(this));
    
    // Start heartbeat monitoring
    this.startHeartbeat();
    
    console.log('[WS:INTERRUPTS] WebSocket server initialized on /ws');
  }

  /**
   * Handle new WebSocket connection
   * @param {WebSocket} ws - WebSocket connection
   * @param {Request} request - HTTP request
   */
  handleConnection(ws, request) {
    console.log('[WS:INTERRUPTS] New connection attempt');
    
    // Extract session ID from query params
    const url = new URL(request.url, `http://${request.headers.host}`);
    const sessionId = url.searchParams.get('session_id');
    
    if (!sessionId) {
      console.warn('[WS:INTERRUPTS] Connection rejected: no session_id');
      ws.close(1008, 'Session ID required');
      return;
    }
    
    console.log(`[WS:INTERRUPTS] Connection established for session: ${sessionId}`);
    
    // Store connection
    if (this.connections.has(sessionId)) {
      // Close existing connection for this session
      const existing = this.connections.get(sessionId);
      existing.close(1000, 'Replaced by new connection');
    }
    
    this.connections.set(sessionId, ws);
    ws.sessionId = sessionId;
    ws.isAlive = true;
    
    // Set up event handlers
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    
    ws.on('message', (data) => this.handleMessage(ws, data));
    
    ws.on('close', () => {
      console.log(`[WS:INTERRUPTS] Connection closed for session: ${sessionId}`);
      this.connections.delete(sessionId);
    });
    
    ws.on('error', (error) => {
      console.error(`[WS:INTERRUPTS] Connection error for session ${sessionId}:`, error.message);
    });
    
    // Send welcome message
    this.sendMessage(ws, {
      type: 'connected',
      sessionId: sessionId,
      message: 'WebSocket connection established'
    });
    
    // Check for pending interrupts
    if (this.pendingInterrupts.has(sessionId)) {
      const interrupt = this.pendingInterrupts.get(sessionId);
      console.log(`[WS:INTERRUPTS] Sending pending interrupt to session: ${sessionId}`);
      this.sendMessage(ws, interrupt);
      this.pendingInterrupts.delete(sessionId);
    }
  }

  /**
   * Handle incoming WebSocket message
   * @param {WebSocket} ws - WebSocket connection
   * @param {Buffer} data - Message data
   */
  handleMessage(ws, data) {
    try {
      const message = JSON.parse(data.toString());
      console.log(`[WS:INTERRUPTS] Received message from ${ws.sessionId}:`, message.type);
      
      switch (message.type) {
        case 'ping':
          // Respond to client ping
          this.sendMessage(ws, { type: 'pong' });
          break;
          
        case 'approval_response':
          // Handle approval response from UI
          this.handleApprovalResponse(ws.sessionId, message.data);
          break;
          
        case 'get_pending':
          // Check for pending interrupts
          if (this.pendingInterrupts.has(ws.sessionId)) {
            const interrupt = this.pendingInterrupts.get(ws.sessionId);
            this.sendMessage(ws, interrupt);
            this.pendingInterrupts.delete(ws.sessionId);
          } else {
            this.sendMessage(ws, { type: 'no_pending' });
          }
          break;
          
        default:
          console.warn(`[WS:INTERRUPTS] Unknown message type: ${message.type}`);
      }
      
    } catch (error) {
      console.error('[WS:INTERRUPTS] Error handling message:', error);
      this.sendMessage(ws, {
        type: 'error',
        message: 'Failed to process message'
      });
    }
  }

  /**
   * Send interrupt to client
   * @param {string} sessionId - Session ID
   * @param {Object} interruptData - Interrupt payload
   * @returns {Promise<boolean>} Success status
   */
  async sendInterrupt(sessionId, interruptData) {
    console.log(`[WS:INTERRUPTS] Sending interrupt to session: ${sessionId}`);
    
    const ws = this.connections.get(sessionId);
    
    const message = {
      type: 'interrupt',
      timestamp: Date.now(),
      data: interruptData
    };
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send immediately if connected
      this.sendMessage(ws, message);
      return true;
    } else {
      // Store for later delivery
      console.log(`[WS:INTERRUPTS] Session ${sessionId} not connected, storing interrupt`);
      this.pendingInterrupts.set(sessionId, message);
      return false;
    }
  }

  /**
   * Handle approval response from UI
   * @param {string} sessionId - Session ID
   * @param {Object} approvalData - Approval decision
   */
  handleApprovalResponse(sessionId, approvalData) {
    console.log(`[WS:INTERRUPTS] Approval response from ${sessionId}:`, approvalData);
    
    // Emit event that can be listened to by the route handler
    if (this.onApprovalResponse) {
      this.onApprovalResponse(sessionId, approvalData);
    }
    
    // Send confirmation to client
    const ws = this.connections.get(sessionId);
    if (ws) {
      this.sendMessage(ws, {
        type: 'approval_confirmed',
        message: 'Approval received and processing'
      });
    }
  }

  /**
   * Send message to WebSocket client
   * @param {WebSocket} ws - WebSocket connection
   * @param {Object} data - Message data
   */
  sendMessage(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Broadcast message to all connected clients
   * @param {Object} data - Message data
   */
  broadcast(data) {
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  }

  /**
   * Start heartbeat interval to detect disconnected clients
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log(`[WS:INTERRUPTS] Terminating inactive connection: ${ws.sessionId}`);
          if (ws.sessionId) {
            this.connections.delete(ws.sessionId);
          }
          return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // 30 seconds
  }

  /**
   * Stop heartbeat monitoring
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Get connection status for a session
   * @param {string} sessionId - Session ID
   * @returns {boolean} Connection status
   */
  isConnected(sessionId) {
    const ws = this.connections.get(sessionId);
    return ws && ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get all connected session IDs
   * @returns {Array<string>} Connected session IDs
   */
  getConnectedSessions() {
    return Array.from(this.connections.keys());
  }

  /**
   * Close WebSocket server
   */
  close() {
    console.log('[WS:INTERRUPTS] Closing WebSocket server');
    
    this.stopHeartbeat();
    
    // Close all connections
    this.connections.forEach((ws, sessionId) => {
      ws.close(1000, 'Server shutting down');
    });
    
    this.connections.clear();
    this.pendingInterrupts.clear();
    
    if (this.wss) {
      this.wss.close();
    }
  }
}

// Create singleton instance
let instance = null;

module.exports = {
  getInterruptWebSocketServer: () => {
    if (!instance) {
      instance = new InterruptWebSocketServer();
    }
    return instance;
  },
  InterruptWebSocketServer
};