# 横断PMエージェント向け Persistent Memory 基盤 実装指示書

（利用者が 2026-11-11 に示した原文。bantou 側の接続と `packages/memory` の実装方針は `external-memory.md`。本書の Python / FastAPI / LangGraph の記述は `external-memory.md` の決定（TypeScript、Nuxt 4 + `@nuxtjs/mcp-toolkit`、抽出は chatp 経由の `claude -p`、Graphiti は Python サービスのまま、session 制御は別設計）で読み替える。）

## 1. 開発目的

複数のAIエージェントが協調して複数のプロジェクトを開発するシステムにおいて、横断PMエージェントが長期間にわたり一貫した認識・判断・ユーザーとの関係を維持するための永続化メモリ基盤を構築する。

本システムは一般的なドキュメント検索用RAGではなく、LLMエージェントの長期記憶（Persistent Agent Memory）を目的とする。

採用する設計思想はハイブリッド型とする。

- LLMが記憶すべき情報を判断する。
- システムが保存・検証・更新・検索を管理する。
- 正式な事実と推測を明確に区別する。
- 記憶の更新と正式な意思決定の変更を分離する。
- 複数の横断PMエージェントによるメモリ共有を将来的にサポートする。

## 2. エージェントの責務

### 2.1 横断PM

複数プロジェクトを横断的に管理し、ユーザーとの主要な窓口となるAIエージェント。

主な責務：

- ユーザーとの対話
- ユーザーの要求・方針・判断基準の維持
- 複数プロジェクトの状況把握
- プロジェクト間の整合性確認
- 個別PMへの指示・照会
- 個別PMからの成果物・分析結果の評価
- ユーザーへの判断材料の提示
- 委譲された権限範囲内での指揮・調整
- 過去の経験・判断の再利用

### 2.2 個別PM

特定プロジェクトの管理に特化したAIエージェント。

主な責務：

- 要求分析
- 技術調査
- システム設計
- 実装計画
- 実装状況の管理
- 技術的問題の分析
- 成果物の作成
- 指示された作業の実行・報告

個別PMは技術的な問題の分析や解決候補の提示は行うが、自発的にプロジェクトの目標・方針・優先順位を変更する権限は持たない。

### 2.3 今回の開発対象

今回実装するのは横断PM向けの永続化メモリ基盤である。

個別PMの内部実装状況や全ファイル情報を横断PMのメモリに複製することは目的としない。

個別PMとの指示・応答・成果物・技術的知見を、横断管理に必要な粒度で記憶する。

---

## 3. 全体アーキテクチャ

以下の構成を採用する。

| コンポーネント | 技術 | 役割 |
|---|---|---|
| Agent Runtime | LangGraph（条件付き） | 実行制御・状態永続化 |
| Memory API | Python / FastAPI | メモリ操作の統括 |
| Graph Memory | Graphiti | 時間軸・関係性・エピソード管理 |
| Graph DB | Neo4j | Graphitiのストレージ |
| RDB | PostgreSQL | 正式データ・イベント・権限管理 |
| Vector Search | pgvector | 必要に応じた意味検索 |
| Background Worker | Python Worker | 非同期処理・記憶整理 |
| Event Delivery | Transactional Outbox | DB間の確実なイベント反映 |

### 3.1 アーキテクチャ原則

1. PostgreSQLを正式情報のSystem of Recordとする。
2. Graphitiを知識・関係性・時間軸の検索エンジンとする。
3. GraphitiはPostgreSQLの代替にしない。
4. LLMからDBへの直接アクセスを禁止する。
5. すべてのメモリ操作をMemory API経由とする。
6. LLMによる記憶候補の抽出と、システムによる正式登録を分離する。
7. PostgreSQLとGraphitiの書き込みは非同期同期方式とする。
8. Graphitiの障害が発生しても、正式イベントの記録を失わない。

---

## 4. メモリの分類

メモリは以下の5種類に分類する。

| 種類 | 内容 |
|---|---|
| Identity Memory | エージェントの役割・責務・権限・行動原則 |
| Semantic Memory | ユーザー方針・プロジェクト基本情報・確定事実 |
| Episodic Memory | 過去の会話・指示・応答・経験 |
| Relational Memory | ユーザー・エージェント・プロジェクト間の関係 |
| Procedural Memory | 判断手順・業務ルール・再利用可能な手順 |

### 4.1 Identity Memory

横断PMの基本的な自己認識。

起動時にシステムから注入する。

記憶検索に依存させず、責務・権限・禁止事項を常時参照可能にする。

### 4.2 Semantic Memory

長期的に有効な事実を保持する。

確定情報と推測情報を区別し、根拠・確度・有効期間を持たせる。

### 4.3 Episodic Memory

過去の経験をイベント単位で保持する。

