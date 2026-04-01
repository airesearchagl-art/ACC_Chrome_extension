/**
 * ACC Chrome Extension - Service Worker (バックグラウンドスクリプト)
 *
 * ═══════════════════════════════════════════════════════════════════
 * セキュリティ設計
 * ═══════════════════════════════════════════════════════════════════
 *
 * 【認証方式】OAuth 2.0 PKCE (Proof Key for Code Exchange) フロー
 *   - Client Secret は一切使用しない・保持しない
 *   - code_verifier はメモリ上のみ保持し、トークン交換後に即破棄
 *   - state パラメータで CSRF 攻撃を防止
 *
 * 【トークン保管】chrome.storage.session のみ使用
 *   - ブラウザセッション終了時（Chrome 終了時）に自動消去
 *   - ディスクへの永続化なし
 *   - localStorage / chrome.storage.local は一切使用しない
 *
 * 【データフロー】
 *   popup ──[message]──▶ service-worker ──[API]──▶ ACC
 *                          ↑                          │
 *                          └────────[response]────────┘
 *   レスポンスデータはメモリ上で処理し popup に転送するのみ
 *   サービスワーカー内でキャッシュ・保存しない
 *
 * 【中継サーバー方式について】
 *   config.js の RELAY_SERVER_URL を設定することで、
 *   Client Secret をサーバー側に隠蔽した中継サーバー方式に切り替え可能。
 *   詳細は relay-server/server.js を参照。
 * ═══════════════════════════════════════════════════════════════════
 */

import { CONFIG } from '../utils/config.js';
import { generatePKCESet } from '../utils/pkce.js';
import { fetchHubs, fetchProjects, fetchIssues, fetchIssueDetail, ApiError } from '../utils/acc-api.js';

// ─── ストレージキー定数 ──────────────────────────────────────────────────────
const SESSION_KEY = 'acc_session';

// ─── メッセージハンドラ登録 ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Promise を返すため即座に true を返してチャンネルを保持
  handleMessage(message).then(sendResponse).catch(err => {
    console.error('[ACC SW] Unhandled error:', err);
    sendResponse({ error: err.message ?? 'Unknown error' });
  });
  return true; // 非同期レスポンスを有効化
});

// ─── 拡張機能インストール時にストレージを初期化 ───────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  clearSession();
});

// ─── メッセージルーター ──────────────────────────────────────────────────────
/**
 * @param {{type: string, payload?: unknown}} message
 * @returns {Promise<{data?: unknown, error?: string}>}
 */
async function handleMessage(message) {
  switch (message.type) {
    case 'AUTH_START':       return handleAuthStart();
    case 'AUTH_STATUS':      return handleAuthStatus();
    case 'LOGOUT':           return handleLogout();
    case 'FETCH_HUBS':       return handleFetchHubs();
    case 'FETCH_PROJECTS':   return handleFetchProjects(message.payload);
    case 'FETCH_ISSUES':     return handleFetchIssues(message.payload);
    case 'FETCH_ISSUE_DETAIL': return handleFetchIssueDetail(message.payload);
    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ─── 認証フロー ──────────────────────────────────────────────────────────────

/**
 * OAuth 2.0 PKCE 認証を開始する
 */
async function handleAuthStart() {
  // 中継サーバー方式が設定されている場合はそちらを使用
  if (CONFIG.RELAY_SERVER_URL) {
    return startRelayAuth();
  }
  return startPKCEAuth();
}

/**
 * PKCE 認証フロー
 * code_verifier はこの関数のスコープ内にのみ存在し、
 * トークン交換後に GC によって自動的に解放される
 */
async function startPKCEAuth() {
  // 1. PKCE セットを生成（code_verifier はローカル変数にのみ存在）
  const { codeVerifier, codeChallenge, state } = await generatePKCESet();

  // 2. 認証 URL を構築
  const redirectUri = chrome.identity.getRedirectURL();
  const authParams = new URLSearchParams({
    response_type:         'code',
    client_id:             CONFIG.CLIENT_ID,
    redirect_uri:          redirectUri,
    scope:                 CONFIG.SCOPES,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    state:                 state,
  });
  const authUrl = `${CONFIG.AUTH_ENDPOINT}?${authParams}`;

  // 3. ブラウザで認証画面を開く
  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });
  } catch (err) {
    // ユーザーがキャンセルした場合など
    return { error: 'AUTH_CANCELLED', message: err.message };
  }

  if (!responseUrl) {
    return { error: 'AUTH_FAILED', message: '認証レスポンスが空です' };
  }

  // 4. コールバック URL からパラメータを抽出
  const callbackParams = new URL(responseUrl).searchParams;

  // CSRF チェック: state が一致することを確認
  const returnedState = callbackParams.get('state');
  if (returnedState !== state) {
    return { error: 'AUTH_STATE_MISMATCH', message: 'CSRF 検証に失敗しました' };
  }

  const authCode = callbackParams.get('code');
  const errorCode = callbackParams.get('error');

  if (errorCode || !authCode) {
    return { error: 'AUTH_DENIED', message: callbackParams.get('error_description') ?? errorCode };
  }

  // 5. 認証コードをアクセストークンと交換
  //    code_verifier をここで使用（Client Secret は不要）
  const tokenResult = await exchangeCodeForToken({
    authCode,
    codeVerifier, // ← この後スコープを抜けると解放される
    redirectUri,
  });

  // code_verifier はこれ以降不要なので明示的に上書き（GC ヒント）
  // codeVerifier = null; // const なので不可。スコープアウトで GC される。

  if (tokenResult.error) {
    return tokenResult;
  }

  // 6. セッション情報を chrome.storage.session に保存
  await saveSession(tokenResult.data);

  return { data: { authenticated: true } };
}

