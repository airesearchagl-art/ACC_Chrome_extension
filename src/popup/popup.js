/**
 * ACC Chrome Extension - Popup スクリプト
 *
 * セキュリティ設計:
 * - すべての API 呼び出しはサービスワーカー経由（popup から直接 API を叩かない）
 * - DOM に挿入する文字列はすべて escHtml() を通す（XSS 防止）
 * - レスポンスデータは表示用変数のみ保持、永続化しない
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
const inputSearch     = $('input-search');
const btnSearchClear  = $('btn-search-clear');

// ─── 状態（メモリのみ） ───────────────────────────────────────────────────────
let currentPage = { projectId: null, offset: 0, total: 0, limit: 20 };

/** 現在開いている返信パネルの issueId を追跡 */
const openReplyPanels = new Set();

/** 検索バーのデバウンスタイマー */
let searchDebounceTimer = null;

// ─── ステータスラベル・バッジ定義 ────────────────────────────────────────────
const STATUS_LABELS = {
  open:            '未対応',
  pending:         '保留中',
  in_progress:     '対応中',
  work_completed:  '作業完了',
  answered:        '回答済',
  not_approved:    '未承認',
  closed:          '完了',
  void:            '無効',
  draft:           '下書き',
};

const MAX_COMMENT_LENGTH = 10000;

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
        showLoginView(); return;
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
  openReplyPanels.clear();

  const filter = { limit: currentPage.limit, offset: currentPage.offset };
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

// ─── テーブル描画 ────────────────────────────────────────────────────────────

/**
 * 指摘一覧を <table> で描画する
 * @param {Issue[]} issues
 * @param {{totalResults:number, limit:number, offset:number}} pagination
 */
function renderIssues(issues, pagination) {
  issuesContainer.innerHTML = '';

  const total  = pagination.totalResults ?? 0;
  const offset = pagination.offset ?? 0;
  const limit  = pagination.limit ?? issues.length;

  // カウント表示
  const header = document.createElement('div');
  header.className = 'issues-header';
  header.innerHTML = `
    <span class="issues-count">
      ${total > 0 ? `${offset + 1}〜${Math.min(offset + limit, total)} 件 / 全 ${total} 件` : ''}
    </span>`;
  issuesContainer.appendChild(header);

  if (issues.length === 0) {
    issuesContainer.insertAdjacentHTML('beforeend', '<div class="empty">指摘事項がありません</div>');
    return;
  }

  // テーブル
  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrapper';

  const table = document.createElement('table');
  table.className = 'issues-table';

  // thead
  const thead = table.createTHead();
  thead.innerHTML = `
    <tr>
      <th class="col-num">#</th>
      <th class="col-title">指摘タイトル</th>
      <th class="col-status">ステータス</th>
      <th class="col-assign">担当者</th>
      <th class="col-due">期限</th>
      <th class="col-reply"></th>
    </tr>`;

  // tbody
  const tbody = table.createTBody();
  issues.forEach((issue, idx) => {
    tbody.appendChild(createIssueRow(issue, offset + idx + 1));
    tbody.appendChild(createReplyRow(issue.id));
  });

  // 検索結果なし行（フィルター適用時に必要に応じて表示）
  const trNoMatch = document.createElement('tr');
  trNoMatch.className = 'search-no-match hidden';
  trNoMatch.id = 'tr-no-match';
  const tdNoMatch = document.createElement('td');
  tdNoMatch.colSpan = 6;
  tdNoMatch.textContent = '検索条件に一致する指摘事項がありません';
  trNoMatch.appendChild(tdNoMatch);
  tbody.appendChild(trNoMatch);

  wrapper.appendChild(table);
  issuesContainer.appendChild(wrapper);

  // ページネーション
  if (total > limit) {
    const pag = document.createElement('div');
    pag.className = 'pagination';

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

    pag.appendChild(prevBtn);
    pag.insertAdjacentHTML('beforeend',
      `<span>${Math.floor(offset / limit) + 1} / ${Math.ceil(total / limit)}</span>`);
    pag.appendChild(nextBtn);
    issuesContainer.appendChild(pag);
  }
}

/**
 * テーブル行をリアルタイム検索フィルタリングする
 *
 * 検索対象: タイトル (data-search-title) と 担当者名 (data-search-assign)
 * どちらか一方でも部分一致すれば表示する（OR 検索）
 *
 * @param {string} query - 検索文字列（空文字でフィルター解除）
 */
