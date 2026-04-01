/**
 * ACC Chrome Extension - 設定ファイル
 *
 * セキュリティ設計:
 * - PKCE フローを使用するため CLIENT_SECRET は不要・非存在
 * - CLIENT_ID は公開情報として扱ってよい（PKCE の前提）
 * - 中継サーバー方式を選ぶ場合は RELAY_SERVER_URL のみ設定し、
 *   CLIENT_ID / CLIENT_SECRET はサーバー側にのみ置く
 */

export const CONFIG = Object.freeze({
  // ─── Autodesk Platform Services (APS) ───────────────────────────────────
  // APS Developer Portal で作成したアプリの Client ID
  // PKCE フローでは Client Secret は不要
  CLIENT_ID: 'YOUR_APS_CLIENT_ID_HERE',

  // OAuth 2.0 エンドポイント
  AUTH_ENDPOINT:  'https://developer.api.autodesk.com/authentication/v2/authorize',
  TOKEN_ENDPOINT: 'https://developer.api.autodesk.com/authentication/v2/token',
  REVOKE_ENDPOINT: 'https://developer.api.autodesk.com/authentication/v2/revoke',

  // 必要なスコープ
  // data:read   … プロジェクトデータ読み取り
  // account:read … ACC アカウント情報読み取り
  SCOPES: 'data:read account:read',

  // ─── API ────────────────────────────────────────────────────────────────
  API_BASE: 'https://developer.api.autodesk.com',

  // ─── 中継サーバー方式 (オプション) ──────────────────────────────────────
  // Client Secret をサーバー側に隠蔽したい場合のみ設定。
  // 設定した場合、PKCE フローの代わりに中継サーバー経由で認証する。
  // null のままにすると PKCE フローを使用する。
  RELAY_SERVER_URL: null,
  // 例: RELAY_SERVER_URL: 'https://your-relay-server.example.com',

  // ─── トークン管理 ────────────────────────────────────────────────────────
  // アクセストークンの有効期限バッファ（秒）
  // 実際の期限より早めにリフレッシュする
  TOKEN_EXPIRY_BUFFER_SEC: 300,
});
