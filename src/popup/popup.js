/**
 * ACC Chrome Extension - Popup スクリプト
 *
 * セキュリティ設計:
 * - すべての API 呼び出しはサービスワーカー経由（popup から直接 API を叩かない）
 * - レスポンスデータは DOM に描画するのみ（変数以外でキャッシュしない）
 * - ページネーションデータも表示用メモリのみ
 */

// ─── DOM 要素参照 ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const viewLogin   = $('view-login');
const viewMain    = $('view-main');
const viewDetail  = $('view-detail');
const viewLoading = $('view-loading');

const btnLogin    = $('btn-login');
const btnLogout   = $('btn-logout');
const btnReload   = $('btn-reload');
const btnBack     = $('btn-back');

const selHub      = $('sel-hub');
const selProject  = $('sel-project');
const selStatus   = $('sel-status');

const issuesContainer = $('issues-container');
const detailContainer = $('detail-container');
const loadingText     = $('loading-text');

// ─── ページネーション状態（メモリのみ） ──────────────────────────────────────
let currentPage = { projectId: null, offset: 0, total: 0, limit: 20 };

// ─── 初期化 ──────────────────────────────────────────────────────────────────
async function init() {
  setLoading(true, '認証確認中...');
  try {
    const res = await sendMessage({ type: 'AUTH_STATUS' });
    if (res.data?.authenticated) {
      await showMainView();
    } else {
      showLoginView();
    }
  } catch {
    showLoginView();
  } finally {
    setLoading(false);
  }
}

// ─── ビュー切り替え ──────────────────────────────────────────────────────────
function showLoginView() {
  hide(viewMain, viewDetail, viewLoading);
  show(viewLogin);
  hide(btnLogout);
}

async function showMainView() {
  hide(viewLogin, viewDetail, viewLoading);
  show(viewMain, btnLogout);
  await loadHubs();
}

function showDetailView() {
  hide(viewLogin, viewMain, viewLoading);
  show(viewDetail);
}

// ─── イベントリスナー ────────────────────────────────────────────────────────

btnLogin.addEventListener('click', async () => {
  btnLogin.disabled = true;
  setLoading(true, 'Autodesk に接続中...');
  hide(viewLogin);

  try {
    const res = await sendMessage({ type: 'AUTH_START' });
    if (res.error) {
      showLoginView();
      showError(viewLogin, `認証エラー: ${res.message ?? res.error}`);
    } else {
      await showMainView();
    }
  } catch (err) {
    showLoginView();
    showError(viewLogin, `接続エラー: ${err.message}`);
  } finally {
    btnLogin.disabled = false;
    setLoading(false);
  }
});

btnLogout.addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？')) return;
  await sendMessage({ type: 'LOGOUT' });
  showLoginView();
});

selHub.addEventListener('change', async () => {
  selProject.disabled = true;
  selProject.innerHTML = '<option value="">プロジェクトを選択...</option>';
  clearIssues();

  const hubId = selHub.value;
  if (!hubId) return;

  await loadProjects(hubId);
});

selProject.addEventListener('change', async () => {
  clearIssues();
  const projectId = selProject.value;
  if (!projectId) return;
  currentPage = { projectId, offset: 0, total: 0, limit: 20 };
  await loadIssues();
});

selStatus.addEventListener('change', async () => {
  if (!selProject.value) return;
  currentPage.offset = 0;
  await loadIssues();
});

btnReload.addEventListener('click', async () => {
  if (!selProject.value) return;
  currentPage.offset = 0;
  await loadIssues();
});

btnBack.addEventListener('click', () => {
  detailContainer.innerHTML = '';
  show(viewMain);
  hide(viewDetail);
});

// ─── データ読み込み ──────────────────────────────────────────────────────────

