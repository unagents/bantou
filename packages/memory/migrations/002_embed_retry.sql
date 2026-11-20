-- Up Migration
-- 埋め込みの失敗管理と、最後に成功した時刻。
-- 失敗した item は embed_attempts / embed_failed_at を持ち、間隔を空けて後回しにする（列の先頭を塞がない）。
-- 設置済みの DB にそのまま当てられる: 列の追加は定数の既定値だけ（表の書き換え無し）で、既存の行・旧版の code に影響しない。
-- 権限: memory_app は memory_items に表単位の SELECT / INSERT / UPDATE を持つので、足した列にも効く（GRANT の追加は不要）。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embedded_at timestamptz;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embed_failed_at timestamptz;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embed_error text;
-- 既に埋め込み済みの行は、最後の更新時刻を埋め込み時刻の近似として入れる（状態の口の lastEmbeddedAt 用。何度流しても同じ結果）。
-- memory_items は FORCE ROW LEVEL SECURITY なので、owner が superuser でないと、素の UPDATE は policy（agent_id = app.agent_id）に
-- 当たらず黙って 0 行になる。agent ごとに app.agent_id を設定して更新する（superuser の owner でも同じ結果。agents に RLS は無い）。
-- この UPDATE が 0 行でも害は無い: 埋め込みの消化・recall には影響せず、status の lastEmbeddedAt が次の埋め込みまで null になるだけ。
DO $$
DECLARE a text;
BEGIN
  FOR a IN SELECT id FROM agents LOOP
    PERFORM set_config('app.agent_id', a, true);
    UPDATE memory_items SET embedded_at = updated_at WHERE agent_id = a AND embedding IS NOT NULL AND embedded_at IS NULL;
  END LOOP;
  PERFORM set_config('app.agent_id', '', true);
END $$;
-- index は足さない: 埋め込み待ちの条件（embedding IS NULL OR embed_model が違う）と並び（枠ごとに変わる）に合う部分 index を作れず、
-- 待ちの行は少数で agent_id の絞り込みで足りる。

-- Down Migration
ALTER TABLE memory_items DROP COLUMN IF EXISTS embed_error;
ALTER TABLE memory_items DROP COLUMN IF EXISTS embed_failed_at;
ALTER TABLE memory_items DROP COLUMN IF EXISTS embed_attempts;
ALTER TABLE memory_items DROP COLUMN IF EXISTS embedded_at;
