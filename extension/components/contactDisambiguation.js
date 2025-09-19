/**
 * Contact Disambiguation UI Component
 * 
 * Displays multiple contact matches for user selection when
 * the system cannot automatically determine the correct contact.
 */

class ContactDisambiguationUI {
  constructor() {
    this.container = null;
    this.currentInterrupt = null;
    this.selectedContact = null;
    this.onSelect = null;
    this.onCancel = null;
    this.onCreateNew = null;
  }

  /**
   * Initialize the contact disambiguation UI
   */
  init() {
    // Create container if it doesn't exist
    if (!document.getElementById('contact-disambiguation-modal')) {
      this.createContainer();
    }
    this.container = document.getElementById('contact-disambiguation-modal');
  }

  /**
   * Create the modal container
   */
  createContainer() {
    const modal = document.createElement('div');
    modal.id = 'contact-disambiguation-modal';
    modal.className = 'contact-modal hidden';
    modal.innerHTML = `
      <div class="contact-overlay"></div>
      <div class="contact-content">
        <div class="contact-header">
          <h3 class="contact-title">Select Contact</h3>
          <button class="contact-close" aria-label="Close">×</button>
        </div>
        <div class="contact-body">
          <p class="contact-message"></p>
          <div class="contact-search">
            <input type="text" class="contact-search-input" placeholder="Filter contacts...">
          </div>
          <div class="contact-cards-container">
            <div class="contact-cards"></div>
          </div>
        </div>
        <div class="contact-footer">
          <button class="contact-btn contact-cancel">
            <span class="btn-icon">✖</span>
            <span class="btn-text">Cancel</span>
          </button>
          <button class="contact-btn contact-create-new">
            <span class="btn-icon">➕</span>
            <span class="btn-text">Create New Contact</span>
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
    document.querySelector('.contact-close').addEventListener('click', () => {
      this.cancel('User closed modal');
    });
    
    // Cancel button
    document.querySelector('.contact-cancel').addEventListener('click', () => {
      this.cancel('User cancelled selection');
    });
    
    // Create new button
    document.querySelector('.contact-create-new').addEventListener('click', () => {
      this.createNew();
    });
    
    // Search input
    const searchInput = document.querySelector('.contact-search-input');
    searchInput.addEventListener('input', (e) => {
      this.filterContacts(e.target.value);
    });
    
    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (!this.isVisible()) return;
      
      switch(e.key) {
        case 'Escape':
          this.cancel('Escape key pressed');
          break;
        case 'ArrowDown':
          e.preventDefault();
          this.navigateContacts(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.navigateContacts(-1);
          break;
        case 'Enter':
          e.preventDefault();
          this.selectFocusedContact();
          break;
      }
    });
  }

  /**
   * Show contact disambiguation
   */
  show(interrupt) {
    if (!this.container) {
      this.init();
    }
    
    this.currentInterrupt = interrupt;
    this.selectedContact = null;
    
    // Parse and display the interrupt data
    this.renderContacts(interrupt);
    
    // Show the modal
    this.container.classList.remove('hidden');
    
    // Clear search and focus on first contact
    document.querySelector('.contact-search-input').value = '';
    setTimeout(() => {
      const firstCard = document.querySelector('.contact-card');
      if (firstCard) {
        firstCard.focus();
      } else {
        document.querySelector('.contact-search-input').focus();
      }
    }, 100);
  }

  /**
   * Render contacts
   */
  renderContacts(interrupt) {
    const messageEl = document.querySelector('.contact-message');
    const cardsContainer = document.querySelector('.contact-cards');
    
    if (!interrupt || !interrupt.value) {
      messageEl.textContent = 'No contacts to display';
      cardsContainer.innerHTML = '';
      return;
    }
    
    const { candidates, message, query } = interrupt.value;
    
    // Set message
    messageEl.textContent = message || `Multiple contacts found for "${query}". Please select:`;
    
    // Clear existing cards
    cardsContainer.innerHTML = '';
    
    // Render contact cards
    if (candidates && candidates.length > 0) {
      candidates.forEach((contact, index) => {
        const card = this.createContactCard(contact, index);
        cardsContainer.appendChild(card);
      });
    } else {
      cardsContainer.innerHTML = '<p class="no-contacts">No contacts found</p>';
    }
  }

  /**
   * Create a contact card element
   */
  createContactCard(contact, index) {
    const card = document.createElement('div');
    card.className = 'contact-card';
    card.tabIndex = 0;
    card.dataset.contactId = contact.id;
    card.dataset.index = index;
    
    // Create avatar with initials
    const initials = this.getInitials(contact.name);
    const avatarColor = this.getAvatarColor(contact.name);
    
    card.innerHTML = `
      <div class="contact-avatar" style="background: ${avatarColor}">
        ${contact.avatar ? 
          `<img src="${contact.avatar}" alt="${contact.name}">` : 
          `<span class="contact-initials">${initials}</span>`
        }
      </div>
      <div class="contact-info">
        <div class="contact-name">${this.escapeHtml(contact.name)}</div>
        ${contact.role ? `<div class="contact-role">${this.escapeHtml(contact.role)}</div>` : ''}
        ${contact.company ? `<div class="contact-company">${this.escapeHtml(contact.company)}</div>` : ''}
        ${contact.email ? `<div class="contact-email">${this.escapeHtml(contact.email)}</div>` : ''}
        ${contact.phone ? `<div class="contact-phone">${this.escapeHtml(contact.phone)}</div>` : ''}
      </div>
      ${contact.score !== undefined ? `
        <div class="contact-score">
          <span class="score-badge">${Math.round(contact.score)}%</span>
          <span class="score-label">Match</span>
        </div>
      ` : ''}
      ${contact.recent_interaction ? `
        <div class="contact-recent">
          <span class="recent-icon">🕐</span>
          <span class="recent-text">${this.escapeHtml(contact.recent_interaction)}</span>
        </div>
      ` : ''}
    `;
    
    // Add click handler
    card.addEventListener('click', () => {
      this.selectContact(contact);
    });
    
    // Add focus handler
    card.addEventListener('focus', () => {
      this.focusContact(card);
    });
    
    // Add hover effect
    card.addEventListener('mouseenter', () => {
      this.focusContact(card);
    });
    
    return card;
  }

  /**
   * Get initials from name
   */
  getInitials(name) {
    if (!name) return '?';
    
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  }

  /**
   * Get avatar color based on name
   */
  getAvatarColor(name) {
    if (!name) return 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    
    // Generate color based on name hash
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    const colors = [
      'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
      'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
      'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
      'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
      'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
      'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)',
      'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)'
    ];
    
    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * Filter contacts based on search
   */
  filterContacts(searchTerm) {
    const cards = document.querySelectorAll('.contact-card');
    const term = searchTerm.toLowerCase();
    
    let visibleCount = 0;
    let firstVisible = null;
    
    cards.forEach(card => {
      const name = card.querySelector('.contact-name')?.textContent.toLowerCase() || '';
      const company = card.querySelector('.contact-company')?.textContent.toLowerCase() || '';
      const email = card.querySelector('.contact-email')?.textContent.toLowerCase() || '';
      const role = card.querySelector('.contact-role')?.textContent.toLowerCase() || '';
      
      const matches = name.includes(term) || 
                     company.includes(term) || 
                     email.includes(term) ||
                     role.includes(term);
      
      if (matches) {
        card.style.display = '';
        visibleCount++;
        if (!firstVisible) firstVisible = card;
      } else {
        card.style.display = 'none';
      }
    });
    
    // Focus first visible card
    if (firstVisible && visibleCount === 1) {
      firstVisible.focus();
    }
  }

  /**
   * Navigate contacts with keyboard
   */
  navigateContacts(direction) {
    const cards = Array.from(document.querySelectorAll('.contact-card:not([style*="display: none"])'));
    if (cards.length === 0) return;
    
    const focused = document.querySelector('.contact-card.focused');
    let currentIndex = focused ? cards.indexOf(focused) : -1;
    
    // Calculate new index
    let newIndex = currentIndex + direction;
    if (newIndex < 0) newIndex = cards.length - 1;
    if (newIndex >= cards.length) newIndex = 0;
    
    // Focus new card
    cards[newIndex].focus();
  }

  /**
   * Focus a contact card
   */
  focusContact(card) {
    // Remove focus from all cards
    document.querySelectorAll('.contact-card').forEach(c => {
      c.classList.remove('focused');
    });
    
    // Add focus to this card
    card.classList.add('focused');
  }

  /**
   * Select the focused contact
   */
  selectFocusedContact() {
    const focused = document.querySelector('.contact-card.focused');
    if (focused) {
      focused.click();
    }
  }

  /**
   * Select a contact
   */
  selectContact(contact) {
    console.log('[ContactDisambiguation] Selected contact:', contact);
    
    this.selectedContact = contact;
    
    // Add selected state to card
    document.querySelectorAll('.contact-card').forEach(card => {
      card.classList.remove('selected');
    });
    
    const selectedCard = document.querySelector(`[data-contact-id="${contact.id}"]`);
    if (selectedCard) {
      selectedCard.classList.add('selected');
    }
    
    // Call callback if provided
    if (this.onSelect) {
      this.onSelect(contact);
    }
    
    // Hide modal after brief delay to show selection
    setTimeout(() => {
      this.hide();
    }, 200);
  }

  /**
   * Cancel selection
   */
  cancel(reason = 'User cancelled') {
    console.log('[ContactDisambiguation] Cancelled:', reason);
    
    if (this.onCancel) {
      this.onCancel(reason);
    }
    
    this.hide();
  }

  /**
   * Create new contact
   */
  createNew() {
    console.log('[ContactDisambiguation] Create new contact requested');
    
    if (this.onCreateNew) {
      this.onCreateNew();
    }
    
    this.hide();
  }

  /**
   * Hide the modal
   */
  hide() {
    if (this.container) {
      this.container.classList.add('hidden');
    }
    
    this.currentInterrupt = null;
    this.selectedContact = null;
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
}

// Export for use in extension
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContactDisambiguationUI;
}