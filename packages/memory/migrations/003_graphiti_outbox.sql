-- Up Migration
-- Outbox の消費者（Graphiti への反映。docs/design/memory-graphiti.md）用の列。
-- 状態: 待ち（sent_at / processed_at / failed_at が全て NULL）→ 送信済み（sent_at のみ。Graphiti の queue に受理された）
--       → 反映済み（processed_at。Graphiti に episode が現れたのを確認した）。失敗が上限に達したら failed_at（dead-letter）。
-- 全て IF NOT EXISTS・既定値は NULL（表の書き換え無し。溜まった Outbox の行はそのまま「待ち」になる）。
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS episode_uuid text;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS failed_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error text;

-- 消費者が引く「未反映の行」を id 順に取るための部分 index。反映済み・dead-letter は含めない
CREATE INDEX IF NOT EXISTS outbox_events_pending ON outbox_events (agent_id, id) WHERE processed_at IS NULL AND failed_at IS NULL;
-- recall が Graphiti の fact の出典 episode から Outbox の行（= event / item）を引く
CREATE INDEX IF NOT EXISTS outbox_events_episode ON outbox_events (agent_id, episode_uuid) WHERE episode_uuid IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS outbox_events_episode;
DROP INDEX IF EXISTS outbox_events_pending;
ALTER TABLE outbox_events DROP COLUMN IF EXISTS last_error, DROP COLUMN IF EXISTS failed_at, DROP COLUMN IF EXISTS next_attempt_at, DROP COLUMN IF EXISTS sent_at, DROP COLUMN IF EXISTS episode_uuid;
