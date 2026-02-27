-- Persona Opinions Table — Stateful Persona Architecture
--
-- Stores opinions that Aria has formed about specific topics for a given user.
-- Used to inject continuity context ("Last time you found Zomato slow…") into
-- the system prompt via formatOpinionsForPrompt().
--
-- @see src/persona-opinions.ts
-- @see ARCHITECTURE.md — Persona Opinions section

CREATE TABLE IF NOT EXISTS persona_opinions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    topic       VARCHAR(120) NOT NULL,   -- e.g. 'airlines', 'budget_sensitivity', 'zomato'
    opinion     TEXT         NOT NULL,   -- e.g. 'Prefers IndiGo over SpiceJet'
    context     TEXT,                    -- optional: source message snippet

    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- One opinion per (user, topic) — upserted on each new signal
    UNIQUE (user_id, topic)
);

-- Fast lookup by user
CREATE INDEX IF NOT EXISTS idx_persona_opinions_user_id
    ON persona_opinions (user_id, updated_at DESC);

-- Auto-update updated_at (reuses function defined in schema.sql)
CREATE TRIGGER update_persona_opinions_updated_at
    BEFORE UPDATE ON persona_opinions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
