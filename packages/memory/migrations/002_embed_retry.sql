-- Up Migration
-- 埋め込みの失敗管理と、最後に成功した時刻。
-- 失敗した item は embed_attempts / embed_failed_at を持ち、間隔を空けて後回しにする（列の先頭を塞がない）。
-- 設置済みの DB にそのまま当てられる: 列の追加は定数の既定値だけ（表の書き換え無し）で、既存の行・旧版の code に影響しない。
-- 権限: memory_app は memory_items に表単位の SELECT / INSERT / UPDATE を持つので、足した列にも効く（GRANT の追加は不要）。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embedded_at timestamptz;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embed_failed_at timestamptz;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embed_error text;
-- 既に埋め込み済みの行は、最後の更新時刻を埋め込み時刻の近似として入れる（状態の口の lastEmbeddedAt 用。何度流しても同じ結果）
UPDATE memory_items SET embedded_at = updated_at WHERE embedding IS NOT NULL AND embedded_at IS NULL;
-- 埋め込み待ちを新しい順に取る（待ちが無くなれば空になる部分 index）
CREATE INDEX IF NOT EXISTS memory_items_embed_pending ON memory_items (agent_id, created_at DESC) WHERE embedding IS NULL;

-- Down Migration
DROP INDEX IF EXISTS memory_items_embed_pending;
ALTER TABLE memory_items DROP COLUMN IF EXISTS embed_error;
ALTER TABLE memory_items DROP COLUMN IF EXISTS embed_failed_at;
ALTER TABLE memory_items DROP COLUMN IF EXISTS embed_attempts;
ALTER TABLE memory_items DROP COLUMN IF EXISTS embedded_at;
