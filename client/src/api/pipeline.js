const API_BASE = import.meta.env.VITE_API_URL || '';
const POLL_INTERVAL_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function cancelJob(jobId) {
  try {
    await fetch(`${API_BASE}/api/jobs/${jobId}`, { method: 'DELETE' });
  } catch {
    /* best effort */
  }
}
