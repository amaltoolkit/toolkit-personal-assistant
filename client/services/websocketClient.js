/**
 * WebSocket Client for Interrupt Handling
 * 
 * Manages real-time communication with backend for approval flows.
 * Falls back to polling in production where WebSocket isn't available.
 */

class InterruptClient {
  constructor(sessionId, apiBase) {
    this.sessionId = sessionId;
    this.apiBase = apiBase;
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.listeners = new Map();
    this.pollingInterval = null;
    this.useWebSocket = false;
    
    // Determine if we should use WebSocket or polling
    this.detectConnectionMode();
  }

  /**
   * Detect whether to use WebSocket or polling
   */
  detectConnectionMode() {
    // Use WebSocket for local development, polling for production
    const isLocal = this.apiBase.includes('localhost') || this.apiBase.includes('127.0.0.1');
    this.useWebSocket = isLocal && typeof WebSocket !== 'undefined';
    
    console.log(`[InterruptClient] Using ${this.useWebSocket ? 'WebSocket' : 'Polling'} mode`);
  }

  /**
   * Connect to the interrupt service
   */
  connect() {
    if (this.useWebSocket) {
      this.connectWebSocket();
    } else {
      this.startPolling();
    }
  }

  /**
   * Connect via WebSocket
   */
  connectWebSocket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('[InterruptClient] Already connected');
      return;
    }

    const wsUrl = this.apiBase.replace('http', 'ws') + `/ws?session_id=${this.sessionId}`;
    console.log(`[InterruptClient] Connecting to WebSocket: ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[InterruptClient] WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('connected');
        
        // Send ping every 25 seconds to keep connection alive
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('[InterruptClient] Error parsing message:', error);
        }
      };

      this.ws.onclose = (event) => {
        console.log('[InterruptClient] WebSocket disconnected:', event.code, event.reason);
        this.isConnected = false;
        this.stopHeartbeat();
        this.emit('disconnected');
        
        // Attempt to reconnect
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (error) => {
        console.error('[InterruptClient] WebSocket error:', error);
        this.emit('error', error);
      };

    } catch (error) {
      console.error('[InterruptClient] Failed to create WebSocket:', error);
      // Fall back to polling
      this.useWebSocket = false;
      this.startPolling();
    }
  }

  /**
   * Start polling for interrupts
   */
  startPolling() {
    if (this.pollingInterval) {
      return;
    }

    console.log('[InterruptClient] Starting polling mode');
    this.isConnected = true;
    this.emit('connected');

    // Poll every 2 seconds
    this.pollingInterval = setInterval(async () => {
      try {
        const response = await fetch(`${this.apiBase}/api/interrupts/poll?session_id=${this.sessionId}`);
        const data = await response.json();
        
        if (data.hasInterrupt) {
          this.handleMessage(data.interrupt);
          
          // Acknowledge receipt
          await fetch(`${this.apiBase}/api/interrupts/acknowledge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId })
          });
        }
      } catch (error) {
        console.error('[InterruptClient] Polling error:', error);
      }
    }, 2000);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.isConnected = false;
      this.emit('disconnected');
    }
  }

  /**
   * Handle incoming message
   */
  handleMessage(message) {
    console.log('[InterruptClient] Received message:', message.type);
    
    switch (message.type) {
      case 'connected':
        console.log('[InterruptClient] Server confirmed connection');
        break;
        
      case 'interrupt':
        console.log('[InterruptClient] Received interrupt');
        this.emit('interrupt', message.data);
        break;
        
      case 'approval_confirmed':
        console.log('[InterruptClient] Approval confirmed by server');
        this.emit('approval_confirmed');
        break;
        
      case 'pong':
        // Heartbeat response
        break;
        
      default:
        console.log('[InterruptClient] Unknown message type:', message.type);
    }
  }

  /**
   * Send approval response
   */
  async sendApproval(approvalData) {
    console.log('[InterruptClient] Sending approval:', approvalData);
    
    if (this.useWebSocket && this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send via WebSocket
      this.ws.send(JSON.stringify({
        type: 'approval_response',
        data: approvalData
      }));
    } else {
      // Send via HTTP
      try {
        const response = await fetch(`${this.apiBase}/api/interrupts/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: this.sessionId,
            approval_data: approvalData
          })
        });
        
        const result = await response.json();
        if (result.success) {
          this.emit('approval_confirmed');
        } else {
          this.emit('error', new Error(result.message));
        }
      } catch (error) {
        console.error('[InterruptClient] Error sending approval:', error);
        this.emit('error', error);
      }
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`[InterruptClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  /**
   * Add event listener
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      const callbacks = this.listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  /**
   * Emit event
   */
  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`[InterruptClient] Error in ${event} listener:`, error);
        }
      });
    }
  }

  /**
   * Disconnect from service
   */
  disconnect() {
    console.log('[InterruptClient] Disconnecting');
    
    if (this.useWebSocket) {
      this.stopHeartbeat();
      if (this.ws) {
        this.ws.close(1000, 'Client disconnect');
        this.ws = null;
      }
    } else {
      this.stopPolling();
    }
    
    this.isConnected = false;
    this.emit('disconnected');
  }

  /**
   * Check connection status
   */
  isConnected() {
    return this.isConnected;
  }
}

// Export for use in extension
if (typeof module !== 'undefined' && module.exports) {
  module.exports = InterruptClient;
}