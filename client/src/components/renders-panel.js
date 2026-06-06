import { clearAllRenders, deleteSelectedRenders, fetchRenderCache } from '../api/pipeline.js';

let trigger = null;
let modal = null;
let backdrop = null;
let closeBtn = null;
let listEl = null;
let emptyEl = null;
let loadingEl = null;
let errorEl = null;
let errorTextEl = null;
let retryBtn = null;
let selectAllEl = null;
let deleteSelectedBtn = null;
let deleteAllBtn = null;
let loadPlayBtn = null;
let refreshBtn = null;
let isOpen = false;
let renders = [];
let loadError = null;
let onDeleted = null;
let onLoadPlay = null;

function formatRenderDate(ts) {
  if (!ts) return '—';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTrackName(name) {
  return (name || 'UNKNOWN TRACK').toUpperCase();
}

function formatStatus(status) {
  return (status || 'unknown').toUpperCase();
}

function getSelectedJobIds() {
  if (!listEl) return [];
  return [...listEl.querySelectorAll('.renders-modal-checkbox:checked')].map(
    (input) => input.value,
  );
}

function getSelectedRenders() {
  const ids = getSelectedJobIds();
  return renders.filter((render) => ids.includes(render.jobId));
}

function getPlayableSelection() {
  const selected = getSelectedRenders();
  if (selected.length !== 1) return null;
  const render = selected[0];
  if (render.status !== 'complete' || !render.hasOutput) return null;
  return render;
}

function syncActionState() {
  const selected = getSelectedJobIds();
  const count = renders.length;
  const playable = getPlayableSelection();

  if (selectAllEl) {
    selectAllEl.checked = count > 0 && selected.length === count;
    selectAllEl.indeterminate = selected.length > 0 && selected.length < count;
    selectAllEl.disabled = count === 0 || Boolean(loadError);
  }

  if (loadPlayBtn) loadPlayBtn.disabled = !playable || Boolean(loadError);
  if (deleteSelectedBtn) deleteSelectedBtn.disabled = selected.length === 0 || Boolean(loadError);
  if (deleteAllBtn) deleteAllBtn.disabled = count === 0 || Boolean(loadError);

  if (trigger) {
    trigger.textContent = count > 0 ? `RENDERS (${count})` : 'RENDERS';
    trigger.title = loadError
      ? 'Render library unavailable'
      : count > 0
        ? `${count} saved render(s) on disk`
        : 'View saved renders';
  }
}

function setViewState(state) {
  loadingEl?.classList.toggle('hidden', state !== 'loading');
  errorEl?.classList.toggle('hidden', state !== 'error');
  emptyEl?.classList.toggle('hidden', state !== 'empty');
  listEl?.classList.toggle('hidden', state !== 'list');
}

function renderList() {
  if (!listEl || !emptyEl) return;

  listEl.innerHTML = '';

  for (const render of renders) {
    const row = document.createElement('label');
    row.className = 'renders-modal-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'renders-modal-checkbox';
    checkbox.value = render.jobId;
    checkbox.addEventListener('change', syncActionState);

    const body = document.createElement('span');
    body.className = 'renders-modal-item-body';

    const title = document.createElement('span');
    title.className = 'renders-modal-item-title';
    title.textContent = formatTrackName(render.originalName);
    title.title = render.originalName || '';

    const meta = document.createElement('span');
    meta.className = 'renders-modal-item-meta';

    const profile = document.createElement('span');
    profile.className = 'renders-modal-item-profile';
    profile.textContent = (render.profile || '—').toUpperCase();

    const status = document.createElement('span');
    status.className = `renders-modal-item-status is-${render.status}`;
    status.textContent = formatStatus(render.status);

    const date = document.createElement('span');
    date.className = 'renders-modal-item-date';
    date.textContent = formatRenderDate(render.updatedAt);

    meta.append(profile, status, date);
    body.append(title, meta);
    row.append(checkbox, body);
    listEl.appendChild(row);
  }

  if (loadError) {
    setViewState('error');
  } else if (renders.length === 0) {
    setViewState('empty');
  } else {
    setViewState('list');
  }

  syncActionState();
}

async function loadRenders() {
  setViewState('loading');
  loadError = null;

  try {
    const cache = await fetchRenderCache();
    renders = cache.renders ?? [];
    renderList();
    return renders;
  } catch (err) {
    renders = [];
    loadError = String(err.message || err);
    if (errorTextEl) errorTextEl.textContent = loadError;
    renderList();
    throw err;
  }
}

function openModal() {
  if (!modal || !trigger) return;

  isOpen = true;
  trigger.setAttribute('aria-expanded', 'true');
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('renders-modal-open');

  loadRenders().catch(() => {});
  document.addEventListener('keydown', onKeyDown);
}

function closeModal() {
  if (!modal || !trigger) return;

  isOpen = false;
  trigger.setAttribute('aria-expanded', 'false');
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('renders-modal-open');
  document.removeEventListener('keydown', onKeyDown);
}

function onKeyDown(e) {
  if (e.key === 'Escape') closeModal();
}

async function deleteSelected() {
  const jobIds = getSelectedJobIds();
  if (jobIds.length === 0) return;

  const confirmed = window.confirm(
    jobIds.length === 1
      ? 'Delete the selected render from disk?'
      : `Delete ${jobIds.length} selected renders from disk?`,
  );
  if (!confirmed) return;

  try {
    deleteSelectedBtn.disabled = true;
    deleteAllBtn.disabled = true;
    const result = await deleteSelectedRenders(jobIds);
    onDeleted?.(result.deleted ?? jobIds);
    await loadRenders();
    window.dispatchEvent(new CustomEvent('auralisConsole', {
      detail: {
        lines: [
          'SELECTED RENDERS DELETED.',
          `${result.removed ?? jobIds.length} JOB DIR(S) REMOVED.`,
        ],
      },
    }));
  } catch (err) {
    loadError = String(err.message || err);
    if (errorTextEl) errorTextEl.textContent = loadError;
    setViewState('error');
    window.dispatchEvent(new CustomEvent('auralisConsole', {
      detail: {
        lines: [
          'DELETE SELECTED FAILED.',
          String(err.message || err).toUpperCase(),
        ],
      },
    }));
  } finally {
    syncActionState();
  }
}

async function deleteAll() {
  if (renders.length === 0) return;

  const confirmed = window.confirm(
    `Delete all ${renders.length} saved renders from disk? This cannot be undone.`,
  );
  if (!confirmed) return;

  try {
    deleteSelectedBtn.disabled = true;
    deleteAllBtn.disabled = true;
    const deletedIds = renders.map((render) => render.jobId);
    const result = await clearAllRenders();
    onDeleted?.(deletedIds);
    await loadRenders();
    window.dispatchEvent(new CustomEvent('auralisConsole', {
      detail: {
        lines: [
          'ALL RENDERS DELETED.',
          `${result.removed ?? deletedIds.length} JOB DIR(S) REMOVED.`,
        ],
      },
    }));
  } catch (err) {
    loadError = String(err.message || err);
    if (errorTextEl) errorTextEl.textContent = loadError;
    setViewState('error');
    window.dispatchEvent(new CustomEvent('auralisConsole', {
      detail: {
        lines: [
          'DELETE ALL FAILED.',
          String(err.message || err).toUpperCase(),
        ],
      },
    }));
  } finally {
    syncActionState();
  }
}

export class RendersPanel {
  static init(options = {}) {
    onDeleted = options.onDeleted ?? null;
    onLoadPlay = options.onLoadPlay ?? null;

    trigger = document.getElementById('rendersPanelTrigger');
    modal = document.getElementById('rendersModal');
    backdrop = document.getElementById('rendersModalBackdrop');
    closeBtn = document.getElementById('rendersModalClose');
    listEl = document.getElementById('rendersPanelList');
    emptyEl = document.getElementById('rendersPanelEmpty');
    loadingEl = document.getElementById('rendersModalLoading');
    errorEl = document.getElementById('rendersModalError');
    errorTextEl = document.getElementById('rendersModalErrorText');
    retryBtn = document.getElementById('rendersModalRetry');
    selectAllEl = document.getElementById('rendersSelectAll');
    deleteSelectedBtn = document.getElementById('rendersDeleteSelected');
    deleteAllBtn = document.getElementById('rendersDeleteAll');
    loadPlayBtn = document.getElementById('rendersLoadPlay');
    refreshBtn = document.getElementById('rendersPanelRefresh');

    if (!trigger || !modal || !listEl || !emptyEl) {
      console.error('[RendersPanel] Required elements not found');
      return false;
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal();
    });

    backdrop?.addEventListener('click', closeModal);
    closeBtn?.addEventListener('click', closeModal);

    refreshBtn?.addEventListener('click', () => {
      loadRenders().catch(() => {});
    });

    retryBtn?.addEventListener('click', () => {
      loadRenders().catch(() => {});
    });

    selectAllEl?.addEventListener('change', () => {
      const checked = selectAllEl.checked;
      listEl.querySelectorAll('.renders-modal-checkbox').forEach((input) => {
        input.checked = checked;
      });
      syncActionState();
    });

    deleteSelectedBtn?.addEventListener('click', deleteSelected);
    deleteAllBtn?.addEventListener('click', deleteAll);

    loadPlayBtn?.addEventListener('click', async () => {
      const render = getPlayableSelection();
      if (!render || !onLoadPlay) return;
      loadPlayBtn.disabled = true;
      try {
        await onLoadPlay(render);
        closeModal();
      } catch (err) {
        window.dispatchEvent(new CustomEvent('auralisConsole', {
          detail: {
            lines: [
              'LOAD RENDER FAILED.',
              String(err.message || err).toUpperCase(),
            ],
          },
        }));
      } finally {
        syncActionState();
      }
    });

    loadRenders().catch(() => {});
    return true;
  }

  static refresh() {
    return loadRenders().catch(() => {});
  }
}
