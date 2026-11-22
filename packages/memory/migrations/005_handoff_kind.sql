-- Up Migration
-- リセッションの引継ぎ（docs/design/resession.md の 3.2 / 7 節）を event の種別 `handoff` として受ける。
-- memory_events.kind の CHECK に 'handoff' を足すだけ（列・データは変えない）。
ALTER TABLE memory_events DROP CONSTRAINT IF EXISTS memory_events_kind_check;
ALTER TABLE memory_events ADD CONSTRAINT memory_events_kind_check
  CHECK (kind IN ('user_prompt','assistant_message','task','result','report','reply','handoff'));

-- Down Migration
-- 'handoff' の行は元の CHECK に合わないので先に消す（引継ぎは 1 回使う物で、素材として残す用途は無い）
DELETE FROM memory_events WHERE kind = 'handoff';
ALTER TABLE memory_events DROP CONSTRAINT IF EXISTS memory_events_kind_check;
ALTER TABLE memory_events ADD CONSTRAINT memory_events_kind_check
  CHECK (kind IN ('user_prompt','assistant_message','task','result','report','reply'));