会話の全文をすべて長期記憶に登録するのではなく、原文はイベントとして保存し、検索用に構造化した要約を生成する。

### 4.4 Relational Memory

Graphitiを中心に、以下の関係を管理する。

- ユーザーと横断PM
- 横断PMと個別PM
- 個別PMとプロジェクト
- プロジェクト間の依存関係
- 指示と成果物
- 決定事項と関連するプロジェクト
- 知識とその出典

### 4.5 Procedural Memory

MarkdownまたはJSONによるバージョン管理されたルールとして保持する。

重要な運用ルールを意味検索だけに依存させない。

---

## 5. マルチエージェント対応メモリスコープ

将来的に複数の横断PMエージェントが存在することを前提とする。

メモリは以下の3スコープに分離する。

### 5.1 Agent Private Memory

個別エージェント専用の記憶。

- 個別エージェントの経験
- 独自の認識
- 作業履歴
- 個別に獲得した手順
- 未共有の記憶候補

原則として所有エージェント以外は参照できない。

### 5.2 Shared Memory

組織・ユーザー・プロジェクトに関する共有知識。

- ユーザーの明示的な方針
- プロジェクトの基本情報
- 正式な意思決定
- 個別PMとの通信結果
- 共有が承認された技術的知見

権限を持つ横断PMが参照できる。

### 5.3 Organizational Memory

全エージェント共通の知識。

- 共通技術知識
- エージェント運用規約
- 共通業務ルール
- 再利用可能な手順
- 共通アーキテクチャ方針

管理プロセスを通じて登録・更新する。

### 5.4 アクセス制御

PostgreSQLのRow Level Securityを使用する。

アクセス制御をLLMの判断に依存させない。

認証済みAgent IDをサーバー側で確定し、Memory APIとDBの両方で権限を検証する。

Graphitiのgroup_idは検索対象の論理分割に使用するが、単独で認可機構として扱わない。

---

## 6. PostgreSQLデータモデル

以下のテーブルを実装する。

| テーブル | 役割 |
|---|---|
| organizations | 組織情報 |
| agents | エージェント定義 |
| projects | プロジェクト基本情報 |
| memory_items | 記憶本体 |
| memory_sources | 記憶の出典 |
| memory_relations | 記憶間の関係 |
| memory_permissions | アクセス権限 |
| memory_events | 記憶の更新履歴 |
| memory_candidates | LLMによる抽出候補 |
| memory_promotions | スコープ昇格履歴 |
| agent_messages | エージェント間通信 |
| agent_tasks | 指示・タスクの状態 |
| outbox_events | Graphiti同期用イベント |

### 6.1 Memory Item

以下の属性を持つ。

```typescript
type MemoryItem = {
  id: string
  organizationId: string

  scope:
    | 'agent_private'
    | 'shared'
    | 'organizational'

  ownerAgentId?: string

  memoryType:
    | 'identity'
    | 'semantic'
    | 'episodic'
    | 'relational'
    | 'procedural'

  content: string

  status:
    | 'candidate'
    | 'verified'
    | 'confirmed'
    | 'inferred'
    | 'superseded'

  sourceIds: string[]

  validFrom?: string
  validUntil?: string

  createdAt: string
  updatedAt: string
}
```

実装時には、必要に応じて以下を追加する。

- confidence
- eventTime
- recordedAt
- supersededBy
- sensitivity
- version
- metadata

### 6.2 記憶の状態

| 状態 | 意味 |
|---|---|
| candidate | LLMが抽出した段階 |
| verified | 出典・形式を検証済み |
| confirmed | 正式な事実として確認済み |
| inferred | 推測として登録 |
| rejected | 不採用 |
| superseded | 新しい情報に置き換えられた |

正式決定を要約処理だけで変更してはならない。

決定変更は新しいイベントとして記録し、過去の決定を履歴として保持する。

---

## 7. Graphitiの構成

Graphiti + Neo4jを採用する。

GraphitiのEpisode、Entity、Relationshipを利用する。

### 7.1 グループ設計

以下のようなgroup_idを設ける。

```text
organization:grrow

shared:user-context
shared:portfolio
shared:decisions
shared:agent-knowledge

private:cross-pm-a
private:cross-pm-b

private:project-pm-a
private:project-pm-b
```

実際のgroup_idは組織IDやエージェントIDを含む一意な形式とする。

### 7.2 登録対象

- ユーザーとの重要な対話
- 個別PMへの指示
- 個別PMからの応答
- 成果物の要約
- 技術的な発見
- 意思決定の経緯
- プロジェクト間の関係
- 共有が承認された知識

### 7.3 注意事項

Graphitiへの登録はPostgreSQLのイベント記録後に行う。

Graphiti側の障害時はOutboxから再試行する。

event_idを冪等性キーとして使用し、重複登録を防止する。

