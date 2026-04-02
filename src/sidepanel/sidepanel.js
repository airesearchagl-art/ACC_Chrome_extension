/**
 * ACC Chrome Extension - Side Panel UI
 *
 * セキュリティ: escHtml() をすべてのユーザーデータ挿入箇所に適用
 * データ保持: メモリ上のみ（DOM + JS 変数）
 */

'use strict';

// ─── 定数 ────────────────────────────────────────────────────────────────────

const QUICK_REPLIES = [
  { label: '確認済',       text: '確認済みです。' },
  { label: '是正完了',     text: '是正が完了しました。' },
  { label: '次回定例で',   text: '次回定例にて確認します。' },
];

const STATUS_LABEL = {
  open:           '未対応',
  pending:        '保留中',
  in_progress:    '対応中',
  work_completed: '作業完了',
  answered:       '回答済',
  not_approved:   '否認',
  closed:         '完了',
  void:           '無効',
  draft:          '下書き',
};

const MAX_COMMENT_LEN = 10000;

// ─── 状態 ────────────────────────────────────────────────────────────────────

let currentProjectId = null;
let allIssues        = [];
let openReplyPanels  = new Set(); // issueId
let selectedIssues   = new Set(); // issueId
let searchDebounce   = null;
let isBulkWorking    = false;

// ─── DOM 参照 ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const btnLogin       = $('btn-login');
const btnLogout      = $('btn-logout');
const selHub         = $('sel-hub');
const selProject     = $('sel-project');
const selStatus      = $('sel-status');
const btnReload      = $('btn-reload');
const inputSearch    = $('input-search');
const btnSearchClear = $('btn-search-clear');
const issuesContainer= $('issues-container');
const bulkBar        = $('bulk-bar');
const bulkCount      = $('bulk-count');
const btnSelectAll   = $('btn-select-all');
const btnDeselectAll = $('btn-deselect-all');
const btnBulkAnswered= $('btn-bulk-answered');
const btnBack        = $('btn-back');
const detailContainer= $('detail-container');
const loadingText    = $('loading-text');

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendMessage(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function showView(id) {
  for (const v of ['view-login', 'view-main', 'view-detail', 'view-loading']) {
    $(v).classList.toggle('hidden', v !== id);
  }
}

function showLoading(text = '読み込み中...') {
  loadingText.textContent = text;
  showView('view-loading');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function isOverdue(iso) {
  if (!iso) return false;
  return new Date(iso) < new Date();
}

// ─── トースト ─────────────────────────────────────────────────────────────────

function showToast(msg, duration = 2400) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('toast-show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove('toast-show');
  }, duration);
}

// ─── 初期化 ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  showLoading('認証確認中...');
  try {
    const res = await sendMessage('AUTH_STATUS');
    if (res?.data?.authenticated) {
      await initMainView();
    } else {
      showView('view-login');
    }
  } catch {
    showView('view-login');
  }

  // イベントリスナー
  btnLogin.addEventListener('click', handleLogin);
  btnLogout.addEventListener('click', handleLogout);
  btnReload.addEventListener('click', () => loadIssues());
  btnBack.addEventListener('click', () => showView('view-main'));
  btnSelectAll.addEventListener('click', handleSelectAll);
  btnDeselectAll.addEventListener('click', handleDeselectAll);
  btnBulkAnswered.addEventListener('click', () => bulkPatchStatus('answered'));

  // 検索
  inputSearch.addEventListener('input', () => {
    const q = inputSearch.value.trim();
    btnSearchClear.classList.toggle('hidden', q.length === 0);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => applySearchFilter(q), 200);
  });
  btnSearchClear.addEventListener('click', () => {
    inputSearch.value = '';
    btnSearchClear.classList.add('hidden');
    applySearchFilter('');
    inputSearch.focus();
  });

  // ハブ選択
  selHub.addEventListener('change', async () => {
    const hubId = selHub.value;
    selProject.innerHTML = '<option value="">プロジェクトを選択...</option>';
    selProject.disabled = true;
    clearIssues();
    if (!hubId) return;
    await loadProjects(hubId);
  });

  // プロジェクト選択
  selProject.addEventListener('change', () => {
    currentProjectId = selProject.value || null;
    clearIssues();
    if (currentProjectId) loadIssues();
  });

  // ステータスフィルター
  selStatus.addEventListener('change', () => {
    if (currentProjectId) loadIssues();
  });
});