async function loadHubs() {
  setLoading(true, 'ハブを読み込み中...');
  try {
    const res = await sendMessage({ type: 'FETCH_HUBS' });
    if (res.error) {
      if (res.error === 'UNAUTHENTICATED' || res.error === 'TOKEN_EXPIRED') {
        showLoginView();
        return;
      }
      showError(viewMain, `ハブの取得に失敗: ${res.message ?? res.error}`);
      return;
    }

    selHub.innerHTML = '<option value="">ハブを選択...</option>';
    const hubs = res.data ?? [];
    if (hubs.length === 0) {
      selHub.innerHTML = '<option value="">ハブが見つかりません</option>';
      return;
    }

    hubs.forEach(hub => {
      const opt = document.createElement('option');
      opt.value = hub.id;
      opt.textContent = hub.attributes?.name ?? hub.id;
      selHub.appendChild(opt);
    });

    // ハブが1つだけなら自動選択
    if (hubs.length === 1) {
      selHub.value = hubs[0].id;
      await loadProjects(hubs[0].id);
    }
  } finally {
    setLoading(false);
  }
}

async function loadProjects(hubId) {
  setLoading(true, 'プロジェクトを読み込み中...');
  selProject.disabled = true;

  try {
    const res = await sendMessage({ type: 'FETCH_PROJECTS', payload: { hubId } });
    if (res.error) {
      showError(viewMain, `プロジェクトの取得に失敗: ${res.message ?? res.error}`);
      return;
    }

    selProject.innerHTML = '<option value="">プロジェクトを選択...</option>';
    const projects = res.data ?? [];
    projects.forEach(proj => {
      const opt = document.createElement('option');
      opt.value = proj.id;
      opt.textContent = proj.attributes?.name ?? proj.id;
      selProject.appendChild(opt);
    });

    selProject.disabled = false;

    // プロジェクトが1つだけなら自動選択
    if (projects.length === 1) {
      selProject.value = projects[0].id;
      selProject.dispatchEvent(new Event('change'));
    }
  } finally {
    setLoading(false);
  }
}

async function loadIssues() {
  const projectId = selProject.value;
  if (!projectId) return;

  setLoading(true, '指摘事項を読み込み中...');
  issuesContainer.innerHTML = '';

  const filter = {
    limit: currentPage.limit,
    offset: currentPage.offset,
  };
  const status = selStatus.value;
  if (status) filter.status = status;

  try {
    const res = await sendMessage({ type: 'FETCH_ISSUES', payload: { projectId, filter } });
    if (res.error) {
      showError(issuesContainer, `指摘事項の取得に失敗: ${res.message ?? res.error}`);
      return;
    }

    const { issues, pagination } = res.data ?? { issues: [], pagination: {} };
    currentPage.total = pagination.totalResults ?? 0;

    renderIssues(issues, pagination);
  } finally {
    setLoading(false);
  }
}

async function loadIssueDetail(projectId, issueId) {
  showDetailView();
  detailContainer.innerHTML = '<div class="loading"><div class="spinner"></div><span>詳細を読み込み中...</span></div>';

  const res = await sendMessage({ type: 'FETCH_ISSUE_DETAIL', payload: { projectId, issueId } });

  if (res.error) {
    detailContainer.innerHTML = '';
    showError(detailContainer, `詳細の取得に失敗: ${res.message ?? res.error}`);
    return;
  }

  renderIssueDetail(res.data);
}

// ─── 描画 ────────────────────────────────────────────────────────────────────

function renderIssues(issues, pagination) {
  issuesContainer.innerHTML = '';

  // カウント表示
  const header = document.createElement('div');
  header.className = 'issues-header';
  const total = pagination.totalResults ?? 0;
  const offset = pagination.offset ?? 0;
  const limit = pagination.limit ?? issues.length;
  header.innerHTML = `
    <span class="issues-count">
      ${total > 0 ? `${offset + 1}〜${Math.min(offset + limit, total)} 件 / 全 ${total} 件` : ''}
    </span>
  `;
  issuesContainer.appendChild(header);

  if (issues.length === 0) {
    issuesContainer.insertAdjacentHTML('beforeend', '<div class="empty">指摘事項がありません</div>');
    return;
  }

  // 指摘カード一覧
  const list = document.createElement('div');
  list.className = 'issues-list';

  issues.forEach(issue => {
    const card = document.createElement('div');
    card.className = 'issue-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const statusLabel = STATUS_LABELS[issue.status] ?? issue.status ?? '不明';
    const badgeClass = `badge-${issue.status ?? 'default'}`;

    const assignee = issue.assignedTo ? escHtml(issue.assignedTo) : '未割当';
    const dueDate  = issue.dueDate    ? formatDate(issue.dueDate) : '-';

    card.innerHTML = `
      <div class="issue-card-header">
        <span class="issue-title">${escHtml(issue.title ?? issue.id)}</span>
        <span class="badge ${badgeClass}">${statusLabel}</span>
      </div>
      <div class="issue-meta">
        <span>&#128100; ${assignee}</span>
        <span>&#128197; ${dueDate}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      loadIssueDetail(selProject.value, issue.id);
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') loadIssueDetail(selProject.value, issue.id);
    });

    list.appendChild(card);
  });

  issuesContainer.appendChild(list);

  // ページネーション
  if (total > limit) {
    const page = document.createElement('div');
    page.className = 'pagination';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn btn-ghost';
    prevBtn.textContent = '← 前へ';
    prevBtn.disabled = offset === 0;
    prevBtn.addEventListener('click', () => {
      currentPage.offset = Math.max(0, offset - limit);
      loadIssues();
    });

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-ghost';
    nextBtn.textContent = '次へ →';
    nextBtn.disabled = offset + limit >= total;
    nextBtn.addEventListener('click', () => {
      currentPage.offset = offset + limit;
      loadIssues();
    });

    page.appendChild(prevBtn);
    page.insertAdjacentHTML('beforeend', `<span>${Math.floor(offset / limit) + 1} / ${Math.ceil(total / limit)}</span>`);
    page.appendChild(nextBtn);
    issuesContainer.appendChild(page);
  }
}

function renderIssueDetail(issue) {
  detailContainer.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'detail-card';

  const statusLabel = STATUS_LABELS[issue.status] ?? issue.status ?? '不明';
  const badgeClass  = `badge-${issue.status ?? 'default'}`;

  const fields = [
    { label: 'ステータス',  value: `<span class="badge ${badgeClass}">${statusLabel}</span>` },
    { label: '担当者',      value: escHtml(issue.assignedTo ?? '-') },
    { label: '期限',        value: issue.dueDate ? formatDate(issue.dueDate) : '-' },
    { label: '作成日',      value: formatDate(issue.createdAt) },
    { label: '更新日',      value: formatDate(issue.updatedAt) },
    { label: 'ID',          value: `<code style="font-size:10px">${escHtml(issue.id)}</code>` },
  ];

  card.innerHTML = `
    <div class="detail-title">${escHtml(issue.title ?? issue.id)}</div>
    <div class="detail-fields">
      ${fields.map(f => `
        <div class="detail-field">
          <label>${f.label}</label>
          <span>${f.value}</span>
        </div>
      `).join('')}
    </div>
    ${issue.description ? `
      <div style="margin-top:12px">
        <div class="detail-field">
          <label>説明</label>
          <span style="white-space:pre-wrap;line-height:1.5">${escHtml(issue.description)}</span>
        </div>
      </div>
    ` : ''}
  `;

  detailContainer.appendChild(card);
}

// ─── ユーティリティ ──────────────────────────────────────────────────────────

/**
 * サービスワーカーにメッセージを送信し、レスポンスを待つ
 * @param {Object} message
 * @returns {Promise<{data?: unknown, error?: string}>}
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response ?? {});
      }
    });
  });
}

function show(...elements) {
  elements.forEach(el => el?.classList.remove('hidden'));
}

function hide(...elements) {
  elements.forEach(el => el?.classList.add('hidden'));
}

function setLoading(on, text = '読み込み中...') {
  loadingText.textContent = text;
  if (on) {
    show(viewLoading);
  } else {
    hide(viewLoading);
  }
}

function clearIssues() {
  issuesContainer.innerHTML = '';
  currentPage = { projectId: null, offset: 0, total: 0, limit: 20 };
}

function showError(container, message) {
  const box = document.createElement('div');
  box.className = 'error-box';
  box.innerHTML = `<span class="error-msg">&#9888; ${escHtml(message)}</span>`;
  container.appendChild(box);
}

/**
 * XSS 対策: HTML エスケープ
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * ISO 8601 → ローカル日付文字列
 * @param {string} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleDateString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch {
    return iso;
  }
}

const STATUS_LABELS = {
  open:        '未対応',
  in_progress: '対応中',
  answered:    '回答済',
  closed:      '完了',
  void:        '無効',
};

// ─── 起動 ────────────────────────────────────────────────────────────────────
init();
