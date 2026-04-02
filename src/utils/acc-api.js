/**
 * ACC Chrome Extension - Autodesk Construction Cloud API クライアント
 *
 * セキュリティ設計:
 * - Bearer トークンはヘッダーで送信し、URL パラメータには含めない
 * - レスポンスデータは呼び出し元に返すのみ（内部でキャッシュ・永続化しない）
 * - すべての API 呼び出しはサービスワーカー経由（popup から直接呼ばない）
 */

import { CONFIG } from './config.js';

/**
 * 共通 fetch ラッパー
 * @param {string} url
 * @param {string} accessToken
 * @param {RequestInit} [options]
 * @returns {Promise<unknown>}
 */
async function apiFetch(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new ApiError(response.status, response.statusText, errorText);
  }

  return response.json();
}

/**
 * ACC/BIM360 のハブ一覧を取得する
 * @param {string} accessToken
 * @returns {Promise<Hub[]>}
 */
export async function fetchHubs(accessToken) {
  const data = await apiFetch(
    `${CONFIG.API_BASE}/project/v1/hubs`,
    accessToken,
  );
  return data.data ?? [];
}

/**
 * 指定ハブのプロジェクト一覧を取得する
 * @param {string} accessToken
 * @param {string} hubId
 * @returns {Promise<Project[]>}
 */
export async function fetchProjects(accessToken, hubId) {
  const data = await apiFetch(
    `${CONFIG.API_BASE}/project/v1/hubs/${encodeURIComponent(hubId)}/projects`,
    accessToken,
  );
  return data.data ?? [];
}

/**
 * プロジェクトの ACC Issues コンテナ ID を取得する
 * @param {string} accessToken
 * @param {string} hubId
 * @param {string} projectId
 * @returns {Promise<string|null>} containerId
 */
export async function fetchIssuesContainerId(accessToken, hubId, projectId) {
  const data = await apiFetch(
    `${CONFIG.API_BASE}/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}`,
    accessToken,
  );
  // Issues コンテナ ID は relationships.issues.data.id に格納されている
  return data?.data?.relationships?.issues?.data?.id ?? null;
}

/**
 * 指摘事項 (Issues) の一覧を取得する
 *
 * @param {string} accessToken
 * @param {string} projectId  - ACC プロジェクト ID (b. prefix なし)
 * @param {IssueFilter} [filter]
 * @returns {Promise<Issue[]>}
 */
export async function fetchIssues(accessToken, projectId, filter = {}) {
  // ACC Issues API v2 を使用
  // projectId は "b." prefix 付きで渡されることがあるため正規化する
  const normalizedProjectId = projectId.replace(/^b\./, '');

  const params = new URLSearchParams();
  if (filter.status)     params.set('filter[status]',     filter.status);
  if (filter.assignedTo) params.set('filter[assignedTo]', filter.assignedTo);
  if (filter.dueDate)    params.set('filter[dueDate]',    filter.dueDate);
  if (filter.limit)      params.set('page[limit]',        String(filter.limit));
  if (filter.offset)     params.set('page[offset]',       String(filter.offset));

  const queryString = params.toString() ? `?${params}` : '';
  const url = `${CONFIG.API_BASE}/construction/issues/v2/projects/${encodeURIComponent(normalizedProjectId)}/issues${queryString}`;

  const data = await apiFetch(url, accessToken);
  return {
    issues: data.results ?? [],
    pagination: data.pagination ?? { limit: 0, offset: 0, totalResults: 0 },
  };
}

/**
 * 指摘事項の詳細を取得する
 * @param {string} accessToken
 * @param {string} projectId
 * @param {string} issueId
 * @returns {Promise<Issue>}
 */
export async function fetchIssueDetail(accessToken, projectId, issueId) {
  const normalizedProjectId = projectId.replace(/^b\./, '');
  return apiFetch(
    `${CONFIG.API_BASE}/construction/issues/v2/projects/${encodeURIComponent(normalizedProjectId)}/issues/${encodeURIComponent(issueId)}`,
    accessToken,
  );
}

/**
 * 指摘事項のステータスを更新する（PATCH）
 * @param {string} accessToken
 * @param {string} projectId
 * @param {string} issueId
 * @param {string} status - 'open'|'pending'|'in_progress'|'answered'|'closed' 等
 * @returns {Promise<Issue>}
 */
export async function patchIssueStatus(accessToken, projectId, issueId, status) {
  const normalizedProjectId = projectId.replace(/^b\./, '');
  return apiFetch(
    `${CONFIG.API_BASE}/construction/issues/v2/projects/${encodeURIComponent(normalizedProjectId)}/issues/${encodeURIComponent(issueId)}`,
    accessToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
  );
}

/**
 * 指摘事項のコメント一覧を取得する
 * @param {string} accessToken
 * @param {string} projectId
 * @param {string} issueId
 * @returns {Promise<Comment[]>}
 */
export async function fetchIssueComments(accessToken, projectId, issueId) {
  const normalizedProjectId = projectId.replace(/^b\./, '');
  const data = await apiFetch(
    `${CONFIG.API_BASE}/construction/issues/v2/projects/${encodeURIComponent(normalizedProjectId)}/issues/${encodeURIComponent(issueId)}/comments`,
    accessToken,
  );
  return data.results ?? [];
}

/**
 * 指摘事項にコメントを投稿する
 * @param {string} accessToken
 * @param {string} projectId
 * @param {string} issueId
 * @param {string} body - コメント本文（最大 10000 文字）
 * @returns {Promise<Comment>}
 */
export async function postIssueComment(accessToken, projectId, issueId, body) {
  const normalizedProjectId = projectId.replace(/^b\./, '');
  return apiFetch(
    `${CONFIG.API_BASE}/construction/issues/v2/projects/${encodeURIComponent(normalizedProjectId)}/issues/${encodeURIComponent(issueId)}/comments`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ body }),
    },
  );
}

/**
 * API エラークラス
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} statusText
   * @param {string} body
   */
  constructor(status, statusText, body) {
    super(`ACC API Error ${status}: ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * @typedef {Object} Hub
 * @property {string} id
 * @property {string} type
 * @property {{name: string}} attributes
 */

/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} type
 * @property {{name: string}} attributes
 */

/**
 * @typedef {Object} Issue
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string|null} assignedTo
 * @property {string|null} dueDate
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} IssueFilter
 * @property {string} [status]      - 'open'|'in_progress'|'answered'|'closed'
 * @property {string} [assignedTo]  - ユーザー ID
 * @property {string} [dueDate]     - ISO 8601 日付
 * @property {number} [limit]       - 1〜200
 * @property {number} [offset]      - ページネーション offset
 */
