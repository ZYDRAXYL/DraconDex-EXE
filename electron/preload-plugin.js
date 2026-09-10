'use strict';
// Preload for plugin windows and plugin panels ONLY — never used by the main
// app window (that's preload.js). This is the entire capability an installed
// plugin gets: no window.api, no Node, no filesystem — a table scoped to its
// own manifest-declared schema, plus (v4.3.0) outbound HTTP restricted to the
// origins its manifest declared and an OAuth authorization helper. Every
// pluginapi:* handler (main.js) resolves the calling plugin's identity from the
// WEBCONTENTS itself, never from anything this preload sends, so a compromised
// plugin page cannot claim to be a different plugin by forging an argument.
// See docs/PLUGINS.md.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

// --- net (v4.3.0) ----------------------------------------------------------
// Requests run in the main process, which is what lets a plugin READ a
// cross-origin response that CORS would otherwise withhold. That is a real
// capability, so it is gated on the manifest's `permissions.net` allowlist and
// shown in the install preview — see docs/PLUGINS.md §2.4.
const streamHandlers = new Map(); // streamId -> { onChunk, onEnd }

ipcRenderer.on('pluginapi:net:stream:chunk', (_e, streamId, text) => {
  streamHandlers.get(streamId)?.onChunk?.(text);
});
ipcRenderer.on('pluginapi:net:stream:end', (_e, streamId, result) => {
  const h = streamHandlers.get(streamId);
  streamHandlers.delete(streamId);
  h?.onEnd?.(result);
});

// Resolves with an abort() the plugin can call; chunks arrive through onChunk
// as they land. The handler entry is buffered rather than registered late: a
// short stream can finish before invoke() resolves with its id, and without
// this those first chunks would be delivered to nobody.
async function netStream(url, init, { onChunk, onEnd } = {}) {
  const pending = { chunks: [], ended: null };
  let live = null;
  const handlers = {
    onChunk: (t) => (live ? live.onChunk?.(t) : pending.chunks.push(t)),
    onEnd: (r) => (live ? live.onEnd?.(r) : (pending.ended = r)),
  };
  const { streamId } = await invoke('pluginapi:net:stream:start', url, init);
  streamHandlers.set(streamId, handlers);
  live = { onChunk, onEnd };
  for (const t of pending.chunks) onChunk?.(t);
  if (pending.ended) { streamHandlers.delete(streamId); onEnd?.(pending.ended); }
  return () => invoke('pluginapi:net:stream:abort', streamId);
}

// --- panel (v4.3.0) --------------------------------------------------------
// A plugin rendered as a docked panel can exchange messages with the host
// renderer directly (sendToHost / <webview>.send). This never touches the main
// process and carries only what the host chooses to share, gated on the
// manifest's `permissions.context`.
const panelListeners = new Set();
ipcRenderer.on('pluginhost:msg', (_e, msg) => {
  for (const cb of panelListeners) {
    try { cb(msg); } catch (e) { console.error('panel message handler error:', e); }
  }
});

const pluginApi = {
  table: {
    getSchema: (localName)          => invoke('pluginapi:table:getSchema', localName),
    query:     (localName, filter)  => invoke('pluginapi:table:query', localName, filter),
    insert:    (localName, row)     => invoke('pluginapi:table:insert', localName, row),
    update:    (localName, id, row) => invoke('pluginapi:table:update', localName, id, row),
    delete:    (localName, id)      => invoke('pluginapi:table:delete', localName, id),
  },
  net: {
    fetch:  (url, init)           => invoke('pluginapi:net:fetch', url, init),
    stream: (url, init, handlers) => netStream(url, init, handlers),
  },
  oauth: {
    authorize: (opts) => invoke('pluginapi:oauth:authorize', opts),
  },
  panel: {
    // Returns an unsubscribe function so a re-rendering plugin page doesn't
    // leak a listener on every redraw.
    onMessage: (cb) => { panelListeners.add(cb); return () => panelListeners.delete(cb); },
    send:      (msg) => ipcRenderer.sendToHost('plugin:msg', msg),
    close:     ()    => ipcRenderer.sendToHost('plugin:close'),
  },
};

contextBridge.exposeInMainWorld('pluginApi', pluginApi);
// Backward compatibility for plugins written against the pre-v4.2.0
// "extension" naming — the same capability under its old name, nothing extra.
// Kept indefinitely: dropping it would silently break already-installed
// plugins, and it grants no access `pluginApi` doesn't already grant.
contextBridge.exposeInMainWorld('extApi', pluginApi);