GraphitiのAPIやスキーマは採用バージョンの実装を確認し、独自仕様を推測で作らないこと。

---

## 8. Memory API

FastAPIで以下のAPIを実装する。

| API | 処理 |
|---|---|
| memory.recall | 長期記憶の検索 |
| memory.remember | 記憶候補の登録 |
| memory.confirm | 記憶の正式確認 |
| memory.revise | 訂正・更新 |
| memory.relate | 関係登録 |
| memory.explain | 出典・根拠確認 |
| memory.reflect | 経験の振り返り |
| memory.context | 判断用コンテキスト生成 |
| memory.promote | PrivateからSharedへの昇格 |
| memory.archive | 記憶のアーカイブ |

### 8.1 Recall Request

```typescript
type MemoryRecallRequest = {
  query: string

  memoryTypes: (
    | 'semantic'
    | 'episodic'
    | 'relational'
    | 'procedural'
  )[]

  scope?: {
    projectIds?: string[]
    agentIds?: string[]
    userId?: string
  }

  temporal?: {
    validAt?: string
    from?: string
    to?: string
  }

  includeInferred?: boolean
  limit?: number
}
```

検索範囲は認証・認可済みのスコープ内に制限する。

### 8.2 Recall Result

```typescript
type MemoryRecallResult = {
  id: string
  content: string
  memoryType: string

  status:
    | 'confirmed'
    | 'verified'
    | 'inferred'
    | 'superseded'

  sourceEventIds: string[]

  validFrom?: string
  validUntil?: string

  confidence?: number
  relevance: number
}
```

検索結果には出典・確定状態・有効期間を含める。

---

## 9. 記憶の書き込み処理

以下の順序で処理する。

1. ユーザー発言・PM応答・実行結果を受信する。
2. PostgreSQLに原イベントを保存する。
3. LLMで記憶候補を抽出する。
4. 記憶の種類とスコープを判定する。
5. 出典・重複・矛盾・確定状態を検証する。
6. PostgreSQLに記憶候補または正式記憶を登録する。
7. Outboxイベントを登録する。
8. WorkerがGraphitiへ反映する。
9. 同期結果を記録する。

### 9.1 Transactional Outbox

PostgreSQLのトランザクション内で以下を保存する。

- 正式イベント
- Graphiti同期用Outboxイベント

WorkerはOutboxを読み、Graphitiへ反映する。

失敗時は再試行する。

同期済みイベントは再処理しない。

### 9.2 LLMによる抽出

抽出対象：

- 長期的に有効な事実
- ユーザーの明示的な方針
- 意思決定とその理由
- エージェント間の重要なやり取り
- 再利用可能な経験
- プロジェクト間の関係
- 新たに判明した制約

単なる進捗報告や一時的な情報は、原則としてイベント履歴に留める。

---

## 10. 記憶の検索処理

検索は以下の構成とする。

1. Query Understanding
2. 検索意図分類
3. PostgreSQL構造化検索
4. Graphiti検索
5. 必要に応じてpgvector検索
6. 検索結果の統合
7. 重複排除
8. 時系列整列
9. 出典・確定状態の確認
10. Context BuilderによるLLM用情報生成

検索方式：

| 方式 | 対象 |
|---|---|
| Semantic Recall | 類似する知識・技術的経験 |
| Episodic Recall | 過去の指示・応答・経験 |
| Relational Recall | プロジェクト・エージェント間の関係 |
| Temporal Recall | 過去の時点における状態・決定 |

正式な状態や承認情報はPostgreSQLを優先する。

Graphitiの検索結果だけで正式な意思決定を確定してはならない。

推測情報は明示的に区別して横断PMへ渡す。

---

## 11. PrivateからSharedへの昇格

Private Memoryの情報を無条件に共有してはならない。

昇格処理では以下を確認する。

1. 他エージェントにも再利用価値があるか。
2. 出典を確認できるか。
3. プロジェクト固有の機密情報を含まないか。
4. ユーザーの非公開情報を含まないか。
5. 既存のShared Memoryと矛盾しないか。
6. 共有に必要な権限があるか。

昇格時には原文の全面コピーではなく、再利用可能な知識として再構成する。

昇格履歴をmemory_promotionsに保存する。

---

## 12. Background Memory Consolidation

バックグラウンドで以下を実行する。

- 重複記憶の検出
- 古い情報の識別
- 新旧情報の関係付け
- 推測情報の再評価
- 再利用可能な手順の抽出
- PrivateからSharedへの昇格候補抽出
- 不要な一時情報のアーカイブ

ただし、正式な意思決定・ユーザーの明示的な指示・承認済み方針を自動変更してはならない。

Consolidationは記憶の整理であり、意思決定の変更ではない。

---

## 13. エージェント間通信