/**
 * 中継サーバー方式の認証フロー
 * Client Secret はサーバー側で管理され、拡張機能には渡らない
 */
async function startRelayAuth() {
  const redirectUri = chrome.identity.getRedirectURL();

  // 中継サーバーから認証 URL を取得
  let authUrl;
  try {
    const res = await fetch(`${CONFIG.RELAY_SERVER_URL}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUri }),
    });
    if (!res.ok) throw new Error(`Relay server error: ${res.status}`);
    const json = await res.json();
    authUrl = json.authUrl;
    if (!authUrl) throw new Error('中継サーバーから authUrl を取得できませんでした');
  } catch (err) {
    return { error: 'RELAY_START_FAILED', message: err.message };
  }

  // ブラウザで認証
  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (err) {
    return { error: 'AUTH_CANCELLED', message: err.message };
  }

  if (!responseUrl) {
    return { error: 'AUTH_FAILED', message: '認証レスポンスが空です' };
  }

  // 認証コードを中継サーバーへ送信し、アクセストークンを受け取る
  const callbackParams = new URL(responseUrl).searchParams;
  const authCode = callbackParams.get('code');
  if (!authCode) {
    return { error: 'AUTH_DENIED', message: callbackParams.get('error_description') };
  }

  let tokenData;
  try {
    const res = await fetch(`${CONFIG.RELAY_SERVER_URL}/auth/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: authCode, redirectUri }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Relay token exchange failed: ${res.status} ${body}`);
    }
    tokenData = await res.json();
  } catch (err) {
    return { error: 'RELAY_CALLBACK_FAILED', message: err.message };
  }

  await saveSession(tokenData);
  return { data: { authenticated: true } };
}

/**
 * 認証コードをアクセストークンと交換する（PKCE）
 *
 * @param {{authCode: string, codeVerifier: string, redirectUri: string}}
 * @returns {Promise<{data?: TokenData, error?: string}>}
 */
async function exchangeCodeForToken({ authCode, codeVerifier, redirectUri }) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code:          authCode,
    client_id:     CONFIG.CLIENT_ID,
    redirect_uri:  redirectUri,
    code_verifier: codeVerifier,
    // ← Client Secret は不要（PKCE の核心）
  });

  let response;
  try {
    response = await fetch(CONFIG.TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    return { error: 'NETWORK_ERROR', message: err.message };
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    return { error: 'TOKEN_EXCHANGE_FAILED', message: `${response.status}: ${errorBody}` };
  }

  const json = await response.json();
  return {
    data: {
      accessToken:  json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt:    Date.now() + (json.expires_in ?? 3600) * 1000,
      tokenType:    json.token_type ?? 'Bearer',
    },
  };
}

// ─── セッション管理 ──────────────────────────────────────────────────────────

/**
 * セッション情報を chrome.storage.session に保存する
 * chrome.storage.session はブラウザセッション終了時に自動クリアされる
 *
 * @param {{accessToken: string, refreshToken: string|null, expiresAt: number}} tokenData
 */
async function saveSession(tokenData) {
  await chrome.storage.session.set({
    [SESSION_KEY]: {
      accessToken:  tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt:    tokenData.expiresAt,
    },
  });
}

/**
 * セッション情報を取得する
 * @returns {Promise<{accessToken: string, refreshToken: string|null, expiresAt: number}|null>}
 */
async function getSession() {
  const result = await chrome.storage.session.get(SESSION_KEY);
  return result[SESSION_KEY] ?? null;
}

/**
 * セッション情報を削除する（ログアウト・セキュリティクリア）
 */
async function clearSession() {
  await chrome.storage.session.remove(SESSION_KEY);
}

/**
 * 有効なアクセストークンを取得する（期限切れの場合はリフレッシュ）
 * @returns {Promise<string|null>}
 */
async function getValidAccessToken() {
  const session = await getSession();
  if (!session) return null;

  const bufferMs = CONFIG.TOKEN_EXPIRY_BUFFER_SEC * 1000;
  const isExpiringSoon = Date.now() >= (session.expiresAt - bufferMs);

  if (!isExpiringSoon) {
    return session.accessToken;
  }

  // リフレッシュトークンがある場合は更新を試みる
  if (session.refreshToken) {
    const refreshed = await refreshAccessToken(session.refreshToken);
    if (refreshed) return refreshed;
  }

  // トークン更新失敗 → セッションをクリア
  await clearSession();
  return null;
}

/**
 * アクセストークンをリフレッシュする
 * @param {string} refreshToken
 * @returns {Promise<string|null>} 新しいアクセストークン、失敗時は null
 */
async function refreshAccessToken(refreshToken) {
  try {
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     CONFIG.CLIENT_ID,
    });

    const response = await fetch(CONFIG.TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) return null;

    const json = await response.json();
    const newSession = {
      accessToken:  json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt:    Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    await saveSession(newSession);
    return newSession.accessToken;
  } catch {
    return null;
  }
}

// ─── 認証状態確認 ────────────────────────────────────────────────────────────

async function handleAuthStatus() {
  const token = await getValidAccessToken();
  return { data: { authenticated: token !== null } };
}

// ─── ログアウト ──────────────────────────────────────────────────────────────

async function handleLogout() {
  const session = await getSession();

  // アクセストークンを Autodesk 側でも無効化する（ベストエフォート）
  if (session?.accessToken) {
    try {
      const body = new URLSearchParams({
        token:           session.accessToken,
        token_type_hint: 'access_token',
      });
      // Basic 認証（PKCE では client_secret なし → client_id のみ）
      const credentials = btoa(`${CONFIG.CLIENT_ID}:`);
      await fetch(CONFIG.REVOKE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${credentials}`,
        },
        body: body.toString(),
      });
    } catch {
      // revoke 失敗はログアウト処理を止めない
    }
  }

  await clearSession();
  return { data: { loggedOut: true } };
}

