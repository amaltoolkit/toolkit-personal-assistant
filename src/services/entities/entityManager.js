/**
 * EntityManager - Centralized entity storage and retrieval service
 *
 * Manages entities in checkpoint state with:
 * - History tracking (last N entities of each type)
 * - Fast indexing (by ID and type)
 * - Automatic cleanup (bounded memory)
 * - Query helpers (search, filter, lookup)
 */

class EntityManager {
  constructor(options = {}) {
    this.maxHistoryPerType = options.maxHistoryPerType || 10;
    this.enableAutoCleanup = options.enableAutoCleanup !== false;
  }

  /**
   * Initialize entity structure if needed
   * @param {Object} entities - Current entities state
   * @returns {Object} Initialized entities structure
   */
  initialize(entities = {}) {
    if (!entities._history) {
      entities._history = {};
    }
    if (!entities._index) {
      entities._index = {};
    }
    if (!entities._meta) {
      entities._meta = {
        maxHistoryPerType: this.maxHistoryPerType,
        totalEntities: 0,
        oldestEntity: null,
        newestEntity: null
      };
    }
    return entities;
  }

  /**
   * Store an entity (adds to latest, history, and index)
   * @param {Object} entities - Current entities state
   * @param {string} type - Entity type (workflow, appointment, task, etc.)
   * @param {Object} entity - Entity data
   * @param {Object} options - Storage options
   * @returns {Object} Updated entities state
   */
  store(entities, type, entity, options = {}) {
    entities = this.initialize(entities);

    // Add timestamp if not present
    if (!entity.createdAt) {
      entity.createdAt = new Date().toISOString();
    }

    // Store as latest entity of this type
    entities[type] = entity;

    // Add to history
    if (!entities._history[type]) {
      entities._history[type] = [];
    }

    // Check if entity already exists in history (update instead of duplicate)
    const existingIndex = entities._history[type].findIndex(e => e.id === entity.id);
    if (existingIndex >= 0) {
      // Update existing entity
      entities._history[type][existingIndex] = entity;
      console.log(`[ENTITY_MANAGER] Updated existing ${type} entity:`, entity.id);
    } else {
      // Add new entity to beginning of array (most recent first)
      entities._history[type].unshift(entity);
      console.log(`[ENTITY_MANAGER] Stored new ${type} entity:`, entity.id);
    }

    // Add to index
    const indexKey = `${type}:${entity.id}`;
    entities._index[indexKey] = {
      type,
      createdAt: entity.createdAt,
      data: entity
    };

    // Auto-cleanup if enabled
    if (this.enableAutoCleanup) {
      this.cleanup(entities, type);
    }

    // Update metadata
    this.updateMetadata(entities);

    return entities;
  }

  /**
   * Get the latest entity of a specific type
   * @param {Object} entities - Current entities state
   * @param {string} type - Entity type
   * @returns {Object|null} Latest entity or null
   */
  getLatest(entities, type) {
    return entities[type] || null;
  }

  /**
   * Get entity by ID
   * @param {Object} entities - Current entities state
   * @param {string} type - Entity type
   * @param {string} id - Entity ID
   * @returns {Object|null} Entity or null
   */
  getById(entities, type, id) {
    const indexKey = `${type}:${id}`;
    const indexed = entities._index?.[indexKey];
    return indexed ? indexed.data : null;
  }

  /**
   * Get entity history (last N entities of a type)
   * @param {Object} entities - Current entities state
   * @param {string} type - Entity type
   * @param {number} limit - Maximum number to return
   * @returns {Array} Array of entities
   */
  getHistory(entities, type, limit = null) {
    const history = entities._history?.[type] || [];
    return limit ? history.slice(0, limit) : history;
  }

