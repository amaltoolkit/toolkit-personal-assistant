/**
 * Conversation Summarizer - Intelligent Conversation Compression
 *
 * Condenses messages beyond the 10-message window into structured summaries
 * while preserving critical information for pronoun resolution and context continuity.
 *
 * Key Features:
 * - Tracks people mentioned in order (for "first person", "second person" queries)
 * - Preserves exact names, dates, numbers, contact details
 * - Incremental updates as conversation grows
 * - Structured output for easy LLM consumption
 */

const { ChatOpenAI } = require("@langchain/openai");

class ConversationSummarizer {
  constructor() {
    this.llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
      temperature: 0,
      timeout: 15000  // 15 second timeout for summarization
    });

    // Summarization threshold - trigger when more than this many messages
    // Set to 6 so summarization activates early enough in 10-query tests
    this.SUMMARY_THRESHOLD = 6;

    // Maximum tokens for summary (keep it compact)
    this.MAX_SUMMARY_TOKENS = 500;
  }

  /**
   * Check if conversation needs summarization
   * @param {Array} messages - Conversation messages
   * @returns {boolean}
   */
  shouldSummarize(messages) {
    if (!messages || !Array.isArray(messages)) {
      return false;
    }
    return messages.length > this.SUMMARY_THRESHOLD;
  }

  /**
   * Summarize conversation messages into structured facts
   * @param {Array} messages - All conversation messages
   * @param {Object} existingSummary - Previous summary (for incremental updates)
   * @returns {Object} Structured summary with people_mentioned, key_facts, action_items
   */
  async summarize(messages, existingSummary = null) {
    if (!this.shouldSummarize(messages)) {
      console.log('[SUMMARIZER] Conversation too short for summarization');
      return null;
    }

    try {
      // Determine which messages to summarize
      const recentMessages = messages.slice(-10);  // Keep last 10 for Tier 1
      const olderMessages = messages.slice(0, -10);  // Summarize these

      // If we already have a summary and no new older messages, return existing
      if (existingSummary && olderMessages.length === 0) {
        console.log('[SUMMARIZER] No new messages to summarize');
        return existingSummary;
      }

      // Check if we need to update the summary (new messages added to older range)
      const lastSummarizedTurn = existingSummary?.summarized_turns?.split('-')[1];
      const newMessagesToSummarize = lastSummarizedTurn
        ? olderMessages.slice(parseInt(lastSummarizedTurn))
        : olderMessages;

      if (newMessagesToSummarize.length === 0 && existingSummary) {
        console.log('[SUMMARIZER] Summary is up to date');
        return existingSummary;
      }

      console.log(`[SUMMARIZER] Summarizing ${olderMessages.length} messages (turns 1-${olderMessages.length})`);

      // Build conversation history for LLM
      const conversationText = olderMessages.map((msg, idx) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        return `Turn ${idx + 1}. ${role}: ${msg.content}`;
      }).join('\n');

      // Create summarization prompt
      const prompt = `Analyze this conversation and extract structured information for context preservation.

IMPORTANT INSTRUCTIONS:
1. List ALL people mentioned in EXACT ORDER of first mention (include turn number)
2. Extract key facts preserving EXACT names, dates, numbers, contact details
3. Track action items, requests, and decisions
4. Keep summary under ${this.MAX_SUMMARY_TOKENS} tokens
5. Format as valid JSON

CONVERSATION HISTORY (older messages, before recent 10):
${conversationText}

${existingSummary ? `EXISTING SUMMARY (merge with new information):
${JSON.stringify(existingSummary, null, 2)}
` : ''}

Return ONLY valid JSON with this structure:
{
  "people_mentioned": [
    {
      "name": "Full Name",
      "first_mentioned_turn": number,
      "context": "brief context (e.g., 'working with', 'client', 'colleague')"
    }
  ],
  "key_facts": [
    "Bullet points of important information",
    "Preserve exact names, dates, numbers",
    "Include relationships and context"
  ],
  "action_items": [
    "Tasks or requests mentioned"
  ],
  "date_references": [
    {
      "date_string": "original text",
      "context": "what it refers to"
    }
  ]
}`;

      const response = await this.llm.invoke(prompt);
      let content = response.content;

      // Clean JSON response (remove markdown)
      if (content.includes('```json')) {
        content = content.split('```json')[1].split('```')[0].trim();
      } else if (content.includes('```')) {
        content = content.split('```')[1].split('```')[0].trim();
      }

      const summary = JSON.parse(content);

      // Add metadata
      summary.summary_created_at = new Date().toISOString();
      summary.summarized_turns = `1-${olderMessages.length}`;
      summary.total_messages = messages.length;

      console.log(`[SUMMARIZER] Created summary with ${summary.people_mentioned?.length || 0} people, ${summary.key_facts?.length || 0} facts`);
      console.log(`[SUMMARIZER] People in order: ${summary.people_mentioned?.map(p => p.name).join(', ') || 'none'}`);

      return summary;

    } catch (error) {
      console.error('[SUMMARIZER] Error creating summary:', error);
      console.error('[SUMMARIZER] Error details:', error.message);
      return existingSummary || null;  // Return existing summary on error
    }
  }

  /**
   * Build layered context for LLM prompts
   * Combines Tier 1 (recent messages) + Tier 2 (summary) + Tier 3 (entities)
   * @param {Array} recentMessages - Last 10 messages
   * @param {Object} summary - Conversation summary
   * @param {Object} entities - Entity context
   * @returns {string} Formatted layered context
   */
  buildLayeredContext(recentMessages, summary, entities) {
    const parts = [];

    parts.push('=== CONVERSATION CONTEXT (3 TIERS) ===\n');

    // TIER 1: Recent messages (last 10)
    parts.push('TIER 1 - RECENT MESSAGES (last 10 turns):');
    if (recentMessages && recentMessages.length > 0) {
      recentMessages.forEach((msg, idx) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        parts.push(`  ${idx + 1}. ${role}: ${msg.content}`);
      });
    } else {
      parts.push('  (no recent messages)');
    }
    parts.push('');

    // TIER 2: Conversation summary (older messages)
    if (summary && summary.people_mentioned) {
      parts.push(`TIER 2 - EARLIER CONTEXT (summary of turns ${summary.summarized_turns || '1-X'}):`);

      // People mentioned in order
      if (summary.people_mentioned.length > 0) {
        parts.push('People mentioned (in chronological order):');
        summary.people_mentioned.forEach((person, idx) => {
          parts.push(`  ${idx + 1}. ${person.name} (turn ${person.first_mentioned_turn}) - ${person.context || 'mentioned'}`);
        });
      }

      // Key facts
      if (summary.key_facts && summary.key_facts.length > 0) {
        parts.push('Key facts from earlier conversation:');
        summary.key_facts.forEach(fact => {
          parts.push(`  - ${fact}`);
        });
      }

      // Action items
      if (summary.action_items && summary.action_items.length > 0) {
        parts.push('Action items/requests:');
        summary.action_items.forEach(item => {
          parts.push(`  - ${item}`);
        });
      }

      parts.push('');
    } else {
      parts.push('TIER 2 - EARLIER CONTEXT: (none - conversation is short)');
      parts.push('');
    }

    // TIER 3: Current entities
    parts.push('TIER 3 - CURRENT ENTITIES:');

    if (entities?.last_contact) {
      const contactName = entities.last_contact.name || entities.last_contact.data?.name;
      parts.push(`LAST MENTIONED: ${contactName}`);
    }

    if (entities?.conversation_context?.data?.people_mentioned?.length > 0) {
      const peopleMentioned = entities.conversation_context.data.people_mentioned;
      parts.push(`ALL MENTIONED: ${peopleMentioned.join(', ')}`);
    }

    if (!entities?.last_contact && !entities?.conversation_context) {
      parts.push('(no entity context)');
    }

    parts.push('');
    parts.push('IMPORTANT: Use ALL 3 tiers to resolve pronouns and references!');
    parts.push('- "first person mentioned" = check Tier 2 chronological order');
    parts.push('- "both of them" / "they" = check all tiers for complete people list');
    parts.push('- "he/she/him/her" = check Tier 1 first (recent), then Tier 2 (earlier)');
    parts.push('');

    return parts.join('\n');
  }

  /**
   * Extract just the Tier 2 (summary) portion for agents that build their own Tier 1/3
   * @param {Object} summary - Conversation summary
   * @returns {string} Formatted summary section
   */
  buildSummarySection(summary) {
    if (!summary || !summary.people_mentioned) {
      return '\nTIER 2 - EARLIER CONTEXT: (none - conversation is short)\n';
    }

    const parts = [];
    parts.push(`\nTIER 2 - EARLIER CONTEXT (summary of turns ${summary.summarized_turns || '1-X'}):`);

    // People mentioned in order
    if (summary.people_mentioned.length > 0) {
      parts.push('People mentioned (in chronological order):');
      summary.people_mentioned.forEach((person, idx) => {
        parts.push(`  ${idx + 1}. ${person.name} (turn ${person.first_mentioned_turn}) - ${person.context || 'mentioned'}`);
      });
    }

    // Key facts
    if (summary.key_facts && summary.key_facts.length > 0) {
      parts.push('Key facts from earlier conversation:');
      summary.key_facts.forEach(fact => {
        parts.push(`  - ${fact}`);
      });
    }

    // Action items
    if (summary.action_items && summary.action_items.length > 0) {
      parts.push('Action items/requests:');
      summary.action_items.forEach(item => {
        parts.push(`  - ${item}`);
      });
    }

    parts.push('');
    return parts.join('\n');
  }
}

// Singleton instance
let summarizerInstance = null;

function getConversationSummarizer() {
  if (!summarizerInstance) {
    summarizerInstance = new ConversationSummarizer();
  }
  return summarizerInstance;
}

module.exports = {
  ConversationSummarizer,
  getConversationSummarizer
};