function applySearchFilter(query) {
  const q = query.trim().toLowerCase();
  const issueRows = document.querySelectorAll('.issues-table tbody .issue-row');
  const trNoMatch = document.getElementById('tr-no-match');
  let visibleCount = 0;

  issueRows.forEach(tr => {
    const titleMatch  = (tr.dataset.searchTitle  ?? '').includes(q);
    const assignMatch = (tr.dataset.searchAssign ?? '').includes(q);
    const matches = !q || titleMatch || assignMatch;

    tr.classList.toggle('hidden', !matches);

    // 対応する返信パネル行を連動させる
    const issueId = tr.dataset.issueId;
    const replyRow = document.querySelector(
      `tr.reply-row[data-reply-for="${CSS.escape(issueId)}"]`
    );
    if (replyRow) {
      if (!matches) {
        // 非表示になる行の返信パネルは閉じてから隠す
        if (openReplyPanels.has(issueId)) {
          closeReplyPanel(issueId, tr, replyRow);
        }
        replyRow.classList.add('hidden');
      }
      // matches=true の場合は openReplyPanels の状態に委ねる（再表示しない）
    }

    if (matches) visibleCount++;
  });

  // 一致なし行の表示制御
  trNoMatch?.classList.toggle('hidden', visibleCount > 0 || !q);

  // issues-count テキストを更新
  const countEl = issuesContainer.querySelector('.issues-count');
  if (!countEl) return;

  if (q) {
    // 検索中: "N 件一致 / M 件中"
    countEl.innerHTML =
      `${visibleCount} 件一致` +
      `<span class="match-badge">${visibleCount}</span>` +
      ` / ${issueRows.length} 件中`;
  } else {
    // 検索クリア: 元のページネーション表示に戻す
    const total  = currentPage.total;
    const offset = currentPage.offset;
    const limit  = currentPage.limit;
    countEl.innerHTML = total > 0
      ? `${offset + 1}〜${Math.min(offset + limit, total)} 件 / 全 ${total} 件`
      : '';
  }
}

/**
 * 指摘1行 <tr> を生成する
 * @param {Issue} issue
 * @param {number} rowNum
 * @returns {HTMLTableRowElement}
 */
function createIssueRow(issue, rowNum) {
  const tr = document.createElement('tr');
  tr.className = 'issue-row';
  tr.dataset.issueId = issue.id;
  // 検索フィルター用: 小文字正規化済みの値をデータ属性に格納
  tr.dataset.searchTitle  = (issue.title ?? issue.id ?? '').toLowerCase();
  tr.dataset.searchAssign = (issue.assignedTo ?? '').toLowerCase();

  const statusLabel = STATUS_LABELS[issue.status] ?? issue.status ?? '不明';
  const badgeClass  = `badge-${issue.status ?? 'default'}`;
  const assignee    = issue.assignedTo ? escHtml(issue.assignedTo) : '<span style="color:var(--text-muted)">未割当</span>';
  const dueHtml     = buildDueDateHtml(issue.dueDate);

  tr.innerHTML = `
    <td class="td-num">${rowNum}</td>
    <td class="td-title" title="${escAttr(issue.title ?? issue.id)}">${escHtml(issue.title ?? issue.id)}</td>
    <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
    <td class="td-assign">${assignee}</td>
    <td class="td-due">${dueHtml}</td>
    <td style="text-align:center">
      <button class="btn-reply" title="コメントを追加" data-issue-id="${escAttr(issue.id)}">&#128172;</button>
    </td>`;

  // タイトルクリック → 詳細ビュー
  tr.querySelector('.td-title').addEventListener('click', () => {
    loadIssueDetail(selProject.value, issue.id);
  });

  // 返信ボタン
  tr.querySelector('.btn-reply').addEventListener('click', () => {
    toggleReplyPanel(issue.id, tr);
  });

  return tr;
}

/**
 * 返信パネル行 <tr> を生成する（初期状態は hidden）
 * @param {string} issueId
 * @returns {HTMLTableRowElement}
 */
function createReplyRow(issueId) {
  const tr = document.createElement('tr');
  tr.className = 'reply-row hidden';
  tr.dataset.replyFor = issueId;

  const td = document.createElement('td');
  td.colSpan = 6;

  const panel = document.createElement('div');
  panel.className = 'reply-panel';

  // コメント履歴エリア
  const history = document.createElement('div');
  history.className = 'comment-history';
  history.id = `ch-${issueId}`;
  history.innerHTML = '<div class="comment-loading"><div class="spinner-sm"></div><span>コメントを読み込み中...</span></div>';

  // 入力エリア
  const inputArea = document.createElement('div');
  inputArea.className = 'reply-input-area';

  const textarea = document.createElement('textarea');
  textarea.className = 'reply-textarea';
  textarea.placeholder = 'コメントを入力... (Ctrl+Enter で送信)';
  textarea.maxLength = MAX_COMMENT_LENGTH;

  const footer = document.createElement('div');
  footer.className = 'reply-footer';

  const charCount = document.createElement('span');
  charCount.className = 'char-count';
  charCount.textContent = `0 / ${MAX_COMMENT_LENGTH}`;

  const submitWrap = document.createElement('div');
  submitWrap.className = 'reply-submit-wrap';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-cancel-reply';
  cancelBtn.textContent = 'キャンセル';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn-submit-reply';
  submitBtn.innerHTML = '&#128172; 送信';
  submitBtn.disabled = true;

  submitWrap.appendChild(cancelBtn);
  submitWrap.appendChild(submitBtn);

  footer.appendChild(charCount);
  footer.appendChild(submitWrap);

  inputArea.appendChild(textarea);
  inputArea.appendChild(footer);

  panel.appendChild(history);
  panel.appendChild(inputArea);
  td.appendChild(panel);
  tr.appendChild(td);

  // ── イベント ──────────────────────────────────────────────────────────────

  // 文字数カウンター & 送信ボタン制御
  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    charCount.textContent = `${len} / ${MAX_COMMENT_LENGTH}`;
    charCount.className = len >= MAX_COMMENT_LENGTH
      ? 'char-count at-limit'
      : len >= MAX_COMMENT_LENGTH * 0.9
        ? 'char-count near-limit'
        : 'char-count';
    submitBtn.disabled = len === 0 || len > MAX_COMMENT_LENGTH;
  });

  // Ctrl+Enter で送信
  textarea.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !submitBtn.disabled) {
      e.preventDefault();
      submitComment(issueId, textarea, submitBtn, history);
    }
  });

  // 送信ボタン
  submitBtn.addEventListener('click', () => {
    submitComment(issueId, textarea, submitBtn, history);
  });

  // キャンセル
  cancelBtn.addEventListener('click', () => {
    const issueRow = document.querySelector(`tr.issue-row[data-issue-id="${CSS.escape(issueId)}"]`);
    closeReplyPanel(issueId, issueRow, tr);
  });

  return tr;
}

// ─── 返信パネル 開閉 ────────────────────────────────────────────────────────

/**
 * 返信パネルの開閉をトグルする
 * @param {string} issueId
 * @param {HTMLTableRowElement} issueRow
 */
function toggleReplyPanel(issueId, issueRow) {
  const replyRow = document.querySelector(`tr.reply-row[data-reply-for="${CSS.escape(issueId)}"]`);
  if (!replyRow) return;

  if (openReplyPanels.has(issueId)) {
    closeReplyPanel(issueId, issueRow, replyRow);
  } else {
    openReplyPanel(issueId, issueRow, replyRow);
  }
}

function openReplyPanel(issueId, issueRow, replyRow) {
  openReplyPanels.add(issueId);
  issueRow.classList.add('has-reply-open');
  issueRow.querySelector('.btn-reply')?.classList.add('active');
  show(replyRow);

  // コメント履歴を非同期取得
  loadCommentHistory(issueId);

  // テキストエリアにフォーカス
  const textarea = replyRow.querySelector('.reply-textarea');
  textarea?.focus();
}

function closeReplyPanel(issueId, issueRow, replyRow) {
  openReplyPanels.delete(issueId);
  issueRow?.classList.remove('has-reply-open');
  issueRow?.querySelector('.btn-reply')?.classList.remove('active');
  hide(replyRow);

  // 入力内容をクリア
  const textarea = replyRow.querySelector('.reply-textarea');
  if (textarea) {
    textarea.value = '';
    textarea.dispatchEvent(new Event('input'));
  }
}

// ─── コメント読み込み ────────────────────────────────────────────────────────

/**
 * コメント履歴を取得して表示する
 * @param {string} issueId
 */
async function loadCommentHistory(issueId) {
  const historyEl = document.getElementById(`ch-${issueId}`);
  if (!historyEl) return;

  historyEl.innerHTML = '<div class="comment-loading"><div class="spinner-sm"></div><span>コメントを読み込み中...</span></div>';

  const res = await sendMessage({
    type: 'FETCH_COMMENTS',
    payload: { projectId: selProject.value, issueId },
  });

  if (res.error) {
    historyEl.innerHTML = `<div class="inline-error">コメントの取得に失敗: ${escHtml(res.message ?? res.error)}</div>`;
    return;
  }

  renderCommentHistory(historyEl, res.data ?? []);
}

/**
 * コメント一覧を履歴エリアに描画する
 * @param {HTMLElement} container
 * @param {Comment[]} comments
 * @param {boolean} [animate=false]
 */
function renderCommentHistory(container, comments, animate = false) {
  if (comments.length === 0) {
    container.innerHTML = '<div class="comment-empty">コメントはまだありません</div>';
    return;
  }

  container.innerHTML = '';
  // 最新順（新しいものが上）で表示
  [...comments].reverse().forEach((c, i) => {
    const item = buildCommentItem(c, animate && i === 0);
    container.appendChild(item);
  });
}

/**
 * コメント要素を生成する
 * @param {Comment} comment
 * @param {boolean} [isNew=false]
 * @returns {HTMLElement}
 */
function buildCommentItem(comment, isNew = false) {
  const div = document.createElement('div');
  div.className = isNew ? 'comment-item comment-new' : 'comment-item';

  const authorName = comment.createdBy?.name
    ?? comment.createdBy?.email
    ?? comment.createdBy?.userId
    ?? '不明';
  const dateStr = comment.createdAt ? formatDateTime(comment.createdAt) : '';

  const meta = document.createElement('div');
  meta.className = 'comment-meta';
  meta.innerHTML = `
    <span class="comment-author">${escHtml(authorName)}</span>
    <span class="comment-date">${escHtml(dateStr)}</span>`;

  const body = document.createElement('div');
  body.className = 'comment-body';
  body.textContent = comment.body ?? '';  // textContent は XSS-safe

  div.appendChild(meta);
  div.appendChild(body);
  return div;
}

// ─── コメント送信 ────────────────────────────────────────────────────────────

/**
 * コメントを投稿する（連続投稿可能 - パネルは閉じない）
 * @param {string} issueId
 * @param {HTMLTextAreaElement} textarea
 * @param {HTMLButtonElement} submitBtn
 * @param {HTMLElement} historyEl
 */
async function submitComment(issueId, textarea, submitBtn, historyEl) {
  const body = textarea.value.trim();
  if (!body) return;

  // 送信中の UI
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<div class="spinner-sm"></div> 送信中...';
  textarea.disabled = true;

  // 既存のインラインエラーを除去
  historyEl.querySelector('.inline-error')?.remove();

  const res = await sendMessage({
    type: 'POST_COMMENT',
    payload: { projectId: selProject.value, issueId, body },
  });

  submitBtn.innerHTML = '&#128172; 送信';
  textarea.disabled = false;

  if (res.error) {
    // エラーをパネル内に表示（テキスト保持）
    const errEl = document.createElement('div');
    errEl.className = 'inline-error';
    errEl.textContent = `送信失敗: ${res.message ?? res.error}`;
    historyEl.insertAdjacentElement('beforebegin', errEl);
    submitBtn.disabled = false;
    return;
  }

  // 送信成功 ─ textarea をクリアして送信ボタンを無効化
  textarea.value = '';
  textarea.dispatchEvent(new Event('input')); // char-count リセット

  // 新しいコメントを履歴の先頭に追加（ページネーション不要）
  const emptyMsg = historyEl.querySelector('.comment-empty');
  if (emptyMsg) emptyMsg.remove();

  const newItem = buildCommentItem(res.data, /* isNew */ true);
  historyEl.insertAdjacentElement('afterbegin', newItem);

  // 成功トースト（行内・2秒後に消える）
  const toast = document.createElement('span');
  toast.className = 'inline-toast';
  toast.textContent = '✓ 送信しました';
  submitBtn.parentElement?.insertAdjacentElement('afterbegin', toast);
  setTimeout(() => toast.remove(), 2200);

  textarea.focus();
}

