-- Enhanced Memories Migration — Stateful Persona Architecture
--
-- Adds columns to the memories table for composite scoring (importance, access
-- tracking) and creates two new supporting tables:
--   session_summaries — compressed per-session context
--   tool_interactions — per-turn tool result cache for reflection pipeline
--
-- Safe to run on an existing DB: all statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
--
-- @see ARCHITECTURE.md — Memory Reliability section

-- ─── 1. Extend memories table ────────────────────────────────────────────────

ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS memory_type    VARCHAR(40)   DEFAULT 'fact',
    ADD COLUMN IF NOT EXISTS importance     DECIMAL(3,2)  DEFAULT 0.50,
    ADD COLUMN IF NOT EXISTS last_accessed  TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS access_count   INTEGER       DEFAULT 0,
    ADD COLUMN IF NOT EXISTS source_turn    INTEGER;

-- Valid memory types
ALTER TABLE memories
    DROP CONSTRAINT IF EXISTS valid_memory_type;

ALTER TABLE memories
    ADD CONSTRAINT valid_memory_type
    CHECK (memory_type IN ('fact', 'preference', 'commitment', 'experience', 'relationship'));

-- Importance range guard
ALTER TABLE memories
    DROP CONSTRAINT IF EXISTS valid_importance;

ALTER TABLE memories
    ADD CONSTRAINT valid_importance
    CHECK (importance >= 0.00 AND importance <= 1.00);

-- Index on importance + last_accessed for composite scoring queries
CREATE INDEX IF NOT EXISTS idx_memories_importance       ON memories (importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed    ON memories (last_accessed DESC NULLS LAST);

-- ─── 2. session_summaries table ──────────────────────────────────────────────
-- Compressed summaries written at the end of each session, used to seed
-- working memory on reconnect instead of replaying full message history.

CREATE TABLE IF NOT EXISTS session_summaries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    session_id  UUID NOT NULL,
    summary     TEXT NOT NULL,
    key_facts   JSONB DEFAULT '[]'::jsonb,
    mood        VARCHAR(20) DEFAULT 'neutral',
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_user_session
    ON session_summaries (user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_session_summaries_created_at
    ON session_summaries (created_at DESC);

-- ─── 3. tool_interactions table ──────────────────────────────────────────────
-- Stores the reflection result for each tool execution so the UI/admin can audit
-- and the background worker can update memory importance from tool outcomes.

CREATE TABLE IF NOT EXISTS tool_interactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    session_id      UUID,
    tool_name       VARCHAR(100) NOT NULL,
    raw_output      JSONB,
    reflection      JSONB,          -- ReflectionResult JSON
    answers_query   BOOLEAN,
    data_quality    VARCHAR(10),    -- 'good' | 'partial' | 'poor'
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_interactions_user_id
    ON tool_interactions (user_id);
CREATE INDEX IF NOT EXISTS idx_tool_interactions_tool_name
    ON tool_interactions (tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_interactions_created_at
    ON tool_interactions (created_at DESC);

-- ─── 4. memory_write_queue table ─────────────────────────────────────────────
-- Instead of fire-and-forget setImmediate, handler enqueues write jobs here.
-- A background worker (or cron) processes them with retry semantics.

CREATE TABLE IF NOT EXISTS memory_write_queue (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    job_type    VARCHAR(40) NOT NULL,   -- 'vector', 'graph', 'preference', 'goal'
    payload     JSONB NOT NULL,
    attempts    INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    status      VARCHAR(20) DEFAULT 'pending',  -- 'pending' | 'processing' | 'done' | 'failed'
    error       TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT valid_job_type   CHECK (job_type IN ('vector', 'graph', 'preference', 'goal')),
    CONSTRAINT valid_status     CHECK (status   IN ('pending', 'processing', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_memory_write_queue_status
    ON memory_write_queue (status, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_write_queue_user_id
    ON memory_write_queue (user_id);
