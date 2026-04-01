/**
 * ACC Chrome Extension - PKCE (Proof Key for Code Exchange) ユーティリティ
 *
 * RFC 7636 準拠の PKCE 実装。
 *
 * セキュリティ設計:
 * - code_verifier は Web Crypto API で生成する暗号論的乱数
 * - code_challenge は SHA-256 ハッシュ (S256 メソッド)
 * - code_verifier はトークン交換後に即座に破棄（メモリ上のみ保持）
 * - state パラメータで CSRF 攻撃を防止
 */

/**
 * PKCE の code_verifier を生成する
 * RFC 7636 §4.1: 43〜128 文字の unreserved characters のみ使用
 *
 * @param {number} length - verifier の文字数 (推奨: 96)
 * @returns {string} code_verifier
 */
export function generateCodeVerifier(length = 96) {
  // unreserved characters (RFC 3986)
  const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, byte => CHARSET[byte % CHARSET.length]).join('');
}

/**
 * code_verifier から code_challenge (S256) を生成する
 *
 * @param {string} codeVerifier
 * @returns {Promise<string>} base64url エンコードされた SHA-256 ハッシュ
 */
export async function generateCodeChallenge(codeVerifier) {
  const encoded = new TextEncoder().encode(codeVerifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return base64UrlEncode(hashBuffer);
}

/**
 * CSRF 対策用の state パラメータを生成する
 *
 * @returns {string} ランダムな hex 文字列
 */
export function generateState() {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * PKCE セット (verifier + challenge + state) を一括生成する
 *
 * @returns {Promise<{codeVerifier: string, codeChallenge: string, state: string}>}
 */
export async function generatePKCESet() {
  const codeVerifier = generateCodeVerifier();
  const [codeChallenge, state] = await Promise.all([
    generateCodeChallenge(codeVerifier),
    Promise.resolve(generateState()),
  ]);
  return { codeVerifier, codeChallenge, state };
}

/**
 * ArrayBuffer を base64url 形式にエンコードする
 *
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  // btoa は Latin-1 文字のみ受け付けるため fromCharCode を使用
  const base64 = btoa(String.fromCharCode(...bytes));
  // base64 → base64url 変換 (+→-, /→_, パディング除去)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