// ─── ACC API ハンドラ ────────────────────────────────────────────────────────

async function handleFetchHubs() {
  return withToken(async (token) => {
    const hubs = await fetchHubs(token);
    return { data: hubs };
  });
}

async function handleFetchProjects({ hubId }) {
  if (!hubId) return { error: 'hubId が必要です' };
  return withToken(async (token) => {
    const projects = await fetchProjects(token, hubId);
    return { data: projects };
  });
}

async function handleFetchIssues({ projectId, filter }) {
  if (!projectId) return { error: 'projectId が必要です' };
  return withToken(async (token) => {
    const result = await fetchIssues(token, projectId, filter ?? {});
    return { data: result };
  });
}

async function handleFetchIssueDetail({ projectId, issueId }) {
  if (!projectId || !issueId) return { error: 'projectId と issueId が必要です' };
  return withToken(async (token) => {
    const issue = await fetchIssueDetail(token, projectId, issueId);
    return { data: issue };
  });
}

/**
 * 有効なトークンを取得してコールバックを実行するヘルパー
 * @param {(token: string) => Promise<{data?: unknown, error?: string}>} callback
 */
async function withToken(callback) {
  const token = await getValidAccessToken();
  if (!token) {
    return { error: 'UNAUTHENTICATED', message: '再度ログインしてください' };
  }

  try {
    return await callback(token);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        await clearSession(); // 無効なトークンを即クリア
        return { error: 'TOKEN_EXPIRED', message: '再度ログインしてください' };
      }
      return { error: 'API_ERROR', message: err.message, status: err.status };
    }
    return { error: 'UNEXPECTED_ERROR', message: err.message };
  }
}
