/**
 * Approval UI Component
 * 
 * Displays approval requests for appointments, tasks, and workflows
 * with Accept/Reject/Modify options.
 */

class ApprovalUI {
  constructor() {
    this.container = null;
    this.currentInterrupt = null;
    this.timeoutTimer = null;
    this.onApprove = null;
    this.onReject = null;
    this.onModify = null;
  }

  /**
   * Initialize the approval UI
   */
  init() {
    // Create container if it doesn't exist
    if (!document.getElementById('approval-modal')) {
      this.createContainer();
    }
    this.container = document.getElementById('approval-modal');
  }

  /**
   * Create the modal container
   */
  createContainer() {
    const modal = document.createElement('div');
    modal.id = 'approval-modal';
    modal.className = 'approval-modal hidden';
    modal.innerHTML = `
      <div class="approval-overlay"></div>
      <div class="approval-content">
        <div class="approval-header">
          <h3 class="approval-title">Approval Required</h3>
          <button class="approval-close" aria-label="Close">×</button>
        </div>
        <div class="approval-body">
          <div class="approval-preview"></div>
          <div class="approval-timeout-warning hidden">
            <span class="warning-icon">⚠️</span>
            <span class="warning-text">Auto-rejecting in <span class="timeout-seconds">5</span> seconds...</span>
          </div>
        </div>
        <div class="approval-footer">
          <button class="approval-btn approval-reject">
            <span class="btn-icon">❌</span>
            <span class="btn-text">Reject</span>
          </button>
          <button class="approval-btn approval-modify hidden">
            <span class="btn-icon">✏️</span>
            <span class="btn-text">Modify</span>
          </button>
          <button class="approval-btn approval-accept">
            <span class="btn-icon">✅</span>
            <span class="btn-text">Accept</span>
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Add event listeners
    this.attachEventListeners();
  }

  /**
   * Attach event listeners to modal elements
   */
  attachEventListeners() {
    // Close button
    document.querySelector('.approval-close').addEventListener('click', () => {
      this.reject('User closed modal');
    });
    
    // Action buttons
    document.querySelector('.approval-accept').addEventListener('click', () => {
      this.accept();
    });
    
    document.querySelector('.approval-reject').addEventListener('click', () => {
      this.reject('User rejected');
    });
    
    document.querySelector('.approval-modify').addEventListener('click', () => {
      this.modify();
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (!this.isVisible()) return;
      
      switch(e.key.toLowerCase()) {
        case 'a':
          if (!e.ctrlKey && !e.metaKey) this.accept();
          break;
        case 'r':
          if (!e.ctrlKey && !e.metaKey) this.reject('Keyboard shortcut');
          break;
        case 'm':
          if (!e.ctrlKey && !e.metaKey) this.modify();
          break;
        case 'escape':
          this.reject('Escape key pressed');
          break;
      }
    });
  }

  /**
   * Show approval request
   */
  show(interrupt) {
    if (!this.container) {
      this.init();
    }
    
    this.currentInterrupt = interrupt;
    
    // Parse and display the interrupt data
    this.renderPreview(interrupt);
    
    // Show the modal
    this.container.classList.remove('hidden');
    
    // Start timeout timer (30 seconds)
    this.startTimeout(30);
    
    // Focus on accept button
    document.querySelector('.approval-accept').focus();
  }

  /**
   * Render the preview content
   */
  renderPreview(interrupt) {
    const previewEl = document.querySelector('.approval-preview');
    
    if (!interrupt || !interrupt.value) {
      previewEl.innerHTML = '<p>No preview available</p>';
      return;
    }
    
    const { previews, message } = interrupt.value;
    
    let html = '';
    
    // Add message if present
    if (message) {
      html += `<p class="approval-message">${this.escapeHtml(message)}</p>`;
    }
    
    // Render previews
    if (previews && previews.length > 0) {
      previews.forEach(preview => {
        html += this.renderPreviewCard(preview);
      });
    }
    
    previewEl.innerHTML = html;
  }

  /**
   * Render a single preview card
   */
  renderPreviewCard(preview) {
    const { type, action, subject, details } = preview;
    
    let icon = '📄';
    if (type === 'appointment') icon = '📅';
    else if (type === 'task') icon = '✅';
    else if (type === 'workflow') icon = '🔄';
    
    let html = `
      <div class="preview-card ${type}-card">
        <div class="preview-header">
          <span class="preview-icon">${icon}</span>
          <span class="preview-type">${this.capitalize(type)}</span>
          <span class="preview-action">${action}</span>
        </div>
        <div class="preview-subject">${this.escapeHtml(subject || 'Untitled')}</div>
    `;
    
    // Add details based on type
    if (type === 'appointment' && details) {
      html += `
        <div class="preview-details">
          <div class="detail-row">
            <span class="detail-label">When:</span>
            <span class="detail-value">${this.escapeHtml(details.startTime || 'Not set')}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Duration:</span>
            <span class="detail-value">${this.escapeHtml(details.duration || 'Not set')}</span>
          </div>
          ${details.location ? `
          <div class="detail-row">
            <span class="detail-label">Where:</span>
            <span class="detail-value">${this.escapeHtml(details.location)}</span>
          </div>` : ''}
          ${details.attendees && details.attendees.length > 0 ? `
          <div class="detail-row">
            <span class="detail-label">With:</span>
            <span class="detail-value">${this.escapeHtml(details.attendees.join(', '))}</span>
          </div>` : ''}
        </div>
      `;
    } else if (type === 'task' && details) {
      html += `
        <div class="preview-details">
          <div class="detail-row">
            <span class="detail-label">Priority:</span>
            <span class="detail-value priority-${(details.priority || 'medium').toLowerCase()}">${this.escapeHtml(details.priority || 'Medium')}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Due:</span>
            <span class="detail-value">${this.escapeHtml(details.dueDate || 'No due date')}</span>
          </div>
          ${details.assignee ? `
          <div class="detail-row">
            <span class="detail-label">Assigned to:</span>
            <span class="detail-value">${this.escapeHtml(details.assignee)}</span>
          </div>` : ''}
        </div>
      `;
    } else if (type === 'workflow' && details) {
      html += `
        <div class="preview-details">
          <div class="detail-row">
            <span class="detail-label">Steps:</span>
            <span class="detail-value">${details.stepCount || 0} steps</span>
          </div>
          ${details.startDate ? `
          <div class="detail-row">
            <span class="detail-label">Starts:</span>
            <span class="detail-value">${this.escapeHtml(details.startDate)}</span>
          </div>` : ''}
        </div>
      `;
      
      // Add collapsible step list if present
      if (details.steps && details.steps.length > 0) {
        html += `
          <details class="workflow-steps">
            <summary>View Steps</summary>
            <ol class="step-list">
              ${details.steps.map(step => `
                <li class="step-item">
                  <span class="step-name">${this.escapeHtml(step.name || step)}</span>
                  ${step.date ? `<span class="step-date">${this.escapeHtml(step.date)}</span>` : ''}
                </li>
              `).join('')}
            </ol>
          </details>
        `;
      }
    }
    
    html += '</div>';
    
    return html;
  }

  /**
   * Start timeout timer
   */
  startTimeout(seconds) {
    this.clearTimeout();
    
    let remaining = seconds;
    const warningEl = document.querySelector('.approval-timeout-warning');
    const secondsEl = document.querySelector('.timeout-seconds');
    
    this.timeoutTimer = setInterval(() => {
      remaining--;
      
      // Show warning at 5 seconds
      if (remaining <= 5) {
        warningEl.classList.remove('hidden');
        secondsEl.textContent = remaining;
      }
      
      // Auto-reject at 0
      if (remaining <= 0) {
        this.reject('Timeout - auto rejected');
      }
    }, 1000);
  }

  /**
   * Clear timeout timer
   */
  clearTimeout() {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    
    // Hide warning
    const warningEl = document.querySelector('.approval-timeout-warning');
    if (warningEl) {
      warningEl.classList.add('hidden');
    }
  }

  /**
   * Accept the approval
   */
  accept() {
    console.log('[ApprovalUI] Accepted');
    
    const decision = {
      approved: true,
      timestamp: Date.now()
    };
    
    if (this.onApprove) {
      this.onApprove(decision);
    }
    
    this.hide();
  }

  /**
   * Reject the approval
   */
  reject(reason = 'User rejected') {
    console.log('[ApprovalUI] Rejected:', reason);
    
    const decision = {
      approved: false,
      reason: reason,
      timestamp: Date.now()
    };
    
    if (this.onReject) {
      this.onReject(decision);
    }
    
    this.hide();
  }

  /**
   * Modify the approval (not implemented yet)
   */
  modify() {
    console.log('[ApprovalUI] Modify requested');
    
    // For now, just show an alert
    alert('Modify functionality coming soon! For now, please reject and create manually with your changes.');
    
    // In future, this would open an edit dialog
    if (this.onModify) {
      this.onModify();
    }
  }

  /**
   * Hide the modal
   */
  hide() {
    this.clearTimeout();
    
    if (this.container) {
      this.container.classList.add('hidden');
    }
    
    this.currentInterrupt = null;
  }

  /**
   * Check if modal is visible
   */
  isVisible() {
    return this.container && !this.container.classList.contains('hidden');
  }

  /**
   * Utility: Escape HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  /**
   * Utility: Capitalize first letter
   */
  capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
  }
}

// Export for use in extension
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ApprovalUI;
}