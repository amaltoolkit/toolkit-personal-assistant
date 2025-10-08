// PgMemoryStore adapter for persistent memory with vector search
// Implements Store-compatible API for easy migration when PostgresStore becomes available
// Uses ltm_memories table with pgvector for semantic search

const crypto = require("crypto");
const uuid = () => crypto.randomUUID();
const { createClient } = require("@supabase/supabase-js");
const { OpenAIEmbeddings } = require("@langchain/openai");

class PgMemoryStore {
  constructor(defaultOrgId, defaultUserId) {
    this.defaultOrgId = defaultOrgId || null;
    this.defaultUserId = defaultUserId || null;
    
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
    
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    
    this.embeddings = new OpenAIEmbeddings({
      model: "text-embedding-3-small",
      openAIApiKey: process.env.OPENAI_API_KEY
    });
  }
  
  /**
   * Check if a string is a valid UUID
   * @param {string} str - String to check
   * @returns {boolean} True if valid UUID
   */
  isValidUUID(str) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }
  
  /**
   * Upsert a memory. If key is not provided, generate one.
   * LangGraph Store API: put(namespace, key, value) -> Promise<void>
   * @param {string[]} namespace - Namespace array (e.g., ["org_id", "user_id", "memories"])
   * @param {string|null} key - Optional key, will generate UUID if null or if string provided
   * @param {any} value - Value to store (object or string)
   * @param {Object} options - Options for storage
   * @returns {Promise<void>} Resolves when stored (Store API compliant)
   */
  async put(namespace, key, value, options = {}) {
    // Always use UUID - if string key provided, generate new UUID
    // This handles the database UUID constraint
    let k;
    if (!key) {
      k = uuid();
    } else if (this.isValidUUID(key)) {
      k = key;
    } else {
      // Non-UUID key provided, generate UUID and store original in metadata
      k = uuid();
      if (options.preserveOriginalKey !== false) {
        value = { ...value, _originalKey: key };
      }
    }
    
    const text = value?.text || JSON.stringify(value);
    const orgId = options?.orgId || this.defaultOrgId || namespace[0] || "unknown_org";
    const userId = options?.userId || this.defaultUserId || namespace[1] || "unknown_user";
    
    let embedding = null;
    if (options?.index !== false) {
      try {
        embedding = await this.embeddings.embedQuery(text);
        console.log(`[PgMemoryStore] Created embedding for key ${k}`);
      } catch (error) {
        console.error("[PgMemoryStore] Failed to create embedding:", error.message);
      }
    }
    
    const { error } = await this.supabase
      .from("ltm_memories")
      .upsert({
        key: k,
        org_id: orgId,
        user_id: userId,
        namespace,
        kind: value?.kind || "fact",
        subject_id: value?.subjectId || null,
        text,
        importance: value?.importance || 3,
        ttl_days: options?.ttlDays || null,
        embedding,
        source: options?.source || "manual",
        updated_at: new Date().toISOString()
      });
    
    if (error) {
      throw new Error(`[PgMemoryStore] put failed: ${error.message}`);
    }
    
    console.log(`[PgMemoryStore] Stored memory with key ${k} in namespace [${namespace.join(", ")}]`);
    
    // Store API compliance: return void (no return value)
    // If caller needs the key, they should provide one or use a separate method
  }
  
  /**
   * Get a memory by key
   * @param {string[]} namespace - Namespace to check
   * @param {string} key - Key to retrieve
   * @returns {Promise<Object|null>} The stored item or null
   */
  async get(namespace, key) {
    const { data, error } = await this.supabase
      .from("ltm_memories")
      .select("*")
      .eq("key", key)
      .single();
    
    if (error || !data) {
      return null;
    }
    
    // Check if the item is in the requested namespace
    if (!this.isInPrefix(namespace, data.namespace)) {
      return null;
    }
    
    return {
      namespace: data.namespace,
      key: data.key,
      value: {
        text: data.text,
        kind: data.kind,
        subjectId: data.subject_id,
        importance: data.importance,
        source: data.source,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      }
    };
  }
  
  /**
   * Delete a memory by key
   * LangGraph Store API: delete(namespace, key) -> Promise<void>
   * @param {string[]} namespace - Namespace to check
   * @param {string} key - Key to delete
   * @returns {Promise<void>} Resolves when deleted (Store API compliant)
   */
  async delete(namespace, key) {
    // First check if the item exists and is in the namespace
    const item = await this.get(namespace, key);
    if (!item) {
      // Store API: silently succeed if item doesn't exist
      return;
    }
    
    const { error } = await this.supabase
      .from("ltm_memories")
      .delete()
      .eq("key", key);
    
    if (error) {
      throw new Error(`[PgMemoryStore] delete failed: ${error.message}`);
    }
    
    console.log(`[PgMemoryStore] Deleted memory with key ${key}`);
    
    // Store API compliance: return void
  }
  
  /**
   * List all namespaces with the given prefix
   * @param {string[]} prefix - Namespace prefix to filter
   * @param {number} limit - Maximum number of results
   * @param {number} offset - Offset for pagination
   * @returns {Promise<string[][]>} Array of namespaces
   */
  async listNamespaces(prefix, limit = 50, offset = 0) {
    const { data, error } = await this.supabase
      .from("ltm_memories")
      .select("namespace")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (error) {
      throw new Error(`[PgMemoryStore] listNamespaces failed: ${error.message}`);
    }
    
    // Filter to unique namespaces matching the prefix
    const unique = new Set();
    for (const row of data || []) {
      if (this.isInPrefix(prefix, row.namespace)) {
        unique.add(JSON.stringify(row.namespace));
      }
    }
    
    return Array.from(unique).map(s => JSON.parse(s));
  }
  
  /**
   * Search for memories using semantic search
   * @param {string[]} namespacePrefix - Namespace prefix to search within
   * @param {Object} options - Search options
   * @returns {Promise<Array>} Array of search results with scores
   */
  async search(namespacePrefix, options = {}) {
    const query = typeof options === "string" ? options : options.query;
    const limit = options.limit || 5;
    const minImportance = options.minImportance || 1;
    
    if (!query) {
      console.warn("[PgMemoryStore] Search called without query");
      return [];
    }
    
    try {
      // Extract org_id and user_id from namespace
      const orgId = namespacePrefix[0] || this.defaultOrgId;
      const userId = namespacePrefix[1] || this.defaultUserId;
      const memoryType = namespacePrefix[2] || 'memories';
      
      // Create embedding for the query
      const queryVec = await this.embeddings.embedQuery(query);
      
      // Call the new SQL function with proper isolation
      const { data, error } = await this.supabase.rpc("ltm_semantic_search_v2", {
        p_org_id: orgId,
        p_user_id: userId,
        query_vec: queryVec,
        p_memory_type: memoryType,
        match_count: limit,
        min_importance: minImportance
      });
      
      if (error) {
        throw new Error(`[PgMemoryStore] search failed: ${error.message}`);
      }
      
      console.log(`[PgMemoryStore] Found ${(data || []).length} memories for query: "${query}"`);
      
      return (data || []).map(row => ({
        namespace: row.namespace,
        key: row.key,
        score: row.score,
        value: {
          text: row.text,
          kind: row.kind,
          subjectId: row.subject_id,
          importance: row.importance
        }
      }));
      
    } catch (error) {
      console.error("[PgMemoryStore] Search error:", error.message);
      return [];
    }
  }
  
  /**
   * Check if a candidate namespace is within a prefix
   * @param {string[]} prefix - Prefix to check
   * @param {string[]} candidate - Candidate namespace
   * @returns {boolean} True if candidate starts with prefix
   */
  isInPrefix(prefix, candidate) {
    if (!Array.isArray(candidate)) return false;
    if (prefix.length > candidate.length) return false;
    
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] !== candidate[i]) return false;
    }
    
    return true;
  }
  
  /**
   * Batch get multiple items
   * LangGraph Store API: batchGet(items) -> Promise<(Item | null)[]>
   * @param {Array} items - Array of {namespace, key} objects
   * @returns {Promise<Array>} Array of items or null for each key
   */
  async batchGet(items) {
    // Fetch all items in parallel for better performance
    const promises = items.map(item => 
      this.get(item.namespace, item.key)
    );
    
    const results = await Promise.all(promises);
    console.log(`[PgMemoryStore] Batch get: ${results.filter(r => r !== null).length}/${items.length} found`);
    return results;
  }
  
  /**
   * Batch put multiple memories (optimized with bulk insert)
   * LangGraph Store API: batchPut(items) -> Promise<void>
   * @param {Array} items - Array of {namespace, key, value, options} objects
   * @returns {Promise<void>} Resolves when all items are stored
   */
  async batchPut(items) {
    if (!items || items.length === 0) {
      return;
    }
    
    try {
      // Step 1: Generate embeddings in parallel for all items that need them
      const embeddingPromises = items.map(async (item) => {
        if (item.options?.index === false) {
          return null;
        }
        
        const text = item.value?.text || JSON.stringify(item.value);
        try {
          return await this.embeddings.embedQuery(text);
        } catch (error) {
          console.error(`[PgMemoryStore] Failed to create embedding for batch item:`, error.message);
          return null;
        }
      });
      
      const embeddings = await Promise.all(embeddingPromises);
      
      // Step 2: Prepare bulk insert data
      const records = items.map((item, index) => {
        // Handle UUID constraint
        let key;
        if (!item.key) {
          key = uuid();
        } else if (this.isValidUUID(item.key)) {
          key = item.key;
        } else {
          key = uuid();
          if (item.options?.preserveOriginalKey !== false) {
            item.value = { ...item.value, _originalKey: item.key };
          }
        }
        
        const text = item.value?.text || JSON.stringify(item.value);
        const orgId = item.options?.orgId || this.defaultOrgId || item.namespace[0] || "unknown_org";
        const userId = item.options?.userId || this.defaultUserId || item.namespace[1] || "unknown_user";
        
        return {
          key,
          org_id: orgId,
          user_id: userId,
          namespace: item.namespace,
          kind: item.value?.kind || "fact",
          subject_id: item.value?.subjectId || null,
          text,
          importance: item.value?.importance || 3,
          ttl_days: item.options?.ttlDays || null,
          embedding: embeddings[index],
          source: item.options?.source || "manual",
          updated_at: new Date().toISOString()
        };
      });
      
      // Step 3: Perform bulk upsert in a single operation
      const { error } = await this.supabase
        .from("ltm_memories")
        .upsert(records);
      
      if (error) {
        throw new Error(`[PgMemoryStore] batchPut failed: ${error.message}`);
      }
      
      console.log(`[PgMemoryStore] Batch stored ${records.length} memories`);
      
      // Store API compliance: return void
    } catch (error) {
      console.error(`[PgMemoryStore] batchPut error:`, error);
      throw error;
    }
  }
  
  /**
   * Search for memories using text matching (no embeddings required)
   * @param {string[]} namespacePrefix - Namespace to search within
   * @param {Object} options - Search options
   * @returns {Promise<Array>} Array of search results
   */
  async searchByText(namespacePrefix, options = {}) {
    const searchText = typeof options === "string" ? options : (options.text || '');
    const limit = options.limit || 50;
    const minImportance = options.minImportance || 1;
    
    try {
      // Extract org_id and user_id from namespace
      const orgId = namespacePrefix[0] || this.defaultOrgId;
      const userId = namespacePrefix[1] || this.defaultUserId;
      const memoryType = namespacePrefix[2] || 'memories';
      
      // Call the text search SQL function
      const { data, error } = await this.supabase.rpc("ltm_search_by_text", {
        p_org_id: orgId,
        p_user_id: userId,
        search_text: searchText,
        p_memory_type: memoryType,
        match_count: limit,
        min_importance: minImportance
      });
      
      if (error) {
        throw new Error(`[PgMemoryStore] text search failed: ${error.message}`);
      }
      
      console.log(`[PgMemoryStore] Found ${(data || []).length} memories via text search`);
      
      return (data || []).map(row => ({
        namespace: row.namespace,
        key: row.key,
        value: {
          text: row.text,
          kind: row.kind,
          subjectId: row.subject_id,
          importance: row.importance,
          createdAt: row.created_at
        }
      }));
      
    } catch (error) {
      console.error("[PgMemoryStore] Text search error:", error.message);
      return [];
    }
  }
  
  /**
   * Clear all memories for a namespace prefix
   * @param {string[]} namespacePrefix - Namespace prefix to clear
   * @returns {Promise<number>} Number of deleted items
   */
  async clearNamespace(namespacePrefix) {
    // First get all items in the namespace
    const namespaces = await this.listNamespaces(namespacePrefix, 1000, 0);
    let deletedCount = 0;
    
    for (const ns of namespaces) {
      if (this.isInPrefix(namespacePrefix, ns)) {
        const { data } = await this.supabase
          .from("ltm_memories")
          .select("key")
          .eq("namespace", ns);
        
        for (const item of data || []) {
          await this.delete(ns, item.key);
          deletedCount++;
        }
      }
    }
    
    console.log(`[PgMemoryStore] Cleared ${deletedCount} memories from namespace [${namespacePrefix.join(", ")}]`);
    return deletedCount;
  }
}

module.exports = {
  PgMemoryStore
};