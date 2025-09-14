/**
 * Test file for BSA Configuration Module
 * Run with: node api/test/test-bsa-config.js
 */

// Test with different BSA_BASE values
const testConfigurations = [
  {
    name: 'RC Environment',
    url: 'https://rc.bluesquareapps.com',
    expectedEnv: 'rc'
  },
  {
    name: 'Production Environment',
    url: 'https://toolkit.bluesquareapps.com',
    expectedEnv: 'production'
  },
  {
    name: 'Custom Environment',
    url: 'https://custom.bluesquareapps.com',
    expectedEnv: 'custom'
  },
  {
    name: 'Localhost',
    url: 'http://localhost:3000',
    expectedEnv: 'custom'
  }
];

console.log('Testing BSA Configuration Module\n');
console.log('=================================\n');

testConfigurations.forEach(testCase => {
  // Set the environment variable
  process.env.BSA_BASE = testCase.url;

  // Clear the module cache to force re-initialization
  delete require.cache[require.resolve('../config/bsa')];

  // Import the module (will reinitialize with new BSA_BASE)
  const bsaConfig = require('../config/bsa');

  console.log(`Test: ${testCase.name}`);
  console.log(`  Input URL: ${testCase.url}`);
  console.log(`  Detected Environment: ${bsaConfig.getEnvironment()}`);
  console.log(`  Expected Environment: ${testCase.expectedEnv}`);
  console.log(`  Match: ${bsaConfig.getEnvironment() === testCase.expectedEnv ? '✅' : '❌'}`);

  // Test URL building methods
  console.log(`  OAuth URL: ${bsaConfig.buildOAuthUrl('authorize')}`);
  console.log(`  API Endpoint: ${bsaConfig.buildApiEndpoint('com.platform.vc.endpoints.data.VCDataEndpoint/login.json')}`);

  // Test environment checks
  console.log(`  Is RC: ${bsaConfig.isRC()}`);
  console.log(`  Is Production: ${bsaConfig.isProduction()}`);

  console.log('\n');
});

// Test with no BSA_BASE set (should use default)
console.log('Test: Default Configuration (no BSA_BASE)');
delete process.env.BSA_BASE;
delete require.cache[require.resolve('../config/bsa')];
const bsaConfigDefault = require('../config/bsa');
console.log(`  Default URL: ${bsaConfigDefault.getBaseUrl()}`);
console.log(`  Default Environment: ${bsaConfigDefault.getEnvironment()}`);
console.log(`  Expected: RC environment`);
console.log(`  Match: ${bsaConfigDefault.getEnvironment() === 'rc' ? '✅' : '❌'}`);

console.log('\n=================================');
console.log('All tests completed!');