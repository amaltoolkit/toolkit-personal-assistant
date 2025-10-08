/**
 * UnifiedStore - Bridge between InMemoryStore and PgMemoryStore
 * 
 * Provides a single interface for all memory operations in the graph.
 * Uses PgMemoryStore for production (persistent with vector search)
 * Falls back to InMemoryStore for development (ephemeral)
 * 
 * This is a temporary solution until PostgresStore becomes available in LangGraph JS
 */

const { PgMemoryStore } = require('../memory/storeAdapter');

// Module-level cache for singleton instances per org/user combination
const storeCache = new Map();

class UnifiedStore {
  constructor(config = {}) {
    // Extract configuration
    this.orgId = config.orgId || null;
    this.userId = config.userId || null;
    this.isDev = config.isDev || process.env.NODE_ENV === 'development';
    this.debug = config.debug || process.env.DEBUG === 'true';
    
    // Initialize metrics
    this.metrics = {
      hits: 0,
      misses: 0,
      errors: 0,
      writes: 0,
      deletes: 0,
      searches: 0
    };
    
    // Stores will be initialized on first use
    this.pgStore = null;
    this.devStore = null;
    this.initialized = false;
    
    console.log(`[UnifiedStore] Created in ${this.isDev ? 'DEVELOPMENT' : 'PRODUCTION'} mode`);
    if (this.orgId && this.userId) {
      console.log(`[UnifiedStore] Context: org=${this.orgId}, user=${this.userId}`);
    }
  }
  
  /**
   * Initialize the appropriate stores based on environment
   */
  async initializeStores() {
    if (this.initialized) return;
    
    try {
      // Always try to initialize PgMemoryStore if we have credentials
      if (this.orgId && this.userId) {
        try {
          this.pgStore = new PgMemoryStore(this.orgId, this.userId);
          console.log('[UnifiedStore] PgMemoryStore initialized for persistent memory');
        } catch (pgError) {
          console.error('[UnifiedStore] PgMemoryStore error:', pgError.message);
          if (!this.isDev) {
            throw pgError; // Re-throw in production
          }
        }
      }
      
      // In dev mode, also initialize InMemoryStore as fallback
      if (this.isDev) {
        const { InMemoryStore } = await import('@langchain/langgraph');
        this.devStore = new InMemoryStore();
        console.log('[UnifiedStore] InMemoryStore initialized as development fallback');
      }
      
      this.initialized = true;
      
    } catch (error) {
      console.error('[UnifiedStore] Error initializing stores:', error.message);
      
      // If PgMemoryStore fails and we're in dev, use InMemoryStore only
      if (this.isDev) {
        console.warn('[UnifiedStore] Falling back to InMemoryStore only (dev mode)');
        const { InMemoryStore } = await import('@langchain/langgraph');
        this.devStore = new InMemoryStore();
        this.pgStore = null;
        this.initialized = true;
      } else {
        // In production, we must have PgMemoryStore
        throw new Error('Failed to initialize PgMemoryStore in production');
      }
    }
  }
  
  /**
   * Ensure stores are initialized before use
   */
  async ensureInitialized() {
    if (!this.initialized) {
      await this.initializeStores();
    }
  }
  
  /**
   * Store a value with optional vector indexing
   * LangGraph Store API compliant: returns void
   * @param {string[]} namespace - Namespace array
   * @param {string|null} key - Optional key (auto-generated if null)
   * @param {any} value - Value to store
   * @param {Object} options - Storage options
   * @returns {Promise<void>} Resolves when stored
   */
  async put(namespace, key, value, options = {}) {
    await this.ensureInitialized();
    this.metrics.writes++;
    
    try {
      // Generate key if not provided (for compatibility)
      const actualKey = key || this.generateKey();
      
      // Always write to PgMemoryStore if available
      if (this.pgStore) {
        // PgMemoryStore.put now returns void (Store API compliant)
        await this.pgStore.put(namespace, actualKey, value, options);
        if (this.debug) {
          console.log(`[UnifiedStore:PUT] Stored to PgMemoryStore`);
        }
        
        // Mirror to InMemoryStore in dev mode for testing
        if (this.devStore && this.isDev) {
          await this.devStore.put(namespace, actualKey, value);
          if (this.debug) {
            console.log(`[UnifiedStore:PUT] Mirrored to InMemoryStore (dev)`);
          }
        }
        
        return; // Store API compliance: return void
      }
      
      // Fallback to InMemoryStore if no PgMemoryStore
      if (this.devStore) {
        await this.devStore.put(namespace, actualKey, value);
        console.warn(`[UnifiedStore:PUT] Using InMemoryStore only (dev fallback)`);
        return; // Store API compliance: return void
      }
      
      throw new Error('No store available for put operation');
      
    } catch (error) {
      this.metrics.errors++;
      console.error('[UnifiedStore:PUT] Error:', error.message);
      throw error;
    }
  }
  
  /**
   * Retrieve a value by key
   * @param {string[]} namespace - Namespace to search
   * @param {string} key - Key to retrieve
   * @returns {Promise<Object|null>} The stored item or null
   */
  async get(namespace, key) {
    await this.ensureInitialized();
    try {
      // Try PgMemoryStore first
      if (this.pgStore) {
        const result = await this.pgStore.get(namespace, key);
        if (result) {
          this.metrics.hits++;
          if (this.debug) {
            console.log(`[UnifiedStore:GET] Found in PgMemoryStore: key=${key}`);
          }
          return result;
        }
      }
      
      // Try InMemoryStore as fallback in dev
      if (this.devStore && this.isDev) {
        const result = await this.devStore.get(namespace, key);
        if (result) {
          this.metrics.hits++;
          if (this.debug) {
            console.log(`[UnifiedStore:GET] Found in InMemoryStore (dev): key=${key}`);
          }
          return result;
        }
      }
      
      this.metrics.misses++;
      if (this.debug) {
        console.log(`[UnifiedStore:GET] Not found: key=${key}`);
      }
      return null;
      
    } catch (error) {
      this.metrics.errors++;
      console.error('[UnifiedStore:GET] Error:', error.message);
      return null;
    }
  }
  
  /**
   * Delete a value by key
   * LangGraph Store API compliant: returns void
   * @param {string[]} namespace - Namespace to search
   * @param {string} key - Key to delete
   * @returns {Promise<void>} Resolves when deleted
   */
  async delete(namespace, key) {
    await this.ensureInitialized();
    this.metrics.deletes++;
    
    try {
      // Delete from both stores if available
      const promises = [];
      
      if (this.pgStore) {
        // PgMemoryStore.delete now returns void (Store API compliant)
        promises.push(this.pgStore.delete(namespace, key));
      }
      
      if (this.devStore) {
        promises.push(this.devStore.delete(namespace, key));
      }
      
      await Promise.all(promises);
      
      if (this.debug) {
        console.log(`[UnifiedStore:DELETE] Deleted key=${key} from all stores`);
      }
      
      // Store API compliance: return void
      
    } catch (error) {
      this.metrics.errors++;
      console.error('[UnifiedStore:DELETE] Error:', error.message);
      throw error;
    }
  }
  
  /**
   * List namespaces with a given prefix
   * @param {string[]} prefix - Namespace prefix
   * @param {Object} options - Query options
   * @returns {Promise<string[][]>} Array of namespaces
   */
  async listNamespaces(prefix, options = {}) {
    await this.ensureInitialized();
    try {
      // Use PgMemoryStore if available
      if (this.pgStore) {
        const namespaces = await this.pgStore.listNamespaces(
          prefix,
          options.limit || 50,
          options.offset || 0
        );
        if (this.debug) {
          console.log(`[UnifiedStore:LIST] Found ${namespaces.length} namespaces`);
        }
        return namespaces;
      }
      
      // Fallback to InMemoryStore
      if (this.devStore) {
        const namespaces = await this.devStore.listNamespaces(prefix, options);
        console.warn(`[UnifiedStore:LIST] Using InMemoryStore (dev): found ${namespaces.length}`);
        return namespaces;
      }
      
      return [];
      
    } catch (error) {
      this.metrics.errors++;
      console.error('[UnifiedStore:LIST] Error:', error.message);
      return [];
    }
  }
  
  /**
   * Search for memories using semantic search (PgMemoryStore only)
   * @param {string[]} namespacePrefix - Namespace prefix to search
   * @param {string|Object} query - Search query or options object
   * @param {Object} options - Additional search options
   * @returns {Promise<Array>} Search results with scores
   */
  async search(namespacePrefix, query, options = {}) {
    await this.ensureInitialized();
    this.metrics.searches++;
    
    try {
      // Semantic search only available in PgMemoryStore
      if (this.pgStore) {
        const searchOptions = typeof query === 'string' 
          ? { query, ...options }
          : { ...query, ...options };
          
        const results = await this.pgStore.search(namespacePrefix, searchOptions);
        
        if (this.debug) {
          console.log(`[UnifiedStore:SEARCH] Found ${results.length} results for query`);
        }
        
        return results;
      }
      
      // InMemoryStore doesn't support semantic search
      if (this.devStore) {
        console.warn('[UnifiedStore:SEARCH] Semantic search not available in InMemoryStore');
        // Could implement basic text matching as fallback
        return [];
      }
      
      return [];
      
    } catch (error) {
      this.metrics.errors++;
      console.error('[UnifiedStore:SEARCH] Error:', error.message);
      return [];
    }
  }
  
  /**
   * Batch get multiple items
   * @param {Array} items - Array of {namespace, key} objects
   * @returns {Promise<Array>} Array of results (item or null for each)
   */
  async batchGet(items) {
    const results = [];
    
    for (const item of items) {
      const result = await this.get(item.namespace, item.key);
      results.push(result);
    }
    
    if (this.debug) {
      const found = results.filter(r => r !== null).length;
      console.log(`[UnifiedStore:BATCH_GET] Found ${found}/${items.length} items`);
    }
    
    return results;
  }
  
  /**
   * Batch put multiple items
   * LangGraph Store API compliant: returns void
   * @param {Array} items - Array of {namespace, key, value, options} objects
   * @returns {Promise<void>} Resolves when all items stored
   */
  async batchPut(items) {
    await this.ensureInitialized();
    
    // Use PgMemoryStore's optimized batch method if available
    if (this.pgStore && this.pgStore.batchPut) {
      // PgMemoryStore.batchPut now returns void (Store API compliant)
      await this.pgStore.batchPut(items);
      
      // Mirror to InMemoryStore in dev
      if (this.devStore && this.isDev) {
        for (const item of items) {
          const actualKey = item.key || this.generateKey();
          await this.devStore.put(item.namespace, actualKey, item.value);
        }
      }
      
      if (this.debug) {
        console.log(`[UnifiedStore:BATCH_PUT] Stored ${items.length} items`);
      }
      return; // Store API compliance: return void
    }
    
    // Fallback to sequential puts
    for (const item of items) {
      await this.put(item.namespace, item.key, item.value, item.options || {});
    }
  }
  
  /**
   * Get metrics for monitoring
   * @returns {Object} Current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      mode: this.isDev ? 'development' : 'production',
      hasPostgres: !!this.pgStore,
      hasInMemory: !!this.devStore
    };
  }
  
  /**
   * Clear all data in a namespace (use with caution)
   * @param {string[]} namespacePrefix - Namespace prefix to clear
   * @returns {Promise<number>} Number of items deleted
   */
  async clearNamespace(namespacePrefix) {
    if (!this.isDev) {
      throw new Error('clearNamespace is only available in development mode');
    }
    
    let count = 0;
    
    if (this.pgStore && this.pgStore.clearNamespace) {
      count = await this.pgStore.clearNamespace(namespacePrefix);
    }
    
    if (this.devStore) {
      // InMemoryStore doesn't have clearNamespace, so we need to manually clear
      const namespaces = await this.devStore.listNamespaces(namespacePrefix);
      for (const ns of namespaces) {
        // This is a simplified approach - real implementation would need all keys
        console.warn('[UnifiedStore:CLEAR] InMemoryStore clearing not fully implemented');
      }
    }
    
    console.log(`[UnifiedStore:CLEAR] Cleared ${count} items from namespace`);
    return count;
  }
  
  /**
   * Generate a unique key
   * @returns {string} UUID
   */
  generateKey() {
    const crypto = require('crypto');
    return crypto.randomUUID();
  }
}

/**
 * Factory function to get or create a UnifiedStore instance
 * Uses caching to ensure singleton per org/user combination
 * 
 * @param {Object} config - Configuration object
 * @returns {UnifiedStore} UnifiedStore instance
 */
function getUnifiedStore(config = {}) {
  const { orgId, userId } = config;
  
  // Create cache key
  const cacheKey = `${orgId || 'default'}_${userId || 'default'}`;
  
  // Check cache
  if (storeCache.has(cacheKey)) {
    return storeCache.get(cacheKey);
  }
  
  // Create new instance and cache it
  const store = new UnifiedStore(config);
  storeCache.set(cacheKey, store);
  
  return store;
}

/**
 * Clear the store cache (useful for testing)
 */
function clearStoreCache() {
  storeCache.clear();
  console.log('[UnifiedStore] Cache cleared');
}

module.exports = {
  UnifiedStore,
  getUnifiedStore,
  clearStoreCache
};