// Setup script to initialize LangGraph checkpointer and store
// Run this ONCE when deploying or at the start of Phase 2
// Usage: node api/scripts/setup.js

require('dotenv').config();

async function setup() {
  console.log('[SETUP] Starting LangGraph initialization...');
  
  // Validate environment
  if (!process.env.POSTGRES_CONNECTION_STRING) {
    console.error('❌ POSTGRES_CONNECTION_STRING environment variable is required');
    console.error('Format: postgresql://postgres.[project-ref]:[password]@aws-0-us-west-1.pooler.supabase.com:6543/postgres');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY environment variable is required for embeddings');
    process.exit(1);
  }

  try {
    // Dynamic import for ESM modules
    const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
    
    console.log('[SETUP] Creating PostgresSaver checkpointer...');
    const checkpointer = PostgresSaver.fromConnString(process.env.POSTGRES_CONNECTION_STRING);
    
    // This creates the LangGraph-managed tables
    console.log('[SETUP] Setting up checkpointer tables...');
    await checkpointer.setup();
    
    console.log('✅ LangGraph checkpointer initialized successfully!');
    console.log('Tables created:');
    console.log('  - checkpoints (for conversation state)');
    console.log('  - checkpoint_blobs (for blob storage)');
    console.log('  - checkpoint_writes (for write tracking)');
    console.log('  - checkpoint_migrations (for schema versioning)');
    
    // Test the checkpointer
    console.log('\n[SETUP] Testing checkpointer...');
    const testThreadId = 'test-thread-' + Date.now();
    const testCheckpoint = {
      v: 1,
      id: 'test-checkpoint',
      ts: new Date().toISOString(),
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
      pending_sends: [],
      current_tasks: []
    };
    
    // Save a test checkpoint
    await checkpointer.put({
      configurable: { thread_id: testThreadId },
      checkpoint: testCheckpoint,
      metadata: { test: true }
    });
    
    // Retrieve it
    const retrieved = await checkpointer.get({ configurable: { thread_id: testThreadId } });
    
    if (retrieved?.checkpoint?.id === testCheckpoint.id) {
      console.log('✅ Checkpointer test successful - write and read working');
    } else {
      console.error('⚠️ Checkpointer test failed - check your configuration');
    }
    
    console.log('\n✨ PostgresSaver checkpointer is ready!');
    console.log('Note: Long-term memory will use custom PgMemoryStore adapter with ltm_memories table.');
    
  } catch (error) {
    console.error('❌ Setup failed:', error);
    console.error('\nTroubleshooting:');
    console.error('1. Check POSTGRES_CONNECTION_STRING is correct');
    console.error('2. Ensure pgvector extension is enabled in Supabase');
    console.error('3. Verify database connectivity');
    console.error('4. Check that packages are installed: pnpm add @langchain/langgraph-checkpoint-postgres');
    process.exit(1);
  }
}

// Run setup
setup().then(() => {
  console.log('\n🎉 Setup complete! You can now proceed with Phase 2 implementation.');
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});