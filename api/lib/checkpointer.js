// Use dynamic import for ES module compatibility
const { Pool } = require('pg');

class CheckpointerManager {
  constructor() {
    // Pool will be initialized in initialize() method
    this.pool = null;
    this.checkpointer = null;
  }

  async initialize() {
    // Get Supabase connection string - project uses SUPABASE_URL only
    // Note: SUPABASE_URL format: https://[project].supabase.co
    // Need to construct PostgreSQL connection string from it
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      console.warn('[CheckpointerManager] Missing Supabase credentials. Checkpointer disabled.');
      return null;
    }
    
    // Extract project ID from Supabase URL
    const projectId = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
    
    if (!projectId) {
      console.error('[CheckpointerManager] Invalid Supabase URL format');
      return null;
    }
    
    // Construct PostgreSQL connection string
    // Format: postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-ID].supabase.co:5432/postgres
    const connectionString = `postgresql://postgres:${supabaseKey}@db.${projectId}.supabase.co:5432/postgres`;
    
    // Initialize connection pool
    this.pool = new Pool({
      connectionString: connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    
    // Test connection
    try {
      await this.pool.query('SELECT 1');
      console.log('[CheckpointerManager] Database connection successful');
    } catch (error) {
      console.error('[CheckpointerManager] Database connection failed:', error.message);
      return null;
    }
    
    // Dynamic import for ES module
    try {
      const { PostgresSaver } = await import('@langchain/langgraph-checkpoint-postgres');
      
      this.checkpointer = PostgresSaver.fromConnString(connectionString);
      
      await this.checkpointer.setup();
      console.log('[CheckpointerManager] Checkpointer initialized successfully');
      return this.checkpointer;
    } catch (error) {
      console.error('[CheckpointerManager] Failed to initialize checkpointer:', error.message);
      return null;
    }
  }

  // Get or create thread config
  async getThread(sessionId, orgId) {
    return {
      configurable: {
        thread_id: `${sessionId}_${orgId}`,
        checkpoint_ns: ''
      }
    };
  }

  // Clean up old checkpoints (older than 30 days)
  async cleanupOldCheckpoints() {
    if (!this.pool) {
      console.warn('[CheckpointerManager] Pool not initialized, skipping cleanup');
      return;
    }
    
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    try {
      // Clean up main checkpoints table
      const result = await this.pool.query(
        'DELETE FROM checkpoints WHERE created_at < $1',
        [thirtyDaysAgo]
      );
      console.log(`[CheckpointerManager] Cleaned up ${result.rowCount} old checkpoints`);
      
      // Clean up associated writes
      await this.pool.query(
        'DELETE FROM checkpoint_writes WHERE thread_id NOT IN (SELECT DISTINCT thread_id FROM checkpoints)'
      );
      
      // Clean up blobs table if it exists (created by PostgresSaver)
      await this.pool.query(
        `DELETE FROM checkpoint_blobs 
         WHERE thread_id NOT IN (SELECT DISTINCT thread_id FROM checkpoints)`
      ).catch(() => {
        // Table might not exist yet, ignore error
      });
    } catch (error) {
      console.error('[CheckpointerManager] Cleanup error:', error.message);
    }
  }

  // Close the pool when shutting down
  async close() {
    if (this.pool) {
      await this.pool.end();
      console.log('[CheckpointerManager] Connection pool closed');
    }
  }
}

module.exports = { CheckpointerManager };