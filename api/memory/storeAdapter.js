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
   * Upsert a memory. If key is not provided, generate one.
   * @param {string[]} namespace - Namespace array (e.g., ["org_id", "user_id", "memories"])
   * @param {string|null} key - Optional key, will generate UUID if null
   * @param {any} value - Value to store (object or string)
   * @param {Object} options - Options for storage
   * @returns {Promise<string>} The key of the stored item
   */
  async put(namespace, key, value, options = {}) {
    const k = key || uuid();
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
    return k;
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
   * @param {string[]} namespace - Namespace to check
   * @param {string} key - Key to delete
   * @returns {Promise<Object>} Deletion result
   */
  async delete(namespace, key) {
    // First check if the item exists and is in the namespace
    const item = await this.get(namespace, key);
    if (!item) {
      return { deleted: 0 };
    }
    
    const { error } = await this.supabase
      .from("ltm_memories")
      .delete()
      .eq("key", key);
    
    if (error) {
      throw new Error(`[PgMemoryStore] delete failed: ${error.message}`);
    }
    
    console.log(`[PgMemoryStore] Deleted memory with key ${key}`);
    return { deleted: 1 };
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
      // Create embedding for the query
      const queryVec = await this.embeddings.embedQuery(query);
      
      // Call the SQL function for semantic search
      const { data, error } = await this.supabase.rpc("ltm_semantic_search", {
        ns_prefix: namespacePrefix,
        query_vec: queryVec,
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
   * Batch put multiple memories
   * @param {Array} items - Array of {namespace, key, value, options} objects
   * @returns {Promise<string[]>} Array of keys
   */
  async batchPut(items) {
    const keys = [];
    for (const item of items) {
      const key = await this.put(
        item.namespace,
        item.key || null,
        item.value,
        item.options || {}
      );
      keys.push(key);
    }
    return keys;
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