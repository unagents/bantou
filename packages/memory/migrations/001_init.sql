-- Up Migration
-- memory Phase 1 の最小スキーマ（docs/design/memory-design.md §6 の一部）。
-- 埋め込みの次元は vector(768)（既定 model nomic-embed-text）。model を変えて次元が変わる時は新しい migration を足す。
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE agents (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 原イベント。冪等キーは (agent_id, event_id)。
CREATE TABLE memory_events (
  agent_id text NOT NULL REFERENCES agents(id),
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  sender_session text, sender_cap_id text, sender_worker_id text,
  recipient_session text, recipient_cap_id text, recipient_worker_id text,
  remote_id text,
  task_id text,
  kind text NOT NULL CHECK (kind IN ('user_prompt','assistant_message','task','result','report','reply')),
  body text NOT NULL CHECK (char_length(body) <= 65536),
  at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  -- 抽出の排他（lease）と失敗管理。attempts が上限に達した event は failed_at を立てて処理対象から外す（dead-letter）
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  failed_at timestamptz,
  last_error text,
  PRIMARY KEY (agent_id, event_id)
);
CREATE INDEX memory_events_unprocessed ON memory_events (agent_id, at) WHERE processed_at IS NULL AND failed_at IS NULL;
CREATE INDEX memory_events_task ON memory_events (agent_id, task_id, at);

-- 記憶本体。agent_id は所有 agent（設計書の ownerAgentId）。
CREATE TABLE memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id),
  scope text NOT NULL DEFAULT 'agent_private' CHECK (scope IN ('agent_private','shared','organizational')),
  project_id text REFERENCES projects(id),
  memory_type text NOT NULL CHECK (memory_type IN ('identity','semantic','episodic','relational','procedural')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  content_norm text NOT NULL,
  status text NOT NULL CHECK (status IN ('candidate','verified','confirmed','inferred','rejected','superseded')),
  confidence real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  valid_from timestamptz,
  valid_until timestamptz,
  superseded_by uuid REFERENCES memory_items(id),
  embedding vector(768),
  embed_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memory_items_dedup ON memory_items (agent_id, memory_type, content_norm) WHERE status <> 'superseded';
CREATE INDEX memory_items_embedding ON memory_items USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memory_items_owner ON memory_items (agent_id, status);

CREATE TABLE memory_sources (
  item_id uuid NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY (item_id, event_id),
  FOREIGN KEY (agent_id, event_id) REFERENCES memory_events(agent_id, event_id)
);

-- LLM の抽出候補と検証結果の記録
CREATE TABLE memory_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id),
  memory_type text,
  content text,
  llm_status text,
  source_event_ids text[] NOT NULL DEFAULT '{}',
  valid_from timestamptz,
  decision text NOT NULL CHECK (decision IN ('accepted','rejected')),
  final_status text,
  reason text,
  item_id uuid REFERENCES memory_items(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Graphiti 同期用（Phase 1 は積むだけ）。idempotency_key で重複登録を防ぐ。
CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  topic text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  UNIQUE (agent_id, topic, idempotency_key)
);

-- エージェント間通信（§13）。Phase 1 は表のみ（書き込みは Phase 2 以降）。
CREATE TABLE agent_messages (
  agent_id text NOT NULL REFERENCES agents(id),
  message_id text NOT NULL,
  correlation_id text,
  task_id text,
  sender text,
  recipient text,
  message_type text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, message_id)
);

-- Row Level Security: 接続 role は非 superuser にすること（superuser は RLS を無視する）。
-- 各 transaction で set_config('app.agent_id', <認証済み agent>, true) を設定する。
ALTER TABLE memory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_events FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON memory_events USING (agent_id = current_setting('app.agent_id', true)) WITH CHECK (agent_id = current_setting('app.agent_id', true));

ALTER TABLE memory_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON memory_sources USING (agent_id = current_setting('app.agent_id', true)) WITH CHECK (agent_id = current_setting('app.agent_id', true));

ALTER TABLE memory_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON memory_candidates USING (agent_id = current_setting('app.agent_id', true)) WITH CHECK (agent_id = current_setting('app.agent_id', true));

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON outbox_events USING (agent_id = current_setting('app.agent_id', true)) WITH CHECK (agent_id = current_setting('app.agent_id', true));

ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON agent_messages USING (agent_id = current_setting('app.agent_id', true)) WITH CHECK (agent_id = current_setting('app.agent_id', true));

-- memory_items: 自分の private + shared / organizational は読める。書くのは自分の行だけ。
ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_items FORCE ROW LEVEL SECURITY;
CREATE POLICY read_visible ON memory_items FOR SELECT USING (
  agent_id = current_setting('app.agent_id', true) OR scope IN ('shared','organizational')
);
CREATE POLICY write_own ON memory_items FOR INSERT WITH CHECK (agent_id = current_setting('app.agent_id', true));
CREATE POLICY update_own ON memory_items FOR UPDATE USING (agent_id = current_setting('app.agent_id', true)) WITH CHECK (agent_id = current_setting('app.agent_id', true));

-- Down Migration
DROP TABLE agent_messages, outbox_events, memory_candidates, memory_sources, memory_items, memory_events, projects, agents;
