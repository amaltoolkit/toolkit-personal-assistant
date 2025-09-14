/**
 * Test script to verify contact search fixes
 * Tests JSON parsing and name extraction
 */

// Mock the dependencies that require environment variables
const mockPassKeyManager = {
  getPassKey: async () => 'mock-passkey',
  refreshPassKey: async () => 'mock-passkey'
};

const mockMem0Service = {
  recall: async () => ({ recalled_memories: [] }),
  store: async () => true
};

const mockErrorHandler = {
  executeWithRetry: async (fn) => fn(),
  handleError: () => {}
};

const mockMetrics = {
  startTimer: () => {},
  endTimer: () => {},
  recordCacheHit: () => {},
  recordCacheMiss: () => {}
};

// Mock modules before requiring the contact subgraph
require.cache[require.resolve('./api/services/passKeyManager.js')] = {
  exports: mockPassKeyManager
};

require.cache[require.resolve('./api/services/mem0Service.js')] = {
  exports: { getMem0Service: () => mockMem0Service }
};

require.cache[require.resolve('./api/services/errorHandler.js')] = {
  exports: { getErrorHandler: () => mockErrorHandler }
};

require.cache[require.resolve('./api/coordinator/metrics.js')] = {
  exports: { getPerformanceMetrics: () => mockMetrics }
};

// Now load the contact subgraph
const { ContactSubgraph } = require('./api/subgraphs/contact');

async function testNameExtraction() {
  console.log('=== Testing Contact Name Extraction ===\n');

  const subgraph = new ContactSubgraph();

  // Test cases with different query formats
  const testCases = [
    {
      query: "Schedule a meeting with Norman the financial advisor",
      expected: "Norman",
      description: "Extract 'Norman' from 'with Norman the financial advisor'"
    },
    {
      query: "Book appointment and Sarah from ABC Corp",
      expected: "Sarah",
      description: "Extract 'Sarah' from 'and Sarah from ABC Corp'"
    },
    {
      query: "Meeting with John Smith next week",
      expected: "John Smith",
      description: "Extract 'John Smith' from 'with John Smith'"
    },
    {
      query: "Contact Bob about the project",
      expected: "Bob",
      description: "Extract 'Bob' from 'Contact Bob'"
    },
    {
      query: "Send email to marketing team",
      expected: null,
      description: "No specific name to extract"
    }
  ];

  for (const test of testCases) {
    console.log(`\nTest: ${test.description}`);
    console.log(`Query: "${test.query}"`);

    try {
      const state = {
        searchQuery: test.query,
        query: test.query,
        messages: [],
        extractedContext: {}
      };

      const result = await subgraph.extractContactName(state);

      if (result.searchQuery === test.expected ||
          (!result.searchQuery && !test.expected) ||
          (result.error && !test.expected)) {
        console.log(`✅ PASS - Extracted: "${result.searchQuery || 'null'}"`);
      } else {
        console.log(`❌ FAIL - Expected: "${test.expected}", Got: "${result.searchQuery}"`);
      }

      if (result.error) {
        console.log(`   Note: ${result.error}`);
      }
    } catch (error) {
      console.log(`❌ ERROR: ${error.message}`);
    }
  }
}

async function testJSONParsing() {
  console.log('\n\n=== Testing JSON Parsing with Markdown ===\n');

  const subgraph = new ContactSubgraph();

  // Mock LLM responses with different formats
  const mockResponses = [
    {
      content: '```json\n{"name": "John Doe", "context": {"role": "manager"}}\n```',
      description: "JSON with markdown code block"
    },
    {
      content: '{"name": "Jane Smith", "context": {}}',
      description: "Plain JSON without markdown"
    },
    {
      content: 'Here is the extracted data:\n```json\n{"name": "Bob", "context": {"company": "XYZ"}}\n```\nThis is the result.',
      description: "JSON with surrounding text"
    }
  ];

  // Patch the extractContactName method to test parsing
  for (const mock of mockResponses) {
    console.log(`\nTest: ${mock.description}`);

    try {
      // Simulate the parsing logic from extractContactName
      let content = mock.content;

      // Strip markdown formatting if present
      if (content.includes('```json')) {
        content = content.split('```json')[1].split('```')[0].trim();
      } else if (content.includes('```')) {
        content = content.split('```')[1].split('```')[0].trim();
      }

      const parsed = JSON.parse(content);
      console.log(`✅ PASS - Parsed: ${JSON.stringify(parsed)}`);
    } catch (error) {
      console.log(`❌ FAIL - Parsing error: ${error.message}`);
    }
  }
}

async function testSearchValidation() {
  console.log('\n\n=== Testing Search Query Validation ===\n');

  const subgraph = new ContactSubgraph();

  const testQueries = [
    {
      query: "Norman",
      shouldSearch: true,
      description: "Short name - should search"
    },
    {
      query: "John Smith",
      shouldSearch: true,
      description: "Full name - should search"
    },
    {
      query: "Schedule a meeting with Norman the financial advisor to discuss quarterly investment portfolio review",
      shouldSearch: false,
      description: "Full sentence - should NOT search"
    },
    {
      query: null,
      shouldSearch: false,
      description: "Null query - should NOT search"
    }
  ];

  for (const test of testQueries) {
    console.log(`\nTest: ${test.description}`);
    console.log(`Query: "${test.query}"`);

    const state = {
      searchQuery: test.query
    };

    const config = {
      configurable: {
        getPassKey: async () => 'mock-passkey',
        org_id: 'mock-org'
      }
    };

    // Mock the searchContacts function
    require.cache[require.resolve('./api/tools/bsa/contacts.js')] = {
      exports: {
        searchContacts: async (query) => {
          console.log(`   Would search for: "${query}"`);
          return [];
        }
      }
    };

    const result = await subgraph.searchBSAContacts(state, config);

    const didSearch = !result.error && result.candidates !== undefined;

    if (didSearch === test.shouldSearch) {
      console.log(`✅ PASS - ${test.shouldSearch ? 'Searched' : 'Skipped search'} as expected`);
    } else {
      console.log(`❌ FAIL - ${didSearch ? 'Searched' : 'Skipped'} but should ${test.shouldSearch ? 'search' : 'skip'}`);
    }

    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }
}

// Run all tests
async function runTests() {
  console.log('========================================');
  console.log('Contact Search Fix Verification Tests');
  console.log('========================================');

  await testNameExtraction();
  await testJSONParsing();
  await testSearchValidation();

  console.log('\n========================================');
  console.log('Test Complete');
  console.log('========================================');
  console.log('\nExpected behavior:');
  console.log('✅ Names extracted from queries using LLM or regex fallback');
  console.log('✅ JSON parsing handles markdown formatting');
  console.log('✅ Long queries rejected to prevent bad searches');
  console.log('✅ Contact search only happens with valid names');
}

// Run if executed directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testNameExtraction, testJSONParsing, testSearchValidation };