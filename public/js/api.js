/** Thin wrapper over the API. Throws ApiError so callers can show real messages. */

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload ?? {};
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('offline', 0);
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => ({})) : {};
  if (!res.ok) throw new ApiError(payload.error || `Request failed (${res.status})`, res.status, payload);
  return payload;
}

export const api = {
  status: () => request('GET', '/api/status'),
  salt: (username) => request('POST', '/api/auth/salt', { username }),
  register: (data) => request('POST', '/api/auth/register', data),
  login: (data) => request('POST', '/api/auth/login', data),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request('GET', '/api/auth/me'),

  listEntries: (since = 0) => request('GET', `/api/entries?since=${since}`),
  createEntry: (data) => request('POST', '/api/entries', data),
  updateEntry: (id, data) => request('PUT', `/api/entries/${id}`, data),
  deleteEntry: (id) => request('DELETE', `/api/entries/${id}`),
  rekey: (data) => request('POST', '/api/entries/rekey', data),
  deleteAccount: () => request('DELETE', '/api/account'),

  /** The only call that carries dream text in the clear. */
  ai: (prompt) => request('POST', '/api/ai', { prompt }),
};