  /**
   * Search entities by field value
   * @param {Object} entities - Current entities state
   * @param {string} type - Entity type
   * @param {Object} query - Query object (e.g., { name: 'workflow name' })
   * @returns {Array} Array of matching entities
   */
  search(entities, type, query) {
    const history = this.getHistory(entities, type);

    return history.filter(entity => {
      return Object.keys(query).every(key => {
        const queryValue = query[key];
        const entityValue = entity[key];

        // Case-insensitive string matching
        if (typeof queryValue === 'string' && typeof entityValue === 'string') {
          return entityValue.toLowerCase().includes(queryValue.toLowerCase());
        }

        // Exact match for other types
        return entityValue === queryValue;
      });
    });
  }

  /**
   * Get all entity types currently stored
   * @param {Object} entities - Current entities state
   * @returns {Array} Array of entity type names
   */
  getTypes(entities) {
    if (!entities._history) return [];
    return Object.keys(entities._history);
  }

  /**
   * Get entity statistics
   * @param {Object} entities - Current entities state
   * @returns {Object} Statistics object
   */
  getStats(entities) {
    if (!entities._meta) {
      return {
        totalEntities: 0,
        types: [],
        byType: {}
      };
    }

    const types = this.getTypes(entities);
    const byType = {};

    types.forEach(type => {
      byType[type] = entities._history[type]?.length || 0;
    });

    return {
      totalEntities: entities._meta.totalEntities || 0,
      types,
      byType,
      oldestEntity: entities._meta.oldestEntity,
      newestEntity: entities._meta.newestEntity
    };
  }

  /**
   * Clean up old entities for a specific type (keep last N)
   * @param {Object} entities - Current entities state
   * @param {string} type - Entity type to clean up (if null, cleans all types)
   * @returns {Object} Updated entities state
   */
  cleanup(entities, type = null) {
    entities = this.initialize(entities);

    const typesToClean = type ? [type] : Object.keys(entities._history);

    typesToClean.forEach(t => {
      const history = entities._history[t];
      if (history && history.length > this.maxHistoryPerType) {
        // Remove oldest entities (from end of array)
        const removed = history.splice(this.maxHistoryPerType);

        // Remove from index
        removed.forEach(entity => {
          const indexKey = `${t}:${entity.id}`;
          delete entities._index[indexKey];
        });

        console.log(`[ENTITY_MANAGER] Cleaned up ${removed.length} old ${t} entities`);
      }
    });

    return entities;
  }

  /**
   * Update metadata statistics
   * @private
   */
  updateMetadata(entities) {
    const allTimestamps = [];

    Object.keys(entities._index).forEach(key => {
      const item = entities._index[key];
      if (item.createdAt) {
        allTimestamps.push(item.createdAt);
      }
    });

    entities._meta.totalEntities = Object.keys(entities._index).length;

    if (allTimestamps.length > 0) {
      allTimestamps.sort();
      entities._meta.oldestEntity = allTimestamps[0];
      entities._meta.newestEntity = allTimestamps[allTimestamps.length - 1];
    }
  }

  /**
   * Merge two entity states (smart merge for state channel reducer)
   * @param {Object} oldEntities - Previous entities state
   * @param {Object} newEntities - New entities state
   * @returns {Object} Merged entities state
   */
  merge(oldEntities, newEntities) {
    if (!newEntities) return oldEntities;
    if (!oldEntities) return this.initialize(newEntities);

    // Initialize both
    oldEntities = this.initialize(oldEntities);
    newEntities = this.initialize(newEntities);

    // Merge latest entity pointers
    const types = new Set([
      ...Object.keys(oldEntities).filter(k => !k.startsWith('_')),
      ...Object.keys(newEntities).filter(k => !k.startsWith('_'))
    ]);

    const merged = this.initialize({});

    types.forEach(type => {
      if (newEntities[type]) {
        // New entity takes precedence
        this.store(merged, type, newEntities[type]);
      } else if (oldEntities[type]) {
        // Keep old entity if no new one
        this.store(merged, type, oldEntities[type]);
      }
    });

    return merged;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  getEntityManager: (options) => {
    if (!instance) {
      instance = new EntityManager(options);
    }
    return instance;
  },
  EntityManager // Export class for testing
};
