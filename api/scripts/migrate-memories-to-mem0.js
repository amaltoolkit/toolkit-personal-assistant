/**
 * Memory Migration Script - Migrate from ltm_memories to Mem0 Cloud
 *
 * This script migrates existing memories from Supabase ltm_memories table
 * to the Mem0 cloud service while preserving metadata and importance.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function migrateMemoriesToMem0() {
  log('\n📦 MEMORY MIGRATION TO MEM0', 'cyan');
  log('='.repeat(50), 'cyan');

  try {
    // Initialize services
    log('\n🔧 Initializing services...', 'blue');

    // Initialize Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    log('✅ Supabase client initialized', 'green');

    // Initialize Mem0
    const { getMem0Service } = require('../services/mem0Service');
    const mem0 = getMem0Service();
    log('✅ Mem0 service initialized', 'green');

    // Fetch memories from database
    log('\n📊 Fetching memories from ltm_memories table...', 'blue');

    const { data: memories, error: fetchError } = await supabase
      .from('ltm_memories')
      .select('*')
      .gte('importance', 3)  // Only migrate important memories (3+)
      .order('created_at', { ascending: true });

    if (fetchError) {
      throw new Error(`Failed to fetch memories: ${fetchError.message}`);
    }

    log(`✅ Found ${memories.length} memories to migrate`, 'green');

    if (memories.length === 0) {
      log('\n⚠️  No memories found to migrate', 'yellow');
      return;
    }

    // Group memories by org_id and user_id for better tracking
    const memoryGroups = {};
    memories.forEach(memory => {
      const key = `${memory.org_id}:${memory.user_id}`;
      if (!memoryGroups[key]) {
        memoryGroups[key] = [];
      }
      memoryGroups[key].push(memory);
    });

    log(`\n📝 Migrating memories for ${Object.keys(memoryGroups).length} user(s)...`, 'blue');

    // Migration statistics
    let totalMigrated = 0;
    let totalFailed = 0;
    const failedMemories = [];

    // Migrate memories by user
    for (const [userKey, userMemories] of Object.entries(memoryGroups)) {
      const [orgId, userId] = userKey.split(':');
      log(`\n👤 Migrating ${userMemories.length} memories for user ${userId} in org ${orgId}`, 'cyan');

      for (const memory of userMemories) {
        try {
          // Prepare messages for Mem0
          const messages = [
            {
              role: 'system',
              content: memory.text
            }
          ];

          // Prepare metadata
          const metadata = {
            migrated: true,
            original_id: memory.key,
            kind: memory.kind || 'fact',
            importance: memory.importance || 3,
            source: memory.source || 'ltm_migration',
            created_at: memory.created_at,
            namespace: memory.namespace || []
          };

          // If there's a subject_id, include it
          if (memory.subject_id) {
            metadata.subject_id = memory.subject_id;
          }

          // Synthesize to Mem0
          const result = await mem0.synthesize(
            messages,
            orgId,
            userId,
            metadata
          );

          if (result) {
            totalMigrated++;
            process.stdout.write('.');  // Progress indicator
          } else {
            throw new Error('No result from Mem0 synthesis');
          }

        } catch (error) {
          totalFailed++;
          failedMemories.push({
            memory_id: memory.key,
            error: error.message
          });
          process.stdout.write('x');  // Failure indicator
        }

        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Print migration summary
    log('\n\n' + '='.repeat(50), 'cyan');
    log('MIGRATION SUMMARY', 'cyan');
    log('='.repeat(50), 'cyan');

    log(`✅ Successfully migrated: ${totalMigrated} memories`, 'green');

    if (totalFailed > 0) {
      log(`❌ Failed to migrate: ${totalFailed} memories`, 'red');
      log('\nFailed memory IDs:', 'yellow');
      failedMemories.forEach(f => {
        log(`  - ${f.memory_id}: ${f.error}`, 'yellow');
      });
    }

    const successRate = ((totalMigrated / memories.length) * 100).toFixed(1);
    log(`\n📊 Success rate: ${successRate}%`, successRate >= 90 ? 'green' : 'yellow');

    // Verification step
    log('\n🔍 Verifying migration...', 'blue');

    // Test recall for a random user
    const testUserKey = Object.keys(memoryGroups)[0];
    const [testOrgId, testUserId] = testUserKey.split(':');

    const testRecall = await mem0.recall(
      'test query',
      testOrgId,
      testUserId,
      { limit: 5 }
    );

    log(`✅ Verification successful: ${testRecall.length} memories retrievable`, 'green');

    // Optional: Archive migrated memories
    if (process.argv.includes('--archive')) {
      log('\n📁 Archiving migrated memories...', 'blue');

      const { error: archiveError } = await supabase
        .from('ltm_memories')
        .update({
          source: 'migrated_to_mem0',
          updated_at: new Date().toISOString()
        })
        .in('key', memories.map(m => m.key));

      if (archiveError) {
        log(`⚠️  Failed to archive: ${archiveError.message}`, 'yellow');
      } else {
        log('✅ Memories marked as migrated', 'green');
      }
    }

    log('\n' + '='.repeat(50), 'green');
    log('🎉 MIGRATION COMPLETE!', 'green');
    log('='.repeat(50), 'green');

    // Provide next steps
    log('\n📋 NEXT STEPS:', 'cyan');
    log('1. Test the migrated memories in the application', 'blue');
    log('2. Monitor Mem0 dashboard for usage', 'blue');
    log('3. Once verified, consider removing old memory code', 'blue');
    log('4. Update documentation to reflect Mem0 usage', 'blue');

    if (!process.argv.includes('--archive')) {
      log('\n💡 TIP: Run with --archive flag to mark memories as migrated', 'yellow');
    }

    return true;

  } catch (error) {
    log('\n❌ MIGRATION FAILED!', 'red');
    log('='.repeat(50), 'red');
    log(`Error: ${error.message}`, 'red');

    if (error.stack) {
      log('\nStack trace:', 'red');
      log(error.stack, 'red');
    }

    // Diagnostic information
    log('\n📋 DIAGNOSTICS', 'yellow');
    log('='.repeat(50), 'yellow');
    log(`MEM0_API_KEY configured: ${process.env.MEM0_API_KEY ? 'Yes' : 'No'}`, 'yellow');
    log(`SUPABASE_URL configured: ${process.env.SUPABASE_URL ? 'Yes' : 'No'}`, 'yellow');
    log(`SUPABASE_SERVICE_ROLE_KEY configured: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Yes' : 'No'}`, 'yellow');

    return false;
  }
}

// Dry run mode for testing
async function dryRun() {
  log('\n🧪 DRY RUN MODE', 'yellow');
  log('='.repeat(50), 'yellow');
  log('This will only show what would be migrated without actually migrating', 'yellow');

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: memories, error } = await supabase
      .from('ltm_memories')
      .select('key, org_id, user_id, kind, importance, created_at')
      .gte('importance', 3)
      .order('created_at', { ascending: true });

    if (error) {
      throw error;
    }

    log(`\n📊 Would migrate ${memories.length} memories`, 'cyan');

    // Show breakdown by kind
    const kindCounts = {};
    memories.forEach(m => {
      kindCounts[m.kind] = (kindCounts[m.kind] || 0) + 1;
    });

    log('\nBreakdown by kind:', 'blue');
    Object.entries(kindCounts).forEach(([kind, count]) => {
      log(`  - ${kind}: ${count}`, 'cyan');
    });

    // Show breakdown by importance
    const importanceCounts = {};
    memories.forEach(m => {
      importanceCounts[m.importance] = (importanceCounts[m.importance] || 0) + 1;
    });

    log('\nBreakdown by importance:', 'blue');
    Object.entries(importanceCounts)
      .sort(([a], [b]) => b - a)
      .forEach(([importance, count]) => {
        log(`  - Level ${importance}: ${count}`, 'cyan');
      });

    return true;

  } catch (error) {
    log(`\n❌ Dry run failed: ${error.message}`, 'red');
    return false;
  }
}

// Main execution
if (require.main === module) {
  console.log('\nMEMORY MIGRATION TO MEM0 CLOUD');
  console.log('================================\n');

  const isDryRun = process.argv.includes('--dry-run');

  if (isDryRun) {
    dryRun()
      .then(success => process.exit(success ? 0 : 1))
      .catch(err => {
        console.error('Unexpected error:', err);
        process.exit(1);
      });
  } else {
    console.log('This will migrate all memories with importance >= 3 to Mem0.');
    console.log('Use --dry-run flag to see what would be migrated without actually migrating.');
    console.log('Use --archive flag to mark migrated memories in the database.\n');

    // Add confirmation prompt
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Continue with migration? (yes/no): ', (answer) => {
      rl.close();

      if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
        migrateMemoriesToMem0()
          .then(success => process.exit(success ? 0 : 1))
          .catch(err => {
            console.error('Unexpected error:', err);
            process.exit(1);
          });
      } else {
        console.log('Migration cancelled.');
        process.exit(0);
      }
    });
  }
}

module.exports = { migrateMemoriesToMem0 };