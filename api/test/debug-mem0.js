require('dotenv').config();

console.log('1. API Key present:', !!process.env.MEM0_API_KEY);
console.log('2. API Key length:', process.env.MEM0_API_KEY ? process.env.MEM0_API_KEY.length : 0);

try {
  const { MemoryClient } = require('mem0ai');
  console.log('3. MemoryClient imported successfully');
  
  const apiKey = process.env.MEM0_API_KEY;
  console.log('4. Creating client with API key...');
  
  const client = new MemoryClient({ apiKey });
  console.log('5. Client created:', !!client);
  
  // Try to make a simple API call
  console.log('6. Testing API connection...');
  client.search('test', { user_id: 'test-user' })
    .then(results => {
      console.log('7. API call successful, results:', results.length);
    })
    .catch(error => {
      console.log('7. API call failed:', error.message);
      if (error.response) {
        console.log('   Status:', error.response.status);
        console.log('   Data:', error.response.data);
      }
    });
    
} catch (error) {
  console.log('Error:', error.message);
  console.log('Stack:', error.stack);
}