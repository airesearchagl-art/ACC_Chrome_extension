/**
 * ACC Chrome Extension - 中継サーバー (Relay Server)
 *
 * ═══════════════════════════════════════════════════════════════════
 * 用途: Client Secret をサーバー側に隠蔽する認証中継
 *
 * このサーバーは PKCE フローの代替として使用できる。
 * クライアント拡張機能は CLIENT_SECRET を一切持たず、
 * すべてのトークン交換をこのサーバー経由で行う。
 *
 * フロー:
 *   1. 拡張機能 → POST /auth/start   → 認証 URL を受け取る
 *   2. ブラウザ  → Autodesk 認証画面  → code を受け取る
 *   3. 拡張機能 → POST /auth/callback → access_token を受け取る
 *      （このステップで CLIENT_SECRET を使用するが、拡張機能には渡さない）
 *
 * セキュリティ設計:
 *   - CLIENT_SECRET は環境変数にのみ存在（コードに書かない）
 *   - state パラメータで CSRF 防止
 *   - state はサーバーメモリに短期保存（TTL: 10分）
 *   - CORS で許可オリジンを拡張機能のみに制限
 *   - レート制限で乱用を防止
 *   - HTTPS 必須（本番環境）
 * ═══════════════════════════════════════════════════════════════════
 *
 * セットアップ:
 *   npm install express node-fetch dotenv
 *   cp .env.example .env   # 環境変数を設定
 *   node server.js
 */

import 'dotenv/config';
import express from 'express';
import { randomBytes } from 'crypto';

const app = express();
app.use(express.json());

// ─── 設定 ────────────────────────────────────────────────────────────────────
const CONFIG = {
  CLIENT_ID:     process.env.APS_CLIENT_ID     ?? (() => { throw new Error('APS_CLIENT_ID が設定されていません'); })(),
  CLIENT_SECRET: process.env.APS_CLIENT_SECRET ?? (() => { throw new Error('APS_CLIENT_SECRET が設定されていません'); })(),
  AUTH_ENDPOINT:  'https://developer.api.autodesk.com/authentication/v2/authorize',
  TOKEN_ENDPOINT: 'https://developer.api.autodesk.com/authentication/v2/token',
  SCOPES:        process.env.APS_SCOPES ?? 'data:read account:read',
  PORT:          parseInt(process.env.PORT ?? '3000', 10),
  // Chrome 拡張機能の ID に合わせて設定（本番時は具体的な ID を指定）
  ALLOWED_EXTENSION_ID: process.env.ALLOWED_EXTENSION_ID ?? null,
};

// ─── state ストア（メモリ内、TTL 付き） ─────────────────────────────────────
// 本番環境では Redis 等を使用することを推奨
const STATE_TTL_MS = 10 * 60 * 1000; // 10分
const stateStore = new Map(); // state → { redirectUri, expiresAt }

// 期限切れ state を定期クリーンアップ
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of stateStore) {
    if (val.expiresAt < now) stateStore.delete(key);
  }
}, 60_000);

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin ?? '';
  // Chrome 拡張機能からのリクエストのみ許可
  const isChromeExtension = origin.startsWith('chrome-extension://');
  const isAllowedExtension = CONFIG.ALLOWED_EXTENSION_ID
    ? origin === `chrome-extension://${CONFIG.ALLOWED_EXTENSION_ID}`
    : isChromeExtension;

  if (!isAllowedExtension) {
    return res.status(403).json({ error: 'FORBIDDEN', message: '許可されていないオリジンです' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── 簡易レート制限 ─────────────────────────────────────────────────────────
const rateLimitStore = new Map(); // IP → { count, resetAt }
const RATE_LIMIT = { windowMs: 60_000, max: 20 };

app.use((req, res, next) => {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || entry.resetAt < now) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT.max) {
    return res.status(429).json({ error: 'RATE_LIMIT', message: 'リクエスト制限を超えました' });
  }
  next();
});

// ─── POST /auth/start ────────────────────────────────────────────────────────
/**
 * 認証 URL を生成して返す
 * Request:  { redirectUri: string }
 * Response: { authUrl: string }
 */
app.post('/auth/start', (req, res) => {
  const { redirectUri } = req.body ?? {};
  if (!redirectUri || typeof redirectUri !== 'string') {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'redirectUri が必要です' });
  }

  // state を生成してメモリに保存
  const state = randomBytes(16).toString('hex');
  stateStore.set(state, {
    redirectUri,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CONFIG.CLIENT_ID,
    redirect_uri:  redirectUri,
    scope:         CONFIG.SCOPES,
    state,
  });

  res.json({ authUrl: `${CONFIG.AUTH_ENDPOINT}?${params}` });
});

