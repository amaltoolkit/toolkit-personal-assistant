/**
 * Shared Disambiguator for Users and Contacts
 *
 * Scoring algorithm: 40% name similarity + 30% role/company + 30% recent interactions
 */

const { NeedsClarification } = require('./errors');

class Disambiguator {
  /**
   * Score candidates using unified algorithm
   * @param {Array} candidates - Array of user/contact candidates
   * @param {Object} context - { query, memory, type }
   * @returns {Array} Scored and sorted candidates
   */
  score(candidates, context) {
    const { query, memory = {}, type = 'person' } = context;

    return candidates.map(candidate => {
      let score = 0;
      let lastInteraction = null;

      // 1. Name similarity (40%)
      const nameSimilarity = this.calculateNameSimilarity(query, candidate.name);
      score += nameSimilarity * 40;

      // 2. Role/Company match from memory context (30%)
      if (memory.role && candidate.title) {
        const roleMatch = this._fuzzyMatch(memory.role, candidate.title);
        score += roleMatch * 15;
      }
      if (memory.company && candidate.company) {
        const companyMatch = this._fuzzyMatch(memory.company, candidate.company);
        score += companyMatch * 15;
      }

      // 3. Recent interactions from memory (30%)
      if (memory.recalled_memories && memory.recalled_memories.length > 0) {
        const nameLower = candidate.name?.toLowerCase();

        for (const memoryEntry of memory.recalled_memories) {
          if (memoryEntry.content?.toLowerCase().includes(nameLower)) {
            // Found in memory - boost score based on relevance
            score += memoryEntry.relevance ? memoryEntry.relevance * 30 : 15;

            // Track most recent interaction
            if (memoryEntry.metadata?.timestamp) {
              const memDate = new Date(memoryEntry.metadata.timestamp);
              if (!lastInteraction || memDate > lastInteraction) {
                lastInteraction = memDate;
              }
            }
            break; // Only count once
          }
        }
      }

      // Format last interaction for display
      if (lastInteraction) {
        const daysAgo = Math.floor((Date.now() - lastInteraction) / (1000 * 60 * 60 * 24));
        candidate.lastInteraction = daysAgo === 0 ? 'Today' :
                                     daysAgo === 1 ? 'Yesterday' :
                                     `${daysAgo} days ago`;
      }

      return { ...candidate, score };
    }).sort((a, b) => b.score - a.score);
  }

  /**
   * Auto-select if score is clear, else throw NeedsClarification
   * @param {Array} candidates - Array of candidates
   * @param {Object} context - { query, memory, type }
   * @returns {Object} Selected candidate
   * @throws {NeedsClarification} If disambiguation needed
   */
  autoSelect(candidates, context) {
    if (candidates.length === 0) {
      throw new Error('No candidates provided');
    }

    if (candidates.length === 1) {
      console.log(`[DISAMBIGUATOR] Single match: ${candidates[0].name}`);
      return candidates[0];
    }

    // Score all candidates
    const scored = this.score(candidates, context);

    // Auto-select if top score is 2x better than second
    const [first, second] = scored;
    if (first.score >= second.score * 2) {
      console.log(`[DISAMBIGUATOR] Auto-selected: ${first.name} (score: ${first.score} vs ${second.score})`);
      return first;
    }

    // Need user to disambiguate
    console.log(`[DISAMBIGUATOR] Multiple candidates require user selection`);
    console.log(`[DISAMBIGUATOR] Top scores: ${scored.map(c => `${c.name}: ${c.score}`).slice(0, 3).join(', ')}`);

    throw new NeedsClarification(
      scored.slice(0, 5), // Top 5 candidates
      context.query,
      context.type,
      context
    );
  }

  /**
   * Calculate name similarity score (0-1)
   * Uses word matching and partial matching
   */
  calculateNameSimilarity(query, name) {
    if (!query || !name) return 0;

    const queryLower = query.toLowerCase();
    const nameLower = name.toLowerCase();

    // Exact match
    if (queryLower === nameLower) return 1.0;

    // Contains full name
    if (queryLower.includes(nameLower) || nameLower.includes(queryLower)) return 0.9;

    // Check individual words
    const queryWords = queryLower.split(/\s+/);
    const nameWords = nameLower.split(/\s+/);

    let matchedWords = 0;
    for (const qWord of queryWords) {
      for (const nWord of nameWords) {
        if (qWord === nWord) {
          matchedWords++;
          break;
        }
        // Partial match (e.g., "john" matches "johnson")
        if (qWord.length > 2 && nWord.includes(qWord)) {
          matchedWords += 0.5;
          break;
        }
      }
    }

    return Math.min(1.0, matchedWords / Math.max(queryWords.length, nameWords.length));
  }

  /**
   * Fuzzy match two strings (internal helper)
   */
  _fuzzyMatch(str1, str2) {
    return this.calculateNameSimilarity(str1, str2);
  }
}

// Singleton instance
let instance = null;

function getDisambiguator() {
  if (!instance) {
    instance = new Disambiguator();
  }
  return instance;
}

module.exports = {
  Disambiguator,
  getDisambiguator
};
