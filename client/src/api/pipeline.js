const API_BASE = import.meta.env.VITE_API_URL || '';
const POLL_INTERVAL_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readApiError(response, fallback) {
  try {
    const err = await response.json();
    return err.error || err.detail || fallback;
  } catch {
    const text = (await response.text()).trim();
    if (!text || text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
      return fallback;
    }
    return text.slice(0, 180);
  }
}

export async function submitJob(file, profile) {
  const formData = new FormData();
  formData.append('audio', file);
  formData.append('profile', profile);

  const response = await fetch(`${API_BASE}/api/process`, {
    method: 'POST',
    body: formData,
  });

  if (response.status !== 202) {
    let detail = `Server error (${response.status})`;
    try {
      const err = await response.json();
      detail = err.detail || err.error || detail;
    } catch {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }

  const data = await response.json();
  return data.jobId;
}

export async function pollJob(jobId, onProgress) {
  while (true) {
    const response = await fetch(`${API_BASE}/api/jobs/${jobId}`);
    if (!response.ok) {
      let detail = `Job poll failed (${response.status})`;
      try {
        const err = await response.json();
        detail = err.error || detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }

    const job = await response.json();
    onProgress?.(job);

    if (job.status === 'complete') return job;
    if (job.status === 'failed') {
      throw new Error(job.error || job.message || 'Pipeline failed.');
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

export async function downloadJobResult(jobId) {
  const response = await fetch(`${API_BASE}/api/download/${jobId}`);
  if (!response.ok) {
    let detail = `Download failed (${response.status})`;
    try {
      const err = await response.json();
      detail = err.error || detail;
    } catch {
      detail = (await response.text()) || detail;
    }
    throw new Error(detail);
  }
  return response.blob();
}

export async function fetchJob(jobId) {
  const response = await fetch(`${API_BASE}/api/jobs/${jobId}`);
  if (!response.ok) {
    throw new Error(await readApiError(response, `Job fetch failed (${response.status})`));
  }
  return response.json();
}

export async function cancelJob(jobId) {
  try {
    await fetch(`${API_BASE}/api/jobs/${jobId}`, { method: 'DELETE' });
  } catch {
    /* best effort */
  }
}

export async function fetchRenderCache() {
  const response = await fetch(`${API_BASE}/api/renders`);
  if (!response.ok) {
    const fallback = response.status === 404
      ? 'Render API not found — restart the backend server.'
      : `Render cache query failed (${response.status})`;
    throw new Error(await readApiError(response, fallback));
  }
  return response.json();
}

export async function deleteSelectedRenders(jobIds) {
  const response = await fetch(`${API_BASE}/api/renders/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobIds }),
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, `Delete renders failed (${response.status})`));
  }
  return response.json();
}

export async function clearAllRenders() {
  const response = await fetch(`${API_BASE}/api/renders`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(await readApiError(response, `Clear renders failed (${response.status})`));
  }
  return response.json();
}
