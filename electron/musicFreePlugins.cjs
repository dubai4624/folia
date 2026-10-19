// electron/musicFreePlugins.cjs
// MusicFree 插件在渲染进程里跑，网络请求交给主进程：`musicfree-plugin-fetch` 从 Node 这一侧发
// （不受页面同源限制，跟随系统代理），`musicfree-plugin-allow-media` 登记插件给出的音频地址，主进程
// 之后给这些地址补 CORS 头、带上插件要求的 Referer/User-Agent，音频元素才能经 Web Audio 播放。
//
// 只在主窗口（`isTrusted`）能调这两个 IPC。地址只接受 http/https。

'use strict';

const FETCH_LIMITS = {
  defaultTimeoutMs: 15000,
  maxTimeoutMs: 60000,
  maxBodyBytes: 10 * 1024 * 1024,
  methods: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
};

const MEDIA_TTL_MS = 2 * 60 * 60 * 1000;
const MEDIA_LIMIT = 4096;

const normalizeMediaUrl = value => {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
};

const normalizeRequestHeaders = value => {
  const headers = {};
  if (!value || typeof value !== 'object') return headers;
  Object.entries(value).forEach(([key, headerValue]) => {
    if (typeof headerValue === 'string' && key) headers[key] = headerValue;
  });
  return headers;
};

/**
 * `net` 是 Electron 的网络模块：请求跟随应用的代理设置，和平台桥用同一条路。
 * 返回 `{ registerHandlers, handleFetch, handleAllowMedia, allowsMediaRequest, headersFor, followRedirect }`。
 */
const createMusicFreePluginBridge = ({ net, session, isTrusted, now = Date.now }) => {
  const issuedMedia = new Map();

  const register = (url, headers) => {
    const normalized = normalizeMediaUrl(url);
    if (!normalized) return false;
    issuedMedia.delete(normalized);
    issuedMedia.set(normalized, {
      expiresAt: now() + MEDIA_TTL_MS,
      headers: normalizeRequestHeaders(headers),
    });
    while (issuedMedia.size > MEDIA_LIMIT) {
      issuedMedia.delete(issuedMedia.keys().next().value);
    }
    return true;
  };

  const mediaEntry = url => {
    const normalized = normalizeMediaUrl(url);
    if (!normalized) return null;
    const entry = issuedMedia.get(normalized);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      issuedMedia.delete(normalized);
      return null;
    }
    return entry;
  };

  const allowsMediaRequest = details => {
    if (!details || !['media', 'xhr', 'image'].includes(details.resourceType)) return false;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(details.method)) return false;
    return mediaEntry(details.url) !== null;
  };

  const headersFor = url => {
    const entry = mediaEntry(url);
    if (!entry || Object.keys(entry.headers).length === 0) return null;
    return entry.headers;
  };

  const followRedirect = details => {
    const entry = details ? mediaEntry(details.url) : null;
    if (entry && details.redirectURL) register(details.redirectURL, entry.headers);
  };

  const serializeError = error => {
    if (!error) return 'request failed';
    return error.code ? `${error.code}: ${error.message}` : String(error.message || error);
  };

  const requestOnce = request => new Promise((resolve, reject) => {
    const target = normalizeMediaUrl(request.url);
    if (!target) {
      reject(new Error('net-invalid-url'));
      return;
    }
    const method = String(request.method || 'GET').toUpperCase();
    if (!FETCH_LIMITS.methods.has(method)) {
      reject(new Error(`net-unsupported-method:${method}`));
      return;
    }
    const timeoutMs = Math.min(
      FETCH_LIMITS.maxTimeoutMs,
      Math.max(1000, Number(request.timeoutMs) || FETCH_LIMITS.defaultTimeoutMs),
    );
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    let clientRequest;
    try {
      clientRequest = net.request({
        url: target,
        method,
        redirect: 'follow',
        // 插件请求不带应用自己的 Cookie：插件要什么由它自己的头发。
        credentials: 'omit',
        useSessionCookies: false,
        session: session.defaultSession,
      });
    } catch (error) {
      finish(error);
      return;
    }

    timer = setTimeout(() => {
      try {
        clientRequest.abort();
      } catch {}
      finish(new Error('net-timeout'));
    }, timeoutMs);

    Object.entries(normalizeRequestHeaders(request.headers)).forEach(([name, value]) => {
      try {
        clientRequest.setHeader(name, value);
      } catch {}
    });

    clientRequest.on('response', response => {
      const chunks = [];
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > FETCH_LIMITS.maxBodyBytes) {
          try {
            clientRequest.abort();
          } catch {}
          finish(new Error('net-body-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const headers = {};
        Object.entries(response.headers || {}).forEach(([name, value]) => {
          headers[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        });
        finish(null, {
          status: response.statusCode,
          statusText: response.statusMessage || '',
          headers,
          bodyBase64: Buffer.concat(chunks).toString('base64'),
        });
      });
      response.on('error', error => finish(error));
    });
    clientRequest.on('error', error => finish(error));
    clientRequest.on('abort', () => finish(new Error('net-aborted')));

    if (request.body && method !== 'GET' && method !== 'HEAD') {
      clientRequest.write(String(request.body));
    }
    clientRequest.end();
  });

  const handleFetch = async (event, request) => {
    if (!isTrusted(event)) return { ok: false, error: 'untrusted-renderer' };
    if (!request || typeof request.url !== 'string') return { ok: false, error: 'net-invalid-url' };
    try {
      return { ok: true, ...(await requestOnce(request)) };
    } catch (error) {
      return { ok: false, error: serializeError(error) };
    }
  };

  const handleAllowMedia = (event, url, headers) => {
    if (!isTrusted(event)) return false;
    return register(url, headers);
  };

  const registerHandlers = ipcMain => {
    ipcMain.handle('musicfree-plugin-fetch', handleFetch);
    ipcMain.handle('musicfree-plugin-allow-media', handleAllowMedia);
  };

  return { registerHandlers, handleFetch, handleAllowMedia, allowsMediaRequest, headersFor, followRedirect };
};

module.exports = { createMusicFreePluginBridge, FETCH_LIMITS };