// ─── 認証 ────────────────────────────────────────────────────────────────────

async function handleLogin() {
  btnLogin.disabled = true;
  btnLogin.innerHTML = '<span class="spinner-sm"></span> 認証中...';
  try {
    const res = await sendMessage('AUTH_START');
    if (res?.data?.authenticated) {
      await initMainView();
    } else {
      showView('view-login');
      alert('認証に失敗しました: ' + (res?.message ?? res?.error ?? '不明なエラー'));
    }
  } catch (err) {
    showView('view-login');
    alert('認証エラー: ' + err.message);
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = 'Autodesk でログイン';
  }
}

async function handleLogout() {
  showLoading('ログアウト中...');
  await sendMessage('LOGOUT').catch(() => {});
  clearIssues();
  currentProjectId = null;
  selHub.innerHTML = '<option value="">ハブを選択...</option>';
  selProject.innerHTML = '<option value="">プロジェクトを選択...</option>';
  selProject.disabled = true;
  btnLogout.classList.add('hidden');
  showView('view-login');
}

// ─── メインビュー初期化 ───────────────────────────────────────────────────────

async function initMainView() {
  btnLogout.classList.remove('hidden');
  showView('view-main');
  await loadHubs();
}

// ─── ハブ・プロジェクト ───────────────────────────────────────────────────────

async function loadHubs() {
  selHub.disabled = true;
  selHub.innerHTML = '<option value="">読み込み中...</option>';
  try {
    const res = await sendMessage('FETCH_HUBS');
    if (res?.error) throw new Error(res.message ?? res.error);
    const hubs = res.data ?? [];
    selHub.innerHTML = '<option value="">ハブを選択...</option>';
    for (const h of hubs) {
      const opt = document.createElement('option');
      opt.value = h.id;
      opt.textContent = h.name;
      selHub.appendChild(opt);
    }
    if (hubs.length === 1) {
      selHub.value = hubs[0].id;
      selHub.dispatchEvent(new Event('change'));
    }
  } catch (err) {
    selHub.innerHTML = `<option value="">エラー: ${escHtml(err.message)}</option>`;
  } finally {
    selHub.disabled = false;
  }
}

async function loadProjects(hubId) {
  selProject.disabled = true;
  selProject.innerHTML = '<option value="">読み込み中...</option>';
  try {
    const res = await sendMessage('FETCH_PROJECTS', { hubId });
    if (res?.error) throw new Error(res.message ?? res.error);
    const projects = res.data ?? [];
    selProject.innerHTML = '<option value="">プロジェクトを選択...</option>';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      selProject.appendChild(opt);
    }
    selProject.disabled = false;
    if (projects.length === 1) {
      selProject.value = projects[0].id;
      selProject.dispatchEvent(new Event('change'));
    }
  } catch (err) {
    selProject.innerHTML = `<option value="">エラー: ${escHtml(err.message)}</option>`;
    selProject.disabled = false;
  }
}

// ─── 指摘一覧 ─────────────────────────────────────────────────────────────────

async function loadIssues() {
  if (!currentProjectId) return;
  clearIssues();
  issuesContainer.innerHTML = '<div class="view-loading" style="display:flex;align-items:center;justify-content:center;gap:10px;padding:32px;color:var(--text-muted)"><div class="spinner"></div><span>指摘を読み込み中...</span></div>';

  const filter = {};
  if (selStatus.value) filter.status = selStatus.value;

  try {
    const res = await sendMessage('FETCH_ISSUES', { projectId: currentProjectId, filter });
    if (res?.error) throw new Error(res.message ?? res.error);
    allIssues = res.data?.issues ?? res.data ?? [];
    renderIssues(allIssues);
    applySearchFilter(inputSearch.value.trim());
  } catch (err) {
    issuesContainer.innerHTML = `
      <div class="error-box">
        <div class="error-msg">指摘の取得に失敗しました</div>
        <div style="font-size:11px;margin-top:4px;color:var(--text-sub)">${escHtml(err.message)}</div>
      </div>`;
  }
}

