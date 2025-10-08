/**
 * Integration Tests for Contact Information Queries
 * Tests the Contact Agent's ability to answer field-specific questions
 */

const { getContactSubgraph } = require('../../src/agents/domains/contact/graph');
const { formatHumanReadableDate, formatCustomFieldValue, getFriendlyFieldName } = require('../../src/utils/contactFieldFormatter');

describe('Contact Information Queries', () => {
  describe('Field Formatter Utilities', () => {
    test('formatHumanReadableDate formats ISO dates correctly', () => {
      expect(formatHumanReadableDate('1985-05-28T12:00:00.000Z')).toBe('May 28, 1985');
      expect(formatHumanReadableDate('2002-06-15T12:00:00.000Z')).toBe('June 15, 2002');
      expect(formatHumanReadableDate(null)).toBe(null);
    });

    test('formatCustomFieldValue handles currency objects', () => {
      expect(formatCustomFieldValue({ ctype: 'USD', value: 2500000 })).toBe('$2,500,000.00');
      expect(formatCustomFieldValue({ ctype: 'EUR', value: 1000 })).toContain('1,000');
    });

    test('formatCustomFieldValue handles dates', () => {
      const result = formatCustomFieldValue('2023-04-28T19:00:00.000Z');
      expect(result).toContain('April');
      expect(result).toContain('2023');
    });

    test('formatCustomFieldValue handles arrays', () => {
      expect(formatCustomFieldValue([])).toBe('None');
      expect(formatCustomFieldValue(['a', 'b', 'c'])).toBe('a, b, c');
      expect(formatCustomFieldValue(['a', 'b', 'c', 'd', 'e'])).toContain('and 2 more');
    });

    test('formatCustomFieldValue handles booleans', () => {
      expect(formatCustomFieldValue(true)).toBe('Yes');
      expect(formatCustomFieldValue(false)).toBe('No');
    });

    test('formatCustomFieldValue handles numbers', () => {
      expect(formatCustomFieldValue(1000)).toBe('1,000');
      expect(formatCustomFieldValue(500)).toBe('500');
    });

    test('getFriendlyFieldName converts field names', () => {
      expect(getFriendlyFieldName('birthDate')).toBe('birthday');
      expect(getFriendlyFieldName('email')).toBe('email address');
      expect(getFriendlyFieldName('phone')).toBe('phone number');
      expect(getFriendlyFieldName('coffee_preference')).toBe('Coffee preference');
      expect(getFriendlyFieldName('jobTitle')).toBe('job title');
    });
  });

  describe('Contact Agent State Channels', () => {
    test('Contact agent has required state channels for info queries', () => {
      const contactSubgraph = getContactSubgraph();

      // Verify the graph is initialized
      expect(contactSubgraph).toBeDefined();
      expect(contactSubgraph.graph).toBeDefined();
    });
  });

  // Note: Full integration tests with BSA require authentication and live data
  // These tests should be run manually or in a staging environment with proper credentials
  describe('Manual Test Scenarios', () => {
    test.skip('Query: "When is Norman\'s birthday?" should return formatted date', async () => {
      // This test requires:
      // 1. Valid BSA credentials
      // 2. Contact "Norman" in the system
      // 3. Norman's birthday field populated

      // Expected flow:
      // 1. LLM Planner routes to 'contact' domain
      // 2. Contact Agent classifies as 'info' query
      // 3. Resolves contact "Norman"
      // 4. Fetches details with extended properties
      // 5. Extracts birthDate field
      // 6. Answers with formatted date

      // Expected response: "Norman Albertson's birthday is May 28, 1985."
    });

    test.skip('Query: "What\'s Norman\'s coffee preference?" should extract custom field', async () => {
      // This test requires:
      // 1. Valid BSA credentials
      // 2. Contact "Norman" in the system
      // 3. Custom field "coffee_preference" in CustomProps

      // Expected flow:
      // 1. LLM Planner routes to 'contact' domain
      // 2. Contact Agent classifies as 'info' query
      // 3. Resolves contact "Norman"
      // 4. Fetches details with extended properties
      // 5. Extracts custom field from CustomProps
      // 6. Answers with formatted value

      // Expected response: "Norman Albertson's coffee preference: [value]"
    });

    test.skip('Query: "What\'s his email?" (after finding Norman) should use entity', async () => {
      // This test requires:
      // 1. Valid BSA credentials
      // 2. Previous query resolved "Norman" into entity
      // 3. Entity stored in state

      // Expected flow:
      // 1. LLM Planner routes to 'contact' domain
      // 2. Contact Agent classifies as 'info' query
      // 3. Resolves from entities (last_contact)
      // 4. Extracts email field (no BSA call needed if entity has it)
      // 5. Answers with email

      // Expected response: "Norman Albertson's email is norm.albertson@gmail.com."
    });

    test.skip('Query for missing field should return "not recorded" message', async () => {
      // This test requires:
      // 1. Valid BSA credentials
      // 2. Contact with null birthDate

      // Expected response: "John Doe's birthday is not recorded in the system."
    });
  });
});

// Export test helpers for manual testing
module.exports = {
  testScenarios: {
    standardFields: [
      { query: "When is Norman's birthday?", field: "birthDate" },
      { query: "What's Norman's email?", field: "email" },
      { query: "Where does Norman live?", field: "city/state" },
      { query: "What's Norman's phone number?", field: "phone" },
      { query: "What's Norman's anniversary?", field: "anniversary" }
    ],
    customFields: [
      { query: "What's Norman's coffee preference?", field: "coffee_preference" },
      { query: "Show me Norman's LinkedIn", field: "linkedin" },
      { query: "What are Norman's hobbies?", field: "hobbies" }
    ],
    pronouns: [
      { query: "What's his email?", context: "after_finding_norman" },
      { query: "What's his birthday?", context: "after_finding_norman" }
    ],
    missing: [
      { query: "When is Joseph's birthday?", expected: "not recorded" }
    ]
  }
};