個別PMとの通信は、通常の会話ログだけでなく、task_idとcorrelation_idを持つイベントとして管理する。

```typescript
type AgentMessage = {
  messageId: string
  correlationId: string
  taskId: string

  sender: string
  recipient: string

  messageType:
    | 'instruction'
    | 'acknowledgement'
    | 'execution_update'
    | 'deliverable'
    | 'technical_finding'
    | 'clarification'
    | 'completion'

  payload: unknown
  createdAt: string
}
```

個別PMの内部メモリを横断PMへ複製することはしない。

横断管理に必要な指示・応答・成果物・技術的知見を抽出して記憶する。

---

## 14. セキュリティ・信頼性

以下を必須要件とする。

- Agent IDによる認証
- メモリスコープによるアクセス制御
- PostgreSQL RLS
- Graphiti検索対象のサーバー側制限
- 出典の追跡
- 記憶の確定状態の管理
- 正式決定の変更履歴保持
- Outboxによる非同期同期
- 冪等性制御
- DBバックアップ
- 操作監査ログ
- 機密情報の共有防止

LLMが生成した情報を、検証なしに正式な記憶へ登録してはならない。

---

## 15. 開発ロードマップ

### Phase 1：基本メモリ基盤

- PostgreSQL構築
- Neo4j構築
- Graphiti接続
- FastAPI Memory API
- 基本スキーマ
- 記憶登録・検索

完了条件：過去の指示・応答・決定事項を検索し、出典付きで再取得できる。

### Phase 2：ハイブリッド記憶

- LLMによる記憶候補抽出
- 確定・推測の分類
- 重複・矛盾の検証
- Transactional Outbox
- Graphiti非同期反映

完了条件：重要情報を自動抽出し、適切な状態で保存できる。

### Phase 3：高度な想起

- Semantic Recall
- Episodic Recall
- Relational Recall
- Temporal Recall
- Context Builder
- 出典追跡

完了条件：過去の経緯を正確に再構成できる。

### Phase 4：記憶の自己整理

- Background Consolidation
- 記憶の統合
- 古い情報の識別
- Procedural Memory生成
- Shared Memory昇格

完了条件：蓄積情報を整理し、将来の判断に再利用できる。

### Phase 5：マルチエージェント対応

- Agent Private Memory
- Shared Memory
- Organizational Memory
- Agent間アクセス制御
- メモリ昇格・共有
- 監査ログ

完了条件：複数の横断PMが、それぞれの固有記憶を維持しながら、許可された共通知識を共有できる。

---

## 16. 実装上の優先事項

以下の順序を厳守する。

1. PostgreSQLの正式データモデルを確定する。
2. Agent ID・Organization ID・Memory Scopeの設計を確定する。
3. GraphitiとNeo4jを接続する。
4. Memory APIを実装する。
5. イベント保存とOutboxを実装する。
6. 記憶候補抽出を実装する。
7. 検索・統合を実装する。
8. マルチエージェント共有を実装する。

最初からすべての機能を一度に実装しないこと。

各Phaseで動作確認・テストを実施し、次のPhaseに進む。

## 17. 初期PoCの評価基準

以下のテストケースを用意する。

### テストA：過去の指示の再現

過去に個別PMへ出した指示について、対象・内容・時刻を正しく検索できるか。

### テストB：意思決定の履歴

過去の承認内容と、その後の変更を区別できるか。

### テストC：時系列の整合性

古い情報と新しい情報を取り違えないか。

### テストD：推測と確定の分離

LLMが推測した内容を、ユーザーが確定した事実として扱わないか。

### テストE：複数Agentの分離

他のAgentのPrivate Memoryを取得できないことを確認する。

### テストF：共有メモリ

許可されたShared Memoryだけを複数Agentから参照できるか。

### テストG：障害復旧

Graphiti停止中もPostgreSQLへの正式イベント記録が継続し、復旧後にOutboxから同期できるか。

### テストH：検索の根拠

取得した記憶について、元イベントと出典を追跡できるか。

---

## 18. 最終的な開発目標

本システムは、単なるRAGではなく、複数のLLMエージェントが長期間協調するためのPersistent Agent Memory基盤である。

以下を最終的に実現する。

- 横断PMが長期間にわたり役割と判断基準を維持する。
- ユーザーとの対話・意思決定の経緯を継続的に保持する。
- 個別PMとの指示・応答・成果物を再利用可能な経験として蓄積する。
- プロジェクト間の関係を時間軸付きで把握する。
- LLMが記憶候補を判断し、システムが記憶の正確性を担保する。
- 複数の横断PMが安全に共通知識を共有する。
- エージェントの停止・再起動後も記憶と実行状態を復元できる。

最優先事項は、記憶の量ではなく、記憶の正確性・出典追跡・時間的整合性・共有権限の保証である。