function clearIssues() {
  allIssues = [];
  openReplyPanels.clear();
  selectedIssues.clear();
  updateBulkBar();
  issuesContainer.innerHTML = '';
}

// ─── テーブルレンダリング ─────────────────────────────────────────────────────

function renderIssues(issues) {
  if (!issues || issues.length === 0) {
    issuesContainer.innerHTML = '<div class="empty">指摘事項はありません</div>';
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrapper';

  const table = document.createElement('table');
  table.className = 'issues-table';
  table.innerHTML = `
    <colgroup>
      <col class="col-check"><col class="col-title"><col class="col-status">
      <col class="col-assign"><col class="col-due"><col class="col-attach"><col class="col-reply">
    </colgroup>
    <thead>
      <tr>
        <th class="col-check"><input type="checkbox" id="chk-all" title="全選択" style="cursor:pointer;width:14px;height:14px;accent-color:var(--primary)"></th>
        <th>タイトル</th>
        <th>状態</th>
        <th>担当</th>
        <th>期限</th>
        <th title="添付ファイル">📎</th>
        <th></th>
      </tr>
    </thead>`;

  const tbody = document.createElement('tbody');
  tbody.id = 'issues-tbody';

  for (const issue of issues) {
    tbody.appendChild(createIssueRow(issue));
  }

  // 検索一致なし行
  const noMatch = document.createElement('tr');
  noMatch.id = 'tr-no-match';
  noMatch.className = 'search-no-match hidden';
  noMatch.innerHTML = '<td colspan="7">一致する指摘事項が見つかりません</td>';
  tbody.appendChild(noMatch);

  table.appendChild(tbody);
  wrapper.appendChild(table);
  issuesContainer.innerHTML = '';
  issuesContainer.appendChild(wrapper);

  // 件数表示
  const header = document.createElement('div');
  header.className = 'issues-header';
  header.innerHTML = `<span class="issues-count" id="issues-count">${escHtml(String(issues.length))} 件</span>`;
  issuesContainer.insertBefore(header, wrapper);

  // 全選択チェックボックス
  const chkAll = document.getElementById('chk-all');
  chkAll.addEventListener('change', () => {
    const rows = tbody.querySelectorAll('.row-checkbox');
    rows.forEach(cb => {
      if (!cb.closest('tr').classList.contains('hidden')) {
        cb.checked = chkAll.checked;
        handleCheckboxChange(cb.dataset.issueId, chkAll.checked);
      }
    });
  });
}

function createIssueRow(issue) {
  const id      = issue.id ?? '';
  const title   = issue.title ?? issue.attributes?.title ?? '(タイトルなし)';
  const status  = issue.status ?? issue.attributes?.status ?? '';
  const assignee= issue.assignedTo?.name ?? issue.attributes?.assignedTo ?? '';
  const dueDate = issue.dueDate ?? issue.attributes?.dueDate ?? null;
  const attachCount = issue.attachmentsCount ?? issue.attributes?.attachmentsCount ?? 0;

  const tr = document.createElement('tr');
  tr.className = 'issue-row';
  tr.dataset.issueId = id;
  tr.dataset.searchTitle  = title.toLowerCase();
  tr.dataset.searchAssign = assignee.toLowerCase();

  // ── チェックボックス ──
  const tdCheck = document.createElement('td');
  tdCheck.className = 'td-check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'row-checkbox';
  cb.dataset.issueId = id;
  cb.addEventListener('change', () => handleCheckboxChange(id, cb.checked));
  tdCheck.appendChild(cb);
  tr.appendChild(tdCheck);

  // ── タイトル ──
  const tdTitle = document.createElement('td');
  tdTitle.className = 'td-title';
  tdTitle.title = title;
  tdTitle.textContent = title;
  tdTitle.addEventListener('click', () => loadIssueDetail(id));
  tr.appendChild(tdTitle);

  // ── ステータス ──
  const tdStatus = document.createElement('td');
  const badgeClass = `badge badge-${escHtml(status) || 'default'}`;
  const badgeLabel = STATUS_LABEL[status] ?? status;
  tdStatus.innerHTML = `<span class="${escHtml(badgeClass)}">${escHtml(badgeLabel)}</span>`;
  tr.appendChild(tdStatus);

  // ── 担当者 ──
  const tdAssign = document.createElement('td');
  tdAssign.className = 'td-assign';
  tdAssign.title = assignee;
  tdAssign.textContent = assignee || '—';
  tr.appendChild(tdAssign);

  // ── 期限 ──
  const tdDue = document.createElement('td');
  tdDue.className = 'td-due';
  if (dueDate) {
    const span = document.createElement('span');
    if (isOverdue(dueDate)) span.className = 'overdue';
    span.textContent = formatDate(dueDate);
    tdDue.appendChild(span);
  } else {
    tdDue.textContent = '—';
  }
  tr.appendChild(tdDue);

  // ── 添付数 ──
  const tdAttach = document.createElement('td');
  tdAttach.className = 'td-attach';
  if (attachCount > 0) {
    const span = document.createElement('span');
    span.className = 'attach-count';
    span.textContent = `📎${attachCount}`;
    span.title = `${attachCount}件の添付あり`;
    tdAttach.appendChild(span);
  } else {
    tdAttach.textContent = '';
  }
  tr.appendChild(tdAttach);

  // ── 返信ボタン ──
  const tdReply = document.createElement('td');
  const btnReply = document.createElement('button');
  btnReply.className = 'btn-reply';
  btnReply.textContent = '💬';
  btnReply.title = 'コメントを返信';
  btnReply.addEventListener('click', () => toggleReplyPanel(tr, issue));
  tdReply.appendChild(btnReply);
  tr.appendChild(tdReply);

  return tr;
}

function createReplyRow(issue, btnReply) {
  const id = issue.id ?? '';
  const replyTr = document.createElement('tr');
  replyTr.className = 'reply-row';
  replyTr.dataset.replyFor = id;

  const td = document.createElement('td');
  td.colSpan = 7;

  const panel = document.createElement('div');
  panel.className = 'reply-panel';

  // ── 定型文ボタン ──
  const qrDiv = document.createElement('div');
  qrDiv.className = 'quick-replies';
  const qrLabel = document.createElement('span');
  qrLabel.className = 'quick-replies-label';
  qrLabel.textContent = '定型文:';
  qrDiv.appendChild(qrLabel);

  // ── コメント履歴 ──
  const historyDiv = document.createElement('div');
  historyDiv.className = 'comment-history';
  historyDiv.innerHTML = '<div class="comment-loading"><div class="spinner-sm"></div><span>コメント読み込み中...</span></div>';

  // ── テキストエリア ──
  const inputArea = document.createElement('div');
  inputArea.className = 'reply-input-area';

  const textarea = document.createElement('textarea');
  textarea.className = 'reply-textarea';
  textarea.placeholder = 'コメントを入力...';
  textarea.maxLength = MAX_COMMENT_LEN;

  const footer = document.createElement('div');
  footer.className = 'reply-footer';

  const charCount = document.createElement('span');
  charCount.className = 'char-count';
  charCount.textContent = `0 / ${MAX_COMMENT_LEN}`;

  const submitWrap = document.createElement('div');
  submitWrap.className = 'reply-submit-wrap';

  const btnSubmit = document.createElement('button');
  btnSubmit.className = 'btn-submit-reply';
  btnSubmit.textContent = '送信';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn-cancel-reply';
  btnCancel.textContent = 'キャンセル';

  submitWrap.appendChild(btnCancel);
  submitWrap.appendChild(btnSubmit);
  footer.appendChild(charCount);
  footer.appendChild(submitWrap);
  inputArea.appendChild(textarea);
  inputArea.appendChild(footer);

  // 定型文ボタン生成（textarea 参照が必要なので後に作成）
  for (const qr of QUICK_REPLIES) {
    const btn = document.createElement('button');
    btn.className = 'btn-qr';
    btn.textContent = qr.label;
    btn.addEventListener('click', () => {
      textarea.value = qr.text;
      updateCharCount();
      textarea.focus();
      // 自動送信
      btnSubmit.click();
    });
    qrDiv.appendChild(btn);
  }

  panel.appendChild(qrDiv);
  panel.appendChild(historyDiv);
  panel.appendChild(inputArea);
  td.appendChild(panel);
  replyTr.appendChild(td);

  // 文字数カウント
  function updateCharCount() {
    const len = textarea.value.length;
    charCount.textContent = `${len} / ${MAX_COMMENT_LEN}`;
    charCount.className = 'char-count' + (len >= MAX_COMMENT_LEN ? ' at-limit' : len >= MAX_COMMENT_LEN * 0.9 ? ' near-limit' : '');
  }
  textarea.addEventListener('input', updateCharCount);

  // 送信
  btnSubmit.addEventListener('click', async () => {
    await submitComment(issue, textarea, panel, historyDiv, qrDiv, btnSubmit, btnCancel, btnReply);
  });

  // キャンセル
  btnCancel.addEventListener('click', () => {
    closeReplyPanel(replyTr, issue.id, btnReply);
  });

  return replyTr;
}

// ─── 返信パネル ───────────────────────────────────────────────────────────────

function toggleReplyPanel(issueRow, issue) {
  const id = issue.id ?? '';
  const btnReplyEl = issueRow.querySelector('.btn-reply');

  if (openReplyPanels.has(id)) {
    const existing = issueRow.nextSibling;
    if (existing?.dataset?.replyFor === id) {
      existing.remove();
    }
    openReplyPanels.delete(id);
    issueRow.classList.remove('has-reply-open');
    btnReplyEl?.classList.remove('active');
    return;
  }

  openReplyPanels.add(id);
  issueRow.classList.add('has-reply-open');
  btnReplyEl?.classList.add('active');

  const replyTr = createReplyRow(issue, btnReplyEl);
  issueRow.insertAdjacentElement('afterend', replyTr);

  // コメント履歴を非同期ロード
  const historyDiv = replyTr.querySelector('.comment-history');
  loadCommentHistory(issue, historyDiv);
}

function closeReplyPanel(replyTr, issueId, btnReply) {
  const issueRow = replyTr.previousSibling;
  replyTr.remove();
  openReplyPanels.delete(issueId);
  issueRow?.classList.remove('has-reply-open');
  btnReply?.classList.remove('active');
}

async function loadCommentHistory(issue, historyDiv) {
  if (!currentProjectId) return;
  try {
    const res = await sendMessage('FETCH_COMMENTS', {
      projectId: currentProjectId,
      issueId: issue.id,
    });
    if (res?.error) throw new Error(res.message ?? res.error);
    const comments = res.data ?? [];
    renderCommentHistory(historyDiv, comments);
  } catch (err) {
    historyDiv.innerHTML = `<div class="inline-error">コメント取得失敗: ${escHtml(err.message)}</div>`;
  }
}

function renderCommentHistory(historyDiv, comments) {
  historyDiv.innerHTML = '';
  if (!comments.length) {
    historyDiv.innerHTML = '<div class="comment-empty">コメントはありません</div>';
    return;
  }
  for (const c of comments) {
    historyDiv.appendChild(buildCommentItem(c));
  }
  historyDiv.scrollTop = historyDiv.scrollHeight;
}

function buildCommentItem(comment, isNew = false) {
  const div = document.createElement('div');
  div.className = 'comment-item' + (isNew ? ' comment-new' : '');

  const meta = document.createElement('div');
  meta.className = 'comment-meta';

  const author = document.createElement('span');
  author.className = 'comment-author';
  author.textContent = comment.createdBy?.name ?? comment.author ?? '不明';

  const date = document.createElement('span');
  date.className = 'comment-date';
  date.textContent = formatDate(comment.createdAt ?? comment.created_at);

  meta.appendChild(author);
  meta.appendChild(date);

  const body = document.createElement('div');
  body.className = 'comment-body';
  body.textContent = comment.body ?? comment.text ?? '';

  div.appendChild(meta);
  div.appendChild(body);
  return div;
}

// ─── コメント送信 ─────────────────────────────────────────────────────────────

async function submitComment(issue, textarea, panel, historyDiv, qrDiv, btnSubmit, btnCancel, btnReply) {
  const text = textarea.value.trim();
  if (!text) {
    textarea.focus();
    return;
  }
  if (!currentProjectId) return;

  // ダブル送信防止: パネル全体を無効化
  const allControls = panel.querySelectorAll('button, textarea, input');
  allControls.forEach(el => { el.disabled = true; });
  btnSubmit.innerHTML = '<span class="spinner-sm"></span> 送信中...';

  // インラインフィードバック削除
  panel.querySelectorAll('.inline-toast, .inline-error').forEach(el => el.remove());

  try {
    const res = await sendMessage('POST_COMMENT', {
      projectId: currentProjectId,
      issueId:   issue.id,
      body:      text,
    });
    if (res?.error) throw new Error(res.message ?? res.error);

    // 成功: テキストエリアをクリア
    textarea.value = '';
    panel.querySelector('.char-count').textContent = `0 / ${MAX_COMMENT_LEN}`;
    panel.querySelector('.char-count').className = 'char-count';

    // 新しいコメントを履歴に追加
    if (res.data) {
      const newItem = buildCommentItem(res.data, true);
      const emptyEl = historyDiv.querySelector('.comment-empty');
      if (emptyEl) emptyEl.remove();
      historyDiv.appendChild(newItem);
      historyDiv.scrollTop = historyDiv.scrollHeight;
    }

    // 成功トースト（インライン）
    const toast = document.createElement('span');
    toast.className = 'inline-toast';
    toast.textContent = '✓ 送信しました';
    panel.querySelector('.reply-footer').appendChild(toast);
    setTimeout(() => toast.remove(), 2200);

  } catch (err) {
    const errEl = document.createElement('div');
    errEl.className = 'inline-error';
    errEl.textContent = '送信失敗: ' + err.message;
    panel.querySelector('.reply-input-area').insertBefore(errEl, textarea);
    setTimeout(() => errEl.remove(), 4000);
  } finally {
    // コントロールを再有効化
    allControls.forEach(el => { el.disabled = false; });
    btnSubmit.textContent = '送信';
    textarea.focus();
  }
}

// ─── チェックボックス・一括操作 ───────────────────────────────────────────────

function handleCheckboxChange(issueId, checked) {
  if (checked) {
    selectedIssues.add(issueId);
  } else {
    selectedIssues.delete(issueId);
  }
  updateBulkBar();
}

function updateBulkBar() {
  const count = selectedIssues.size;
  bulkCount.textContent = String(count);
  bulkBar.classList.toggle('hidden', count === 0);
}

function handleSelectAll() {
  const visibleCbs = document.querySelectorAll('#issues-tbody .row-checkbox');
  visibleCbs.forEach(cb => {
    const tr = cb.closest('tr');
    if (tr && !tr.classList.contains('hidden')) {
      cb.checked = true;
      handleCheckboxChange(cb.dataset.issueId, true);
    }
  });
}

function handleDeselectAll() {
  document.querySelectorAll('#issues-tbody .row-checkbox').forEach(cb => {
    cb.checked = false;
  });
  const chkAll = document.getElementById('chk-all');
  if (chkAll) chkAll.checked = false;
  selectedIssues.clear();
  updateBulkBar();
}

async function bulkPatchStatus(status) {
  if (selectedIssues.size === 0 || !currentProjectId || isBulkWorking) return;

  isBulkWorking = true;
  const ids = [...selectedIssues];

  // UI を無効化
  btnBulkAnswered.disabled = true;
  btnSelectAll.disabled    = true;
  btnDeselectAll.disabled  = true;
  btnBulkAnswered.innerHTML = '<span class="spinner-sm"></span> 処理中...';

  try {
    const res = await sendMessage('BULK_PATCH_STATUS', {
      projectId: currentProjectId,
      issueIds:  ids,
      status,
    });
    if (res?.error) throw new Error(res.message ?? res.error);

    const { updated = 0, failed = 0 } = res.data ?? {};
    const msg = failed > 0
      ? `✓ ${updated}件を更新（${failed}件失敗）`
      : `✓ ${updated}件を回答済に更新しました`;
    showToast(msg);

    // 一覧を再取得
    handleDeselectAll();
    await loadIssues();
  } catch (err) {
    showToast('一括更新失敗: ' + err.message, 3500);
  } finally {
    isBulkWorking = false;
    btnBulkAnswered.disabled = false;
    btnSelectAll.disabled    = false;
    btnDeselectAll.disabled  = false;
    btnBulkAnswered.textContent = '✓ 回答済にする';
  }
}

// ─── 検索フィルター ───────────────────────────────────────────────────────────

function applySearchFilter(query) {
  const tbody = document.getElementById('issues-tbody');
  if (!tbody) return;

  const noMatch = document.getElementById('tr-no-match');
  const countEl = document.getElementById('issues-count');

  if (!query) {
    let visible = 0;
    tbody.querySelectorAll('.issue-row').forEach(tr => {
      tr.classList.remove('hidden');
      // 返信行も表示
      const next = tr.nextSibling;
      if (next?.dataset?.replyFor) next.classList.remove('hidden');
      visible++;
    });
    if (noMatch) noMatch.classList.add('hidden');
    if (countEl) countEl.innerHTML = `${escHtml(String(visible))} 件`;
    return;
  }

  const q = query.toLowerCase();
  let visible = 0;

  tbody.querySelectorAll('.issue-row').forEach(tr => {
    const titleMatch  = (tr.dataset.searchTitle  ?? '').includes(q);
    const assignMatch = (tr.dataset.searchAssign ?? '').includes(q);
    const show = titleMatch || assignMatch;
    tr.classList.toggle('hidden', !show);
    // 返信行は親に連動
    const next = tr.nextSibling;
    if (next?.dataset?.replyFor) next.classList.toggle('hidden', !show);
    if (show) visible++;
  });

  if (noMatch) noMatch.classList.toggle('hidden', visible > 0);
  if (countEl) {
    countEl.innerHTML = `${escHtml(String(visible))} 件 <span class="match-badge">"${escHtml(query)}"</span>`;
  }
}

// ─── 詳細ビュー ───────────────────────────────────────────────────────────────

async function loadIssueDetail(issueId) {
  if (!currentProjectId) return;
  showLoading('詳細を読み込み中...');
  try {
    const res = await sendMessage('FETCH_ISSUE_DETAIL', {
      projectId: currentProjectId,
      issueId,
    });
    if (res?.error) throw new Error(res.message ?? res.error);
    renderIssueDetail(res.data);
  } catch (err) {
    detailContainer.innerHTML = `<div class="error-box"><div class="error-msg">詳細の取得に失敗しました</div><div style="font-size:11px;margin-top:4px">${escHtml(err.message)}</div></div>`;
    showView('view-detail');
  }
}

function renderIssueDetail(issue) {
  if (!issue) {
    detailContainer.innerHTML = '<div class="empty">データがありません</div>';
    showView('view-detail');
    return;
  }

  const title      = issue.title ?? issue.attributes?.title ?? '(タイトルなし)';
  const status     = issue.status ?? issue.attributes?.status ?? '';
  const assignee   = issue.assignedTo?.name ?? issue.attributes?.assignedTo ?? '—';
  const dueDate    = formatDate(issue.dueDate ?? issue.attributes?.dueDate);
  const createdAt  = formatDate(issue.createdAt ?? issue.attributes?.createdAt);
  const desc       = issue.description ?? issue.attributes?.description ?? '';
  const badgeClass = `badge badge-${status || 'default'}`;
  const badgeLabel = STATUS_LABEL[status] ?? status;

  detailContainer.innerHTML = `
    <div class="detail-card">
      <div class="detail-title">${escHtml(title)}</div>
      <div style="margin-bottom:10px"><span class="${escHtml(badgeClass)}">${escHtml(badgeLabel)}</span></div>
      <div class="detail-fields">
        <div class="detail-field"><label>担当者</label><span>${escHtml(assignee)}</span></div>
        <div class="detail-field"><label>期限日</label><span>${escHtml(dueDate)}</span></div>
        <div class="detail-field"><label>作成日</label><span>${escHtml(createdAt)}</span></div>
        <div class="detail-field"><label>ID</label><span style="font-size:10px;word-break:break-all">${escHtml(issue.id ?? '')}</span></div>
      </div>
      ${desc ? `<div style="margin-top:10px;font-size:12px;line-height:1.6;color:var(--text-sub)">${escHtml(desc)}</div>` : ''}
    </div>`;

  showView('view-detail');
}
