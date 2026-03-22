CREATE TABLE IF NOT EXISTS user_reminders (
    reminder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    time_text TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'scheduled', 'sent', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_reminders_user_status
    ON user_reminders(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_reminders_scheduled
    ON user_reminders(scheduled_for)
    WHERE status IN ('pending', 'scheduled');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'update_user_reminders_updated_at'
    ) THEN
        EXECUTE $trig$
            CREATE TRIGGER update_user_reminders_updated_at
                BEFORE UPDATE ON user_reminders
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column()
        $trig$;
    END IF;
END $$;
