/**
 * Custom error types for People Service
 * Maps to coordinator interrupt state for backward compatibility
 */

/**
 * Error thrown when multiple people match a query (disambiguation needed)
 */
class NeedsClarification extends Error {
  constructor(candidates, originalQuery, type = 'person', context = {}) {
    super('Multiple matches found');
    this.name = 'NeedsClarification';
    this.type = type; // 'user' | 'contact' | 'person'
    this.candidates = candidates;
    this.originalQuery = originalQuery;
    this.context = context;
  }

  /**
   * Convert to coordinator interrupt state
   * Maps to exact current shape: { needsClarification, clarificationType, clarificationData }
   */
  toInterruptState() {
    // Determine clarification type based on person type
    const clarificationType = this.type === 'user'
      ? 'user_disambiguation'
      : 'contact_disambiguation';

    return {
      needsClarification: true,
      clarificationType,
      clarificationData: {
        candidates: this.candidates,
        original_query: this.originalQuery,
        context: this.context
      }
    };
  }
}

/**
 * Error thrown when no person matches a query
 */
class PersonNotFound extends Error {
  constructor(query, type = 'person', suggestions = []) {
    super(`${type} not found: ${query}`);
    this.name = 'PersonNotFound';
    this.type = type; // 'user' | 'contact' | 'person'
    this.query = query;
    this.suggestions = suggestions;
  }

  /**
   * Convert to coordinator interrupt state
   */
  toInterruptState() {
    const clarificationType = this.type === 'user'
      ? 'user_not_found'
      : 'contact_not_found';

    return {
      needsClarification: true,
      clarificationType,
      clarificationData: {
        original_query: this.query,
        suggestions: this.suggestions,
        message: this.type === 'user'
          ? `I couldn't find a user named "${this.query}" in your organization.`
          : `I couldn't find a contact named "${this.query}".`
      }
    };
  }
}

module.exports = {
  NeedsClarification,
  PersonNotFound
};
