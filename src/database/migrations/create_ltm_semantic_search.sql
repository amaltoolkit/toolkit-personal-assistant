-- Create the ltm_semantic_search function for vector similarity search
-- This function is required by the PgMemoryStore adapter for semantic memory retrieval

-- First ensure the ltm_memories table exists with proper structure
CREATE TABLE IF NOT EXISTS ltm_memories (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  namespace TEXT[] NOT NULL,
  kind TEXT DEFAULT 'fact',
  subject_id TEXT,
  text TEXT NOT NULL,
  importance INTEGER DEFAULT 3 CHECK (importance >= 1 AND importance <= 5),
  ttl_days INTEGER,
  embedding vector(1536), -- OpenAI text-embedding-3-small produces 1536 dimensions
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ GENERATED ALWAYS AS (
    CASE 
      WHEN ttl_days IS NOT NULL THEN created_at + (ttl_days || ' days')::INTERVAL
      ELSE NULL
    END
  ) STORED
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ltm_memories_org_user ON ltm_memories(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ltm_memories_namespace ON ltm_memories USING GIN(namespace);
CREATE INDEX IF NOT EXISTS idx_ltm_memories_kind ON ltm_memories(kind);
CREATE INDEX IF NOT EXISTS idx_ltm_memories_expires ON ltm_memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_ltm_memories_importance ON ltm_memories(importance);

-- Create vector index for similarity search (requires pgvector extension)
CREATE INDEX IF NOT EXISTS idx_ltm_memories_embedding ON ltm_memories 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create the semantic search function
CREATE OR REPLACE FUNCTION ltm_semantic_search(
  ns_prefix TEXT[],
  query_vec vector(1536),
  match_count INT DEFAULT 5,
  min_importance INT DEFAULT 1
)
RETURNS TABLE (
  key TEXT,
  namespace TEXT[],
  text TEXT,
  kind TEXT,
  subject_id TEXT,
  importance INT,
  score FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.key,
    m.namespace,
    m.text,
    m.kind,
    m.subject_id,
    m.importance,
    -- Cosine similarity score (1 - cosine distance)
    1 - (m.embedding <=> query_vec) AS score
  FROM ltm_memories m
  WHERE 
    -- Check namespace prefix match
    m.namespace[1:array_length(ns_prefix, 1)] = ns_prefix
    -- Filter by minimum importance
    AND m.importance >= min_importance
    -- Exclude expired memories
    AND (m.expires_at IS NULL OR m.expires_at > NOW())
    -- Only include memories with embeddings
    AND m.embedding IS NOT NULL
  ORDER BY 
    -- Sort by similarity score (higher is better)
    m.embedding <=> query_vec ASC,
    -- Secondary sort by importance
    m.importance DESC
  LIMIT match_count;
END;
$$;

-- Create function to purge expired memories (can be called periodically)
CREATE OR REPLACE FUNCTION purge_expired_memories()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM ltm_memories
  WHERE expires_at IS NOT NULL AND expires_at < NOW();
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$;

-- Grant necessary permissions (adjust based on your user setup)
-- GRANT ALL ON ltm_memories TO authenticated;
-- GRANT EXECUTE ON FUNCTION ltm_semantic_search TO authenticated;
-- GRANT EXECUTE ON FUNCTION purge_expired_memories TO authenticated;

COMMENT ON TABLE ltm_memories IS 'Long-term memory storage with vector embeddings for semantic search';
COMMENT ON FUNCTION ltm_semantic_search IS 'Performs semantic similarity search on memories using vector embeddings';
COMMENT ON FUNCTION purge_expired_memories IS 'Removes expired memories based on TTL settings';