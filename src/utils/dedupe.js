// Dedupe library to prevent duplicate BSA API writes
// Uses a hash of the payload to detect duplicates within a time window

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Wraps a function with deduplication logic
 * @param {Object} payload - The payload to hash for deduplication
 * @param {number} windowMs - Time window in milliseconds to check for duplicates
 * @param {Function} fn - The async function to execute if not a duplicate
 * @returns {Promise<Object>} Result of the function or {skipped: true} if duplicate
 */
async function withDedupe(payload, windowMs, fn) {
  try {
    // Create a deterministic hash of the payload
    const hash = crypto.createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    
    // Calculate cutoff time for the deduplication window
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    
    console.log(`[DEDUPE] Checking hash: ${hash.substring(0, 8)}... (window: ${windowMs}ms)`);
    
    // Check if this action was already performed within the window
    const { data: existing, error: checkError } = await supabase
      .from("action_dedupe")
      .select("hash")
      .eq("hash", hash)
      .gt("created_at", cutoff)
      .maybeSingle();
    
    if (checkError) {
      console.error("[DEDUPE] Error checking for duplicates:", checkError);
      // On error, proceed with caution - maybe allow the action
      // In production, you might want to throw here instead
    }
    
    if (existing) {
      console.log(`[DEDUPE] Skipping duplicate action: ${hash.substring(0, 8)}...`);
      return { 
        skipped: true, 
        hash,
        reason: "Duplicate action detected within time window"
      };
    }
    
    // Record this action hash to prevent future duplicates
    const { error: insertError } = await supabase
      .from("action_dedupe")
      .insert({ hash });
    
    if (insertError) {
      console.error("[DEDUPE] Error recording action hash:", insertError);
      // Proceed anyway - better to risk a duplicate than block the action
    }
    
    console.log(`[DEDUPE] Executing new action: ${hash.substring(0, 8)}...`);
    
    // Execute the wrapped function
    const result = await fn();
    
    return {
      ...result,
      dedupe: {
        hash,
        executed: true
      }
    };
    
  } catch (error) {
    console.error("[DEDUPE] Unexpected error:", error);
    throw error;
  }
}

/**
 * Cleanup old dedupe records to prevent table bloat
 * Call this periodically (e.g., daily via cron job)
 * @param {number} olderThanDays - Delete records older than this many days
 */
async function cleanupOldDedupeRecords(olderThanDays = 7) {
  try {
    const cutoff = new Date(Date.now() - (olderThanDays * 24 * 60 * 60 * 1000)).toISOString();
    
    const { data, error } = await supabase
      .from("action_dedupe")
      .delete()
      .lt("created_at", cutoff);
    
    if (error) {
      console.error("[DEDUPE] Error cleaning up old records:", error);
      return { success: false, error };
    }
    
    console.log(`[DEDUPE] Cleaned up dedupe records older than ${olderThanDays} days`);
    return { success: true, data };
    
  } catch (error) {
    console.error("[DEDUPE] Cleanup error:", error);
    return { success: false, error };
  }
}

module.exports = {
  withDedupe,
  cleanupOldDedupeRecords
};