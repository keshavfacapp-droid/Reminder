import type { Message, UploadKind } from './types';

let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message);
  return data as T;
}

export const api = {
  async session(): Promise<{ user: { id: number } } | null> {
    try {
      const s = await request<{ user: { id: number }; csrfToken: string }>('GET', '/api/auth/session');
      csrfToken = s.csrfToken;
      return s;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },

  async login(username: string, password: string): Promise<void> {
    const r = await request<{ csrfToken: string }>('POST', '/api/auth/login', { username, password });
    csrfToken = r.csrfToken;
  },

  async logout(): Promise<void> {
    await request('POST', '/api/auth/logout');
    csrfToken = null;
  },

  messages(before?: number): Promise<{ messages: Message[] }> {
    return request('GET', `/api/messages?limit=50${before ? `&before=${before}` : ''}`);
  },

  shared(type: 'photo' | 'video' | 'document' | 'link', before?: number): Promise<{ messages: Message[] }> {
    return request('GET', `/api/shared?type=${type}&limit=60${before ? `&before=${before}` : ''}`);
  },

  sendText(text: string): Promise<{ message: Message }> {
    return request('POST', '/api/messages', { text });
  },

  sendLink(url: string): Promise<{ message: Message }> {
    return request('POST', '/api/messages/link', { url });
  },

  markRead(upToId: number): Promise<unknown> {
    return request('POST', '/api/messages/read', { upToId });
  },

  deleteMessage(id: number): Promise<unknown> {
    return request('DELETE', `/api/messages/${id}`);
  },

  pushConfig(): Promise<{ enabled: boolean; publicKey: string | null }> {
    return request('GET', '/api/push/config');
  },

  pushSubscribe(sub: PushSubscriptionJSON): Promise<unknown> {
    return request('POST', '/api/push/subscribe', { endpoint: sub.endpoint, keys: sub.keys });
  },

  pushUnsubscribe(endpoint: string): Promise<unknown> {
    return request('POST', '/api/push/unsubscribe', { endpoint });
  },

  /** Uploads a file with progress reporting (fetch has no upload progress). */
  upload(kind: UploadKind, file: File, onProgress: (fraction: number) => void): { promise: Promise<Message>; abort: () => void } {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<Message>((resolve, reject) => {
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', file, file.name);
      xhr.open('POST', '/api/messages/upload');
      xhr.withCredentials = true;
      if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        const body = xhr.response ?? {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(body.message);
        else reject(new ApiError(xhr.status, body.error ?? 'upload_failed', body.message));
      };
      xhr.onerror = () => reject(new ApiError(0, 'network'));
      xhr.onabort = () => reject(new ApiError(0, 'aborted'));
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  },
};

export function fileUrl(id: number, variant: 'original' | 'display' | 'thumb', download = false): string {
  return `/api/files/${id}/${variant}${download ? '?download=1' : ''}`;
}