// ─── 詳細ビュー描画 ──────────────────────────────────────────────────────────
function renderIssueDetail(issue) {
  detailContainer.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'detail-card';

  const statusLabel = STATUS_LABELS[issue.status] ?? issue.status ?? '不明';
  const badgeClass  = `badge-${issue.status ?? 'default'}`;

  const fields = [
    { label: 'ステータス', value: `<span class="badge ${badgeClass}">${statusLabel}</span>` },
    { label: '担当者',     value: escHtml(issue.assignedTo ?? '-') },
    { label: '期限',       value: issue.dueDate ? formatDate(issue.dueDate) : '-' },
    { label: '作成日',     value: formatDate(issue.createdAt) },
    { label: '更新日',     value: formatDate(issue.updatedAt) },
    { label: 'ID',         value: `<code style="font-size:10px">${escHtml(issue.id)}</code>` },
  ];

  card.innerHTML = `
    <div class="detail-title">${escHtml(issue.title ?? issue.id)}</div>
    <div class="detail-fields">
      ${fields.map(f => `
        <div class="detail-field">
          <label>${f.label}</label>
          <span>${f.value}</span>
        </div>`).join('')}
    </div>
    ${issue.description ? `
      <div style="margin-top:12px">
        <div class="detail-field">
          <label>説明</label>
          <span style="white-space:pre-wrap;line-height:1.5">${escHtml(issue.description)}</span>
        </div>
      </div>` : ''}`;

  detailContainer.appendChild(card);
}

// ─── ユーティリティ ──────────────────────────────────────────────────────────

/**
 * サービスワーカーにメッセージを送信してレスポンスを返す
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

function show(...elements)  { elements.forEach(el => el?.classList.remove('hidden')); }
function hide(...elements)  { elements.forEach(el => el?.classList.add('hidden')); }

function setLoading(on, text = '読み込み中...') {
  loadingText.textContent = text;
  on ? show(viewLoading) : hide(viewLoading);
}

function clearIssues() {
  issuesContainer.innerHTML = '';
  openReplyPanels.clear();
  currentPage = { projectId: null, offset: 0, total: 0, limit: 20 };
  // 検索バーをリセット
  inputSearch.value = '';
  btnSearchClear.classList.add('hidden');
  clearTimeout(searchDebounceTimer);
}

function showError(container, message) {
  const box = document.createElement('div');
  box.className = 'error-box';
  box.innerHTML = `<span class="error-msg">&#9888; ${escHtml(message)}</span>`;
  container.appendChild(box);
}

/**
 * XSS 対策: innerHTML 用 HTML エスケープ
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
 * XSS 対策: 属性値用エスケープ
 * @param {string} str
 * @returns {string}
 */
function escAttr(str) {
  return escHtml(str).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
}

/**
 * 期限日 HTML を生成する（過期の場合は赤字）
 * @param {string|null} dueDate
 * @returns {string}
 */
function buildDueDateHtml(dueDate) {
  if (!dueDate) return '-';
  const formatted = formatDate(dueDate);
  const isOverdue = new Date(dueDate) < new Date() && new Date(dueDate).toDateString() !== new Date().toDateString();
  return isOverdue
    ? `<span class="overdue" title="期限超過">${escHtml(formatted)}</span>`
    : escHtml(formatted);
}

/**
 * ISO 8601 → ローカル日付 (yyyy/mm/dd)
 */
function formatDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleDateString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
  } catch { return iso; }
}

/**
 * ISO 8601 → ローカル日時 (yyyy/mm/dd HH:MM)
 */
function formatDateTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

// ─── 検索バー イベント ───────────────────────────────────────────────────────

inputSearch.addEventListener('input', () => {
  // クリアボタンの表示切り替え
  btnSearchClear.classList.toggle('hidden', inputSearch.value.length === 0);

  // 200ms デバウンスでフィルター適用（高速タイピング時のちらつき防止）
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => applySearchFilter(inputSearch.value), 200);
});

// Escape キーで検索クリア
inputSearch.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    inputSearch.value = '';
    btnSearchClear.classList.add('hidden');
    applySearchFilter('');
  }
});

btnSearchClear.addEventListener('click', () => {
  inputSearch.value = '';
  btnSearchClear.classList.add('hidden');
  applySearchFilter('');
  inputSearch.focus();
});

// ─── 起動 ────────────────────────────────────────────────────────────────────
init();
