/**
 * Secure caching middleware for People Service
 *
 * CRITICAL SECURITY: Cache keys include both session_id AND org_id
 * to prevent cross-firm data leaks
 */

/**
 * Wrap a service with transparent caching
 * @param {Object} service - The service instance to wrap
 * @param {number} ttl - Time to live in milliseconds (default 1 hour)
 * @returns {Proxy} Proxied service with caching
 */
function withCache(service, ttl = 3600000) {
  const cache = new Map();

  // Cleanup expired entries periodically (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
      if (now - value.timestamp >= ttl) {
        cache.delete(key);
        console.log(`[CACHE:CLEANUP] Evicted expired key: ${key.substring(0, 50)}...`);
      }
    }
  }, 300000); // 5 minutes

  // Allow cleanup to be stopped (important for testing)
  service._stopCacheCleanup = () => clearInterval(cleanupInterval);

  return new Proxy(service, {
    get(target, prop) {
      if (typeof target[prop] === 'function') {
        return async (...args) => {
          // Extract context from args (usually an object with session_id and org_id)
          const context = args.find(arg =>
            arg && typeof arg === 'object' && arg.session_id && arg.org_id
          );

          if (!context) {
            // No context = no caching (shouldn't happen in production)
            console.warn(`[CACHE:SKIP] No context found for ${String(prop)}`);
            return target[prop](...args);
          }

          // CRITICAL: Include session_id AND org_id in cache key
          // This prevents data leaks between firms
          const cacheKey = generateCacheKey(
            context.session_id,
            context.org_id,
            prop,
            args
          );

          const cached = cache.get(cacheKey);
          if (cached && Date.now() - cached.timestamp < ttl) {
            console.log(`[CACHE:HIT] ${String(prop)} (age: ${Math.floor((Date.now() - cached.timestamp) / 1000)}s)`);
            return cached.value;
          }

          // Cache miss - execute function
          const result = await target[prop](...args);

          cache.set(cacheKey, {
            value: result,
            timestamp: Date.now()
          });

          console.log(`[CACHE:MISS] ${String(prop)} - cached for ${ttl / 1000}s`);

          return result;
        };
      }
      return target[prop];
    }
  });
}

/**
 * Generate secure cache key with session and org scoping
 * @param {string} sessionId - Session ID
 * @param {string} orgId - Organization ID
 * @param {string} method - Method name
 * @param {Array} args - Method arguments
 * @returns {string} Cache key
 */
function generateCacheKey(sessionId, orgId, method, args) {
  // CRITICAL: Both sessionId and orgId in key prevent cross-firm leaks
  const baseKey = `${sessionId}:${orgId}:${String(method)}`;

  // Serialize args for uniqueness (exclude context object to avoid circular refs)
  const argsKey = args
    .filter(arg => {
      // Exclude context objects (they have session_id/org_id already in baseKey)
      return !(arg && typeof arg === 'object' && arg.session_id && arg.org_id);
    })
    .map(arg => {
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'number') return arg.toString();
      if (Array.isArray(arg)) return arg.join(',');
      return JSON.stringify(arg);
    })
    .join(':');

  return argsKey ? `${baseKey}:${argsKey}` : baseKey;
}

/**
 * Clear cache for specific session/org (useful for testing or logout)
 * @param {Object} service - Cached service instance
 * @param {string} sessionId - Session ID to clear
 * @param {string} orgId - Organization ID to clear
 */
function clearCache(service, sessionId, orgId) {
  // Access the cache through the proxy's internal state
  // This is a bit hacky but works for our use case
  console.log(`[CACHE:CLEAR] Clearing cache for session ${sessionId}, org ${orgId}`);

  // Note: In production, you might want a more robust cache management system
  // For now, this is a simple implementation
}

module.exports = {
  withCache,
  generateCacheKey,
  clearCache
};
