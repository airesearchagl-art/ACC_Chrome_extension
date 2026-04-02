# ACC 指摘事項ビューア — Chrome 拡張機能

Autodesk Construction Cloud (ACC) の指摘事項をブラウザのポップアップから確認・コメント投稿できる Chrome 拡張機能です。

---

## 機能一覧

| 機能 | 説明 |
|---|---|
| **OAuth 2.0 PKCE 認証** | Client Secret 不要。ブラウザ内で完結する安全な認証フロー |
| **ハブ / プロジェクト選択** | ドロップダウンで ACC 組織・プロジェクトを切り替え |
| **指摘事項テーブル表示** | タイトル・ステータス・担当者・期限を一覧表示。期限超過は赤字 |
| **リアルタイム検索フィルター** | タイトルと担当者名で即時フィルタリング。Esc キーでリセット |
| **ステータスバッジ** | 9種類のステータスを左ボーダー付きカラーバッジで識別 |
| **スティッキーヘッダー** | スクロール中もテーブルのヘッダー行が常に表示される |
| **クイック返信** | 各行の 💬 ボタンでインラインコメントパネルを展開。Ctrl+Enter で送信 |
| **連続投稿** | 送信後もパネルを閉じずに複数コメントを連続投稿可能 |
| **メモリオンリー** | 取得データをディスクへ永続化しない |

---

## セキュリティ設計

### OAuth 2.0 PKCE フロー

Client Secret をクライアント（拡張機能）に持たせない設計です。

```
拡張機能                    Autodesk (APS)
  │                              │
  │  1. code_verifier 生成 (乱数) │
  │  2. code_challenge = SHA256(verifier)
  │                              │
  │── 認証 URL (code_challenge) ─▶│
  │◀─ authorization code ────────│
  │                              │
  │── token request              │
  │   + code_verifier            │
  │   ※ client_secret 不要       │
  │◀─ access_token ──────────────│
  │                              │
  │  3. code_verifier を破棄     │
```

| 項目 | 実装 |
|---|---|
| `client_secret` | 不在（PKCE フローでは不要） |
| `code_verifier` | `crypto.getRandomValues()` で生成、トークン交換後に GC が解放 |
| CSRF 防止 | 毎回ランダムな `state` を生成し、コールバック時に検証 |
| トークン保管 | `chrome.storage.session` のみ（ブラウザ終了時に自動消去） |
| データ永続化 | `localStorage` / `chrome.storage.local` は一切不使用 |
| XSS 防止 | 動的テキストはすべて `escHtml()` でエスケープ |

### 中継サーバー方式（オプション）

`client_secret` をサーバー側に隠蔽したい場合は `relay-server/` を使用します。

```
拡張機能 ─── POST /auth/start ──▶ 中継サーバー
         ◀── authUrl ──────────── (client_secret はサーバーに保持)
         ─── ブラウザ認証 ──────▶ Autodesk
         ◀── authorization code ─
         ─── POST /auth/callback ▶ 中継サーバー ─▶ Autodesk
         ◀── access_token ─────── (client_secret は渡さない)
```

`src/utils/config.js` の `RELAY_SERVER_URL` を設定すると自動的に切り替わります。

---

## ディレクトリ構成

```
ACC_Chrome_extension/
├── manifest.json                  # Manifest V3
├── src/
│   ├── background/
│   │   └── service-worker.js      # OAuth フロー / API 呼び出し / トークン管理
│   ├── popup/
│   │   ├── popup.html             # UI (600px ポップアップ)
│   │   └── popup.js               # テーブル描画 / 検索 / クイック返信
│   └── utils/
│       ├── config.js              # 設定 (CLIENT_ID 等)
│       ├── pkce.js                # RFC 7636 PKCE ユーティリティ
│       └── acc-api.js             # ACC Issues API v2 クライアント
├── icons/
│   ├── icon.svg                   # ソース SVG
│   └── generate-icons.js          # PNG 生成スクリプト
└── relay-server/                  # オプション: 中継サーバー
    ├── server.js                  # Express.js サーバー
    ├── package.json
    └── .env.example
```

---

## セットアップ

### 1. Autodesk Platform Services (APS) アプリを作成

1. [APS Developer Portal](https://aps.autodesk.com/myapps/) にアクセス
2. **Create Application** でアプリを作成
3. **Callback URL** に以下を追加（拡張機能 ID は後で確認）:
   ```
   https://<EXTENSION_ID>.chromiumapp.org/
   ```
4. **Client ID** をメモ（**Client Secret は不要**）

### 2. 設定ファイルを編集

```js
// src/utils/config.js
export const CONFIG = Object.freeze({
  CLIENT_ID: 'YOUR_APS_CLIENT_ID_HERE',  // ← ここを変更
  // ...
});
```

### 3. アイコンを生成

```bash
cd icons
npm install sharp   # または inkscape / ImageMagick を使用
node generate-icons.js
```

### 4. Chrome に拡張機能をインストール

1. `chrome://extensions` を開く
2. **デベロッパーモード** を有効化
3. **パッケージ化されていない拡張機能を読み込む** → プロジェクトルートを選択
4. 拡張機能の ID を確認し、APS の Callback URL に追加

### 5. （オプション）中継サーバーを起動

```bash
cd relay-server
cp .env.example .env
# .env に APS_CLIENT_ID と APS_CLIENT_SECRET を設定
npm install
npm start
```

`src/utils/config.js` で `RELAY_SERVER_URL` を設定:
```js
RELAY_SERVER_URL: 'https://your-relay-server.example.com',
```

---

## 使い方

1. Chrome ツールバーの拡張機能アイコンをクリック
2. **Autodesk でログイン** ボタンをクリック → ブラウザで認証
3. ハブとプロジェクトをドロップダウンで選択
4. 指摘事項一覧が表示される

### テーブル操作

| 操作 | 動作 |
|---|---|
| タイトルをクリック | 詳細ビューへ移動 |
| 💬 ボタン | 返信パネルを展開 / 折りたたむ |
| 検索バーに入力 | タイトル・担当者名でリアルタイムフィルタリング |
| `Esc` キー | 検索をクリア |
| `Ctrl+Enter` | コメントを送信 |
| ✕ ボタン | 検索バーをクリア |

### ステータスバッジ一覧

| バッジ | ステータス | 色 |
|---|---|---|
| 未対応 | `open` | 赤 |
| 保留中 | `pending` | 紫 |
| 対応中 | `in_progress` | オレンジ |
| 作業完了 | `work_completed` | ティール |
| 回答済 | `answered` | 青 |
| 未承認 | `not_approved` | 濃赤 |
| 完了 | `closed` | 緑 |
| 無効 | `void` | グレー |
| 下書き | `draft` | 薄グレー |

---

## 技術仕様

| 項目 | 内容 |
|---|---|
| Chrome 拡張機能バージョン | Manifest V3 |
| 認証 | OAuth 2.0 PKCE (RFC 7636) |
| ACC API | Issues API v2 (`/construction/issues/v2/...`) |
| ランタイム | Chrome Service Worker (ES Modules) |
| ストレージ | `chrome.storage.session` のみ |
| 対応 Chrome | 116 以上（`chrome.storage.session` 対応） |

---

## 開発者向けメモ

### メッセージフロー

```
popup.js ──sendMessage()──▶ service-worker.js ──fetch()──▶ ACC API
         ◀──response──────────────────────────────────────────────
```

popup から直接 API を呼ばないことで、トークンの露出リスクを最小化しています。

### メッセージ一覧

| type | payload | 説明 |
|---|---|---|
| `AUTH_START` | — | OAuth 認証フローを開始 |
| `AUTH_STATUS` | — | 認証状態を確認 |
| `LOGOUT` | — | トークンを無効化してセッションをクリア |
| `FETCH_HUBS` | — | ハブ一覧を取得 |
| `FETCH_PROJECTS` | `{ hubId }` | プロジェクト一覧を取得 |
| `FETCH_ISSUES` | `{ projectId, filter }` | 指摘事項一覧を取得 |
| `FETCH_ISSUE_DETAIL` | `{ projectId, issueId }` | 指摘事項の詳細を取得 |
| `FETCH_COMMENTS` | `{ projectId, issueId }` | コメント一覧を取得 |
| `POST_COMMENT` | `{ projectId, issueId, body }` | コメントを投稿 |

### ローカル開発

```bash
# 変更後は chrome://extensions で「再読み込み」をクリック
# または Extensions Reloader 等の拡張機能を利用
```
