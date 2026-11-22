-- Up Migration
-- 作業指示（requirement）と仕様・設計（spec_design）の型。設計: docs/design/memory-requirement-spec.md（決定 #1〜#12）。
-- 設置済みの DB にそのまま当てられる: 足す列は全て NULL 可（既存の行は record_type = NULL = 従来の記憶のまま）。
-- 権限: memory_app は memory_items に表単位の SELECT / INSERT / UPDATE を持つので、足した列にも効く。
--       新しい表 memory_relations には、この migration の末尾で memory_app の SELECT / INSERT / UPDATE を付ける（role が在る時だけ。DELETE は付けない）。
--       README の手順（GRANT ... ON ALL TABLES IN SCHEMA public）を当て直しても同じ。
-- 何度当てても同じ: ADD CONSTRAINT / CREATE POLICY は先に DROP ... IF EXISTS する。

-- #1 B: 新しい列 record_type（NULL = 従来の記憶）。memory_type は残す。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS record_type text CHECK (record_type IS NULL OR record_type IN ('requirement','spec_design'));
-- #5 A: 起点。user = 利用者の発言由来 / agent = エージェントが出した物。status（根拠の強さ）とは別の項目。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS origin text CHECK (origin IS NULL OR origin IN ('user','agent'));
-- #7: タスクは requirement の子で、role で区別する（requirement のみ）。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS role text CHECK (role IS NULL OR role IN ('requirement','task'));
-- #2 A: requirement の作業の種類。文字列で、CHECK で固定しない（候補: setup / maintenance / feature / fix / investigation / docs / other）。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS category text;
-- #4 A: 仕様・設計の category は複数可。値は 5 つに確定している。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS spec_categories text[]
  CHECK (spec_categories IS NULL OR spec_categories <@ ARRAY['presentation','business','data','infrastructure','cross-cutting']::text[]);
-- #3: 仕様・設計の「種類」は 2 値。user = 利用者由来 / agent = エージェントの推論・判断由来（推論と判断は分けない）。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS basis text CHECK (basis IS NULL OR basis IN ('user','agent'));
-- #7: 木は parent_id（同じ record_type の中）。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES memory_items(id);
-- center が採番した remote_send の task_id（master-cap が remote-cap に出した requirement のみ）。
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS task_id text;
-- 型ごとに使う列の規則: requirement だけ origin / role / category / task_id、spec_design だけ basis / spec_categories。
ALTER TABLE memory_items DROP CONSTRAINT IF EXISTS memory_items_record_shape;
ALTER TABLE memory_items ADD CONSTRAINT memory_items_record_shape CHECK (
  (record_type IS NULL AND origin IS NULL AND role IS NULL AND category IS NULL AND spec_categories IS NULL AND basis IS NULL AND parent_id IS NULL AND task_id IS NULL)
  OR (record_type = 'requirement' AND origin IS NOT NULL AND role IS NOT NULL AND basis IS NULL AND spec_categories IS NULL)
  OR (record_type = 'spec_design' AND basis IS NOT NULL AND role IS NULL AND category IS NULL AND origin IS NULL AND task_id IS NULL)
);
CREATE INDEX IF NOT EXISTS memory_items_parent ON memory_items (agent_id, parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_items_record ON memory_items (agent_id, record_type, created_at) WHERE record_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_items_task ON memory_items (agent_id, task_id) WHERE task_id IS NOT NULL;

-- #12 A: 同文の畳み込みは record_type と親も含める（同じ依頼を別の親の下に出せる）。content の上限は仕様・設計だけ 8000 文字。
-- 従来の記憶（record_type = NULL・親なし）は、これまでと同じ (agent_id, memory_type, content_norm) で畳まれる。
DROP INDEX IF EXISTS memory_items_dedup;
CREATE UNIQUE INDEX memory_items_dedup ON memory_items (agent_id, memory_type, COALESCE(record_type, ''), COALESCE(parent_id::text, ''), content_norm) WHERE status <> 'superseded';
ALTER TABLE memory_items DROP CONSTRAINT IF EXISTS memory_items_content_check;
ALTER TABLE memory_items DROP CONSTRAINT IF EXISTS memory_items_content_len;
ALTER TABLE memory_items ADD CONSTRAINT memory_items_content_len CHECK (char_length(content) >= 1 AND char_length(content) <= CASE WHEN record_type = 'spec_design' THEN 8000 ELSE 2000 END);

-- #6 A: remote_send に渡された親の requirement の id（memory_items.id）。task event だけに付く（任意）。
ALTER TABLE memory_events ADD COLUMN IF NOT EXISTS parent_requirement_id text CHECK (parent_requirement_id IS NULL OR char_length(parent_requirement_id) BETWEEN 1 AND 128);

-- #7: requirement ↔ 仕様・設計の紐付け（親子ではない相互関係。多対多）。from = requirement、to = 仕様・設計。
CREATE TABLE IF NOT EXISTS memory_relations (
  agent_id text NOT NULL REFERENCES agents(id),
  from_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation text NOT NULL DEFAULT 'has_spec' CHECK (char_length(relation) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS memory_relations_to ON memory_relations (agent_id, to_id);
ALTER TABLE memory_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_relations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON memory_relations;
CREATE POLICY own_rows ON memory_relations USING (agent_id = current_setting('app.agent_id', true)) WITH CHECK (agent_id = current_setting('app.agent_id', true));
-- memory_app が在れば、新しい表に権限を付ける（README の GRANT の当て直しが要らない。DELETE は付けない）。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_app') THEN
    GRANT SELECT, INSERT, UPDATE ON memory_relations TO memory_app;
  END IF;
END $$;

-- Down Migration
DROP TABLE IF EXISTS memory_relations;
ALTER TABLE memory_events DROP COLUMN IF EXISTS parent_requirement_id;
ALTER TABLE memory_items DROP CONSTRAINT IF EXISTS memory_items_content_len;
ALTER TABLE memory_items ADD CONSTRAINT memory_items_content_check CHECK (char_length(content) BETWEEN 1 AND 2000);
DROP INDEX IF EXISTS memory_items_dedup;
CREATE UNIQUE INDEX memory_items_dedup ON memory_items (agent_id, memory_type, content_norm) WHERE status <> 'superseded';
DROP INDEX IF EXISTS memory_items_task;
DROP INDEX IF EXISTS memory_items_record;
DROP INDEX IF EXISTS memory_items_parent;
ALTER TABLE memory_items DROP CONSTRAINT IF EXISTS memory_items_record_shape;
ALTER TABLE memory_items DROP COLUMN IF EXISTS task_id, DROP COLUMN IF EXISTS parent_id, DROP COLUMN IF EXISTS basis, DROP COLUMN IF EXISTS spec_categories, DROP COLUMN IF EXISTS category, DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS origin, DROP COLUMN IF EXISTS record_type;