// ─── POST /auth/callback ─────────────────────────────────────────────────────
/**
 * 認証コードをアクセストークンに交換する（CLIENT_SECRET はここで使用）
 * Request:  { code: string, redirectUri: string, state: string }
 * Response: { accessToken: string, refreshToken?: string, expiresIn: number }
 */
app.post('/auth/callback', async (req, res) => {
  const { code, redirectUri, state } = req.body ?? {};

  if (!code || !redirectUri || !state) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'code / redirectUri / state が必要です' });
  }

  // CSRF 検証: state がストアに存在するか確認
  const storedState = stateStore.get(state);
  if (!storedState) {
    return res.status(400).json({ error: 'INVALID_STATE', message: '無効または期限切れの state です' });
  }

  if (storedState.expiresAt < Date.now()) {
    stateStore.delete(state);
    return res.status(400).json({ error: 'STATE_EXPIRED', message: 'state の有効期限が切れています' });
  }

  // state を使用済みとして即削除（リプレイ攻撃防止）
  stateStore.delete(state);

  // redirectUri の一致確認
  if (storedState.redirectUri !== redirectUri) {
    return res.status(400).json({ error: 'REDIRECT_URI_MISMATCH', message: 'redirectUri が一致しません' });
  }

  // トークン交換（CLIENT_SECRET をここで使用）
  try {
    const tokenBody = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET, // ← サーバー側のみで使用
      redirect_uri:  redirectUri,
    });

    const tokenRes = await fetch(CONFIG.TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('[Relay] Token exchange failed:', tokenRes.status, body);
      return res.status(502).json({ error: 'TOKEN_EXCHANGE_FAILED', message: 'トークン交換に失敗しました' });
    }

    const json = await tokenRes.json();

    // CLIENT_SECRET は絶対にクライアントに返さない
    // access_token と refresh_token のみ返す
    res.json({
      accessToken:  json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt:    Date.now() + (json.expires_in ?? 3600) * 1000,
      tokenType:    json.token_type ?? 'Bearer',
    });
  } catch (err) {
    console.error('[Relay] Unexpected error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'サーバーエラーが発生しました' });
  }
});

// ─── POST /auth/refresh ──────────────────────────────────────────────────────
/**
 * リフレッシュトークンでアクセストークンを更新する
 * Request:  { refreshToken: string }
 * Response: { accessToken: string, refreshToken?: string, expiresIn: number }
 */
app.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body ?? {};
  if (!refreshToken) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'refreshToken が必要です' });
  }

  try {
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
    });

    const tokenRes = await fetch(CONFIG.TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      return res.status(401).json({ error: 'REFRESH_FAILED', message: 'トークンリフレッシュに失敗しました' });
    }

    const json = await tokenRes.json();
    res.json({
      accessToken:  json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt:    Date.now() + (json.expires_in ?? 3600) * 1000,
    });
  } catch (err) {
    console.error('[Relay] Refresh error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─── ヘルスチェック ──────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── 起動 ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`[Relay] Server running on port ${CONFIG.PORT}`);
});
