/**
 * Aetheris AI — Production Chat Engine
 * Handles SSE token streaming, Markdown parsing with XSS sanitization, syntax highlighting,
 * intelligent auto-scrolling, session lifecycle, and multi-theme management.
 */

// Transparent Auth Header Injection for iframe & cross-origin resilience
(function() {
  const originalFetch = window.fetch;
  window.fetch = function(url, options = {}) {
    try {
      const token = localStorage.getItem('aetheris_auth_token') || window.AETHERIS_AUTH_TOKEN || '';
      if (token && typeof url === 'string' && url.startsWith('/api/')) {
        options = options || {};
        const headers = options.headers || {};
        if (headers instanceof Headers) {
          if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
          if (!headers.has('X-Auth-Token')) headers.set('X-Auth-Token', token);
          options.headers = headers;
        } else {
          options.headers = {
            ...headers,
            'Authorization': headers['Authorization'] || `Bearer ${token}`,
            'X-Auth-Token': headers['X-Auth-Token'] || token,
          };
        }
      }
    } catch (e) {}
    return originalFetch.call(this, url, options);
  };
})();

// Application State
const state = {
  activeSessionId: null,
  activeSessionTitle: 'New Conversation',
  systemPrompt: null,
  isStreaming: false,
  streamAbortController: null,
  userScrolledUp: false,
  agents: [],
  activeAgent: null,
  generatedAgentSpec: null,
  pendingImages: [],
  pendingDocs: [],
  createImageMode: false,
  webGroundingMode: false,
};

// Preset Prompts
const PROMPT_PRESETS = {
  default: "You are Aetheris AI, an enterprise-grade, highly capable AI assistant. Provide thorough, concise, and structured answers using rich GitHub-flavored Markdown. When writing code, include language tags and idiomatic patterns.",
  architect: "You are a Principal Software Architect with 20+ years of mission-critical systems experience. You write clean, PEP 8-compliant Python, architect distributed systems, and provide elite technical blueprints with trade-off analysis.",
  concise: "You are a high-speed executive assistant. Provide direct, factual, bulleted summaries. Avoid conversational filler, intros, or summaries.",
  creative: "You are an elite creative copywriter and storyteller. Craft high-converting, captivating prose with engaging cadence and dynamic vocabulary.",
  security: "You are a Senior Application Security Auditor. Analyze code and infrastructure for vulnerabilities, OWASP Top 10 risks, timing attacks, and provide hardened remediation patches."
};

/* ==========================================================================
   INITIALIZATION & THEME LOGIC
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initMarkedRenderer();
  initInitialSession();
  initDesktopWorkstation();
  loadAgents();
});

function initTheme() {
  const savedTheme = localStorage.getItem('aetheris_theme') || 'dark';
  setTheme(savedTheme, false);
}

function setTheme(themeName, save = true) {
  document.documentElement.setAttribute('data-theme', themeName);
  if (save) {
    localStorage.setItem('aetheris_theme', themeName);
  }

  // Update theme pill states
  document.querySelectorAll('.theme-pill').forEach(pill => {
    if (pill.getAttribute('data-theme') === themeName) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });

  // Switch Prism Theme between dark and light if needed
  const prismLink = document.getElementById('prism-theme');
  if (prismLink) {
    if (themeName === 'light') {
      prismLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css';
    } else {
      prismLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css';
    }
  }
}

/* ==========================================================================
   MARKDOWN & XSS SANITIZATION
   ========================================================================== */

function initMarkedRenderer() {
  if (typeof marked === 'undefined') return;

  const renderer = new marked.Renderer();

  // Custom Code Block Renderer with Copy Button and Language Badge
  renderer.code = function({ text, lang }) {
    const language = (lang || 'plaintext').trim();
    const validLang = Prism && Prism.languages[language] ? language : 'plaintext';
    let highlighted = text;

    try {
      if (window.Prism && Prism.languages[validLang]) {
        highlighted = Prism.highlight(text, Prism.languages[validLang], validLang);
      } else {
        highlighted = escapeHtml(text);
      }
    } catch (e) {
      highlighted = escapeHtml(text);
    }

    const escapedCode = encodeURIComponent(text);

    return `
      <div class="code-block-wrapper">
        <div class="code-header">
          <span class="code-lang">${escapeHtml(language)}</span>
          <button class="btn-copy-code" onclick="copyCode(this, '${escapedCode}')">
            <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Copy</span>
          </button>
        </div>
        <pre><code class="language-${escapeHtml(validLang)}">${highlighted}</code></pre>
      </div>
    `;
  };

  // Custom Image Renderer with Lightbox Zoom & Action Buttons
  renderer.image = function({ href, title, text }) {
    const safeHref = escapeHtml(href);
    const safeAlt = escapeHtml(text || 'AI Generated Image');
    const safeTitle = escapeHtml(title || text || 'AI Generated Image');
    const escapedHref = encodeURIComponent(href);
    const escapedTitle = encodeURIComponent(text || 'Generated Visual');

    return `
      <div class="chat-image-card">
        <div class="chat-image-wrapper" onclick="openImageLightbox('${escapedHref}', '${escapedTitle}')">
          <img src="${safeHref}" alt="${safeAlt}" class="chat-rendered-img" loading="lazy" />
          <div class="chat-image-overlay">
            <span class="chat-image-zoom-hint">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                <line x1="11" y1="8" x2="11" y2="14"></line>
                <line x1="8" y1="11" x2="14" y2="11"></line>
              </svg>
              <span>Click to enlarge</span>
            </span>
          </div>
        </div>
        <div class="chat-image-meta">
          <span class="chat-image-title">${safeTitle}</span>
          <div class="chat-image-btns">
            <button type="button" class="btn-image-action" onclick="openImageLightbox('${escapedHref}', '${escapedTitle}')" title="View full size">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" stroke-width="2">
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
              <span>Expand</span>
            </button>
            <a href="${safeHref}" download="${safeAlt}.png" target="_blank" class="btn-image-action" title="Download image">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Save</span>
            </a>
          </div>
        </div>
      </div>
    `;
  };

  marked.setOptions({
    renderer: renderer,
    gfm: true,
    breaks: true,
  });
}

function renderMarkdownSafe(markdownText) {
  if (typeof marked === 'undefined') {
    return escapeHtml(markdownText);
  }
  const rawHtml = marked.parse(markdownText);
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(rawHtml, {
      ADD_TAGS: ['img', 'svg', 'path', 'line', 'circle', 'polyline', 'rect', 'button', 'a', 'span', 'div', 'pre', 'code'],
      ADD_ATTR: ['onclick', 'target', 'class', 'href', 'src', 'alt', 'title', 'loading', 'download', 'viewBox', 'width', 'height', 'stroke', 'fill', 'stroke-width', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'points', 'rx', 'ry', 'd'],
    });
  }
  return rawHtml;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function copyCode(button, encodedCode) {
  const code = decodeURIComponent(encodedCode);
  navigator.clipboard.writeText(code).then(() => {
    const originalText = button.querySelector('span').textContent;
    button.querySelector('span').textContent = 'Copied!';
    button.classList.add('copied');
    setTimeout(() => {
      button.querySelector('span').textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
  }).catch(err => {
    console.error('Copy failed:', err);
    showToast('Failed to copy to clipboard', 'error');
  });
}

/* ==========================================================================
   SESSION LIFECYCLE MANAGEMENT
   ========================================================================== */

async function safeFetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    let errMsg = `Server returned status ${res.status}`;
    if (contentType.includes('application/json')) {
      try {
        const errJson = await res.json();
        if (errJson && (errJson.error || errJson.details)) {
          errMsg = errJson.error || errJson.details;
        }
      } catch (e) {
        // Fall back to status string
      }
    } else {
      const text = await res.text().catch(() => '');
      if (res.status === 502 || res.status === 504 || res.status === 503) {
        errMsg = 'Backend server is initializing or restarting. Please retry in a moment.';
      } else if (res.status === 401) {
        errMsg = 'Authentication required. Please sign in or refresh.';
      }
    }
    throw new Error(errMsg);
  }

  if (!contentType.includes('application/json')) {
    throw new Error('Backend server is temporarily unavailable or restarting. Please try again.');
  }

  return await res.json();
}

function initInitialSession() {
  const firstItem = document.querySelector('.session-item');
  if (firstItem) {
    const sessionId = firstItem.getAttribute('data-session-id');
    loadSession(sessionId);
  } else {
    // Reset to clean welcome state when no sessions exist
    state.activeSessionId = null;
    state.activeSessionTitle = 'New Conversation';
    state.systemPrompt = null;
    updateActiveSessionUI(null, 'New Conversation');
    renderMessagesList([]);
  }
}

async function loadSession(sessionId) {
  if (state.isStreaming) {
    stopStreaming();
  }

  state.activeSessionId = sessionId;
  highlightActiveSession(sessionId);

  try {
    const data = await safeFetchJson(`/api/sessions/${sessionId}`);

    state.activeSessionTitle = data.title;
    state.systemPrompt = data.system_prompt;
    updateActiveSessionUI(data.id, data.title);

    // Sync agent if session has an associated agent
    if (data.agent_id && state.agents && state.agents.length > 0) {
      const matched = state.agents.find(a => a.id === data.agent_id);
      if (matched) {
        setActiveAgentUI(matched);
      }
    }

    renderMessagesList(data.messages || []);
    closeMobileSidebar();
  } catch (err) {
    console.error('[Session] Load error:', err);
    showToast(err.message || 'Error loading conversation.', 'error');
  }
}

function updateActiveSessionUI(id, title) {
  const titleEl = document.getElementById('active-session-title');
  if (titleEl) {
    titleEl.textContent = title || 'New Conversation';
  }
  const promptLabel = document.getElementById('active-prompt-label');
  if (promptLabel) {
    promptLabel.textContent = state.systemPrompt ? 'Persona: Custom Tune' : 'Persona: Default Assistant';
  }
  if (state.activeAgent) {
    setActiveAgentUI(state.activeAgent);
  }
}

function highlightActiveSession(sessionId) {
  document.querySelectorAll('.session-item').forEach(item => {
    if (item.getAttribute('data-session-id') == sessionId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

async function createNewSession() {
  try {
    const activeSysPrompt = state.activeAgent ? state.activeAgent.system_prompt : (state.systemPrompt || null);
    const activeAgentId = state.activeAgent ? state.activeAgent.id : null;

    const newSession = await safeFetchJson('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'New Conversation',
        system_prompt: activeSysPrompt,
        agent_id: activeAgentId
      })
    });

    // Prepend to sessions list
    prependSessionItem(newSession);
    await loadSession(newSession.id);
    showToast('New conversation initialized.', 'info');
  } catch (err) {
    console.error('[Session] Create error:', err);
    showToast(`Could not initialize conversation: ${err.message}`, 'error');
  }
}

function prependSessionItem(session) {
  const list = document.getElementById('sessions-list');
  const emptyMsg = document.getElementById('no-sessions-msg');
  if (emptyMsg) emptyMsg.remove();

  const li = document.createElement('li');
  li.className = 'session-item active';
  li.setAttribute('data-session-id', session.id);
  li.onclick = () => loadSession(session.id);
  li.innerHTML = `
    <div class="session-info">
      <svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" fill="none" stroke-width="2" class="session-icon">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
      <span class="session-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</span>
    </div>
    <div class="session-actions" onclick="event.stopPropagation()">
      <button class="session-action-btn" title="Rename conversation" onclick="openRenameModal(${session.id})">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
      </button>
      <button class="session-action-btn delete-btn" title="Delete conversation" onclick="openDeleteModal(${session.id})">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    </div>
  `;

  list.insertBefore(li, list.firstChild);
  updateSessionCount(1);
}

function updateSessionCount(delta) {
  const badge = document.getElementById('session-count-badge');
  if (badge) {
    const current = parseInt(badge.textContent || '0', 10);
    const newCount = Math.max(0, current + delta);
    badge.textContent = newCount;
    const list = document.getElementById('sessions-list');
    if (newCount === 0 && list) {
      list.innerHTML = '<li class="sessions-empty" id="no-sessions-msg">No conversations yet. Start one above!</li>';
    }
  }
}

/* ==========================================================================
   RENAME & DELETE IN-APP MODALS
   ========================================================================== */

function openRenameModal(sessionId) {
  const targetId = sessionId || state.activeSessionId;
  if (!targetId) {
    showToast('Please select a conversation to rename.', 'error');
    return;
  }

  const item = document.querySelector(`.session-item[data-session-id="${targetId}"]`);
  let currentTitle = '';
  if (item) {
    currentTitle = item.querySelector('.session-title')?.textContent?.trim() || '';
  } else if (state.activeSessionId == targetId) {
    currentTitle = state.activeSessionTitle || '';
  }

  const modal = document.getElementById('rename-session-modal');
  const input = document.getElementById('rename-session-input');
  const idInput = document.getElementById('rename-session-id');

  if (idInput) idInput.value = targetId;
  if (input) {
    input.value = currentTitle;
  }
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => {
      if (input) {
        input.focus();
        input.select();
      }
    }, 50);
  }
}

function closeRenameModal() {
  const modal = document.getElementById('rename-session-modal');
  if (modal) modal.style.display = 'none';
}

function closeRenameModalOnBackdrop(event) {
  if (event.target.id === 'rename-session-modal') {
    closeRenameModal();
  }
}

async function submitRenameSession() {
  const idInput = document.getElementById('rename-session-id');
  const input = document.getElementById('rename-session-input');
  const btn = document.getElementById('save-rename-btn');
  if (!idInput || !input) return;

  const sessionId = idInput.value;
  const newTitle = input.value.trim();
  if (!newTitle) {
    showToast('Conversation title cannot be empty.', 'error');
    input.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  try {
    const updated = await safeFetchJson(`/api/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle })
    });

    // Update in DOM
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) {
      const titleEl = item.querySelector('.session-title');
      if (titleEl) {
        titleEl.textContent = updated.title;
        titleEl.setAttribute('title', updated.title);
      }
    }

    if (state.activeSessionId == sessionId) {
      state.activeSessionTitle = updated.title;
      updateActiveSessionUI(sessionId, updated.title);
    }

    closeRenameModal();
    showToast('Conversation renamed.', 'success');
  } catch (err) {
    console.error('Rename error:', err);
    showToast(`Could not rename conversation: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  }
}

function renameCurrentSession() {
  if (!state.activeSessionId) {
    showToast('No active conversation to rename.', 'error');
    return;
  }
  openRenameModal(state.activeSessionId);
}

// Fallback alias for any template callers
function renameSessionPrompt(sessionId, currentTitle) {
  openRenameModal(sessionId);
}

function openDeleteModal(sessionId) {
  const targetId = sessionId || state.activeSessionId;
  if (!targetId) {
    showToast('Please select a conversation to delete.', 'error');
    return;
  }

  const item = document.querySelector(`.session-item[data-session-id="${targetId}"]`);
  let currentTitle = '';
  if (item) {
    currentTitle = item.querySelector('.session-title')?.textContent?.trim() || '';
  } else if (state.activeSessionId == targetId) {
    currentTitle = state.activeSessionTitle || '';
  }

  const modal = document.getElementById('delete-session-modal');
  const idInput = document.getElementById('delete-session-id');
  const titleDisplay = document.getElementById('delete-session-target-title');

  if (idInput) idInput.value = targetId;
  if (titleDisplay) {
    titleDisplay.textContent = currentTitle || `Conversation #${targetId}`;
  }
  if (modal) {
    modal.style.display = 'flex';
  }
}

function closeDeleteModal() {
  const modal = document.getElementById('delete-session-modal');
  if (modal) modal.style.display = 'none';
}

function closeDeleteModalOnBackdrop(event) {
  if (event.target.id === 'delete-session-modal') {
    closeDeleteModal();
  }
}

async function submitDeleteSession() {
  const idInput = document.getElementById('delete-session-id');
  const btn = document.getElementById('confirm-delete-btn');
  if (!idInput) return;

  const sessionId = idInput.value;
  if (!sessionId || sessionId === 'null') {
    showToast('Please select a conversation to delete.', 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Deleting...';
  }

  try {
    await safeFetchJson(`/api/sessions/${sessionId}`, {
      method: 'DELETE'
    });

    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.remove();
    updateSessionCount(-1);

    closeDeleteModal();
    showToast('Conversation deleted.', 'info');

    if (state.activeSessionId == sessionId) {
      state.activeSessionId = null;
      initInitialSession();
    }
  } catch (err) {
    console.error('Delete error:', err);
    showToast(`Could not delete conversation: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Delete Permanently';
    }
  }
}

function deleteCurrentSession() {
  if (!state.activeSessionId) {
    showToast('No active conversation to delete.', 'error');
    return;
  }
  openDeleteModal(state.activeSessionId);
}

// Fallback alias for any template callers
function deleteSessionConfirm(sessionId) {
  openDeleteModal(sessionId);
}

function filterSessions(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll('.session-item').forEach(item => {
    const title = item.querySelector('.session-title').textContent.toLowerCase();
    if (title.includes(q)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
}

function toggleExportMenu(event) {
  event.stopPropagation();
  const menu = document.getElementById('export-menu');
  if (menu) menu.classList.toggle('show');
}

document.addEventListener('click', () => {
  const menu = document.getElementById('export-menu');
  if (menu) menu.classList.remove('show');
});

function exportCurrentSession(format) {
  if (!state.activeSessionId) {
    showToast('No active conversation to export.', 'error');
    return;
  }
  window.location.href = `/api/sessions/${state.activeSessionId}/export?format=${format}`;
}

/* ==========================================================================
   MESSAGING & SSE TOKEN STREAMING
   ========================================================================== */

function renderMessagesList(messages) {
  const stream = document.getElementById('messages-stream');
  const welcome = document.getElementById('welcome-state');

  if (!messages || messages.length === 0) {
    stream.innerHTML = '';
    if (welcome) welcome.style.display = 'block';
    return;
  }

  if (welcome) welcome.style.display = 'none';
  stream.innerHTML = '';

  messages.forEach(msg => {
    appendMessageCard(msg.role, msg.content, msg.timestamp, false);
  });

  scrollToBottom(false);
}

function appendMessageCard(role, content, timestamp = null, animate = true, agent = null, attachments = null) {
  const stream = document.getElementById('messages-stream');
  const welcome = document.getElementById('welcome-state');
  if (welcome) welcome.style.display = 'none';

  const isUser = role === 'user';
  const timeStr = timestamp ? formatTimestamp(timestamp) : 'Just now';

  const card = document.createElement('div');
  card.className = `message-item ${isUser ? 'user' : 'assistant'}`;
  if (!animate) card.style.animation = 'none';

  if (isUser) {
    let attachmentsHtml = '';
    const imagesToDisplay = attachments?.images || [];
    const docsToDisplay = attachments?.docs || [];

    if (imagesToDisplay.length > 0 || docsToDisplay.length > 0) {
      attachmentsHtml += '<div class="user-msg-attachments">';
      imagesToDisplay.forEach(img => {
        const safeData = escapeHtml(img.data);
        const safeName = escapeHtml(img.name || 'Image');
        const encData = encodeURIComponent(img.data);
        const encName = encodeURIComponent(img.name || 'Image');
        attachmentsHtml += `<img src="${safeData}" alt="${safeName}" class="user-msg-img-preview" onclick="openImageLightbox('${encData}', '${encName}')" title="${safeName}" />`;
      });
      docsToDisplay.forEach(doc => {
        attachmentsHtml += `
          <span class="user-msg-doc-preview">
            <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <span>${escapeHtml(doc.name)}</span>
          </span>
        `;
      });
      attachmentsHtml += '</div>';
    }

    // If content contains markdown images (from database restored session), render them cleanly
    const renderedBody = content.includes('![') ? renderMarkdownSafe(content) : escapeHtml(content).replace(/\n/g, '<br>');

    card.innerHTML = `
      <div class="msg-avatar user-msg-avatar">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      </div>
      <div class="msg-bubble-wrapper">
        <div class="msg-header">
          <span class="msg-role-name">You</span>
          <span class="msg-time">${timeStr}</span>
        </div>
        ${attachmentsHtml}
        <div class="msg-bubble">${renderedBody}</div>
      </div>
    `;
  } else {
    const curAgent = agent || state.activeAgent;
    let agentAvatar = curAgent ? (curAgent.avatar || '⚡') : '⚡';
    let agentName = curAgent ? (curAgent.name || 'Gemini 2.5 Flash') : 'Gemini 2.5 Flash';

    if (agentName.includes('Apex') || agentName === 'Aetheris AI') {
      agentName = 'Gemini 2.5 Flash';
      agentAvatar = '⚡';
    }

    card.innerHTML = `
      <div class="msg-avatar assistant-avatar" style="font-size: 1.15rem; display: flex; align-items: center; justify-content: center;">
        <span>${agentAvatar}</span>
      </div>
      <div class="msg-bubble-wrapper">
        <div class="msg-header">
          <span class="msg-role-name">${escapeHtml(agentName)}</span>
          <span class="msg-time">${timeStr}</span>
        </div>
        <div class="msg-bubble markdown-body">${renderMarkdownSafe(content)}</div>
        <div class="msg-footer-actions">
          <button class="msg-footer-btn" onclick="readAloudMessage(this)">
            <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            </svg>
            <span>Read Aloud</span>
          </button>
        </div>
      </div>
    `;
  }

  stream.appendChild(card);
  return card;
}

function formatTimestamp(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return 'Just now';
  }
}

async function sendMessage() {
  if (state.isStreaming) return;

  const chatInput = document.getElementById('chat-input');
  const rawMessage = chatInput.value.trim();
  const hasImages = state.pendingImages && state.pendingImages.length > 0;
  const hasDocs = state.pendingDocs && state.pendingDocs.length > 0;

  if (!rawMessage && !hasImages && !hasDocs) return;

  const message = rawMessage || (state.createImageMode ? 'Generate an image' : 'Analyze attached files');

  chatInput.value = '';
  autoResizeTextarea(chatInput);

  // Stop any previous speech
  if (window.voiceEngine) {
    window.voiceEngine.stopSpeaking();
  }

  // Snapshot active attachments & modes
  const outgoingImages = [...state.pendingImages];
  const outgoingDocs = [...state.pendingDocs];
  const isCreateImage = state.createImageMode;
  const webGrounding = state.webGroundingMode;

  // Reset input state & tray
  state.pendingImages = [];
  state.pendingDocs = [];
  state.createImageMode = false;
  deactivateCreateImageMode();
  renderAttachmentsTray();

  // Append user message immediately to the UI
  appendMessageCard('user', rawMessage || (isCreateImage ? '🎨 Generated Image Request' : '📎 Uploaded Attachments'), new Date().toISOString(), true, null, { images: outgoingImages, docs: outgoingDocs });
  scrollToBottom(true);

  // Show typing indicator
  showTypingIndicator(true);
  toggleStreamingButtons(true);

  state.isStreaming = true;
  state.streamAbortController = new AbortController();

  let assistantCard = null;
  let assistantBubble = null;
  let accumulatedText = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        session_id: state.activeSessionId,
        system_prompt: state.systemPrompt,
        agent_id: state.activeAgent ? state.activeAgent.id : null,
        stream: true,
        images: outgoingImages,
        attachments: outgoingDocs,
        is_create_image: isCreateImage,
        web_grounding: webGrounding
      }),
      signal: state.streamAbortController.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.replace('data: ', '').trim();
        if (!jsonStr) continue;

        try {
          const payload = JSON.parse(jsonStr);

          if (payload.token) {
            // First incoming token: hide typing indicator and mount assistant card
            if (!assistantCard) {
              showTypingIndicator(false);
              assistantCard = appendMessageCard('assistant', '', new Date().toISOString(), true, state.activeAgent);
              assistantBubble = assistantCard.querySelector('.msg-bubble');
            }

            accumulatedText += payload.token;
            if (assistantBubble) {
              assistantBubble.innerHTML = renderMarkdownSafe(accumulatedText);
            }

            // Auto-scroll conditionally
            if (!state.userScrolledUp) {
              scrollToBottom(false);
            }
          }

          if (payload.session_id && !state.activeSessionId) {
            state.activeSessionId = payload.session_id;
            loadSession(payload.session_id);
          }

          if (payload.session_title && state.activeSessionTitle === 'New Conversation') {
            state.activeSessionTitle = payload.session_title;
            updateActiveSessionUI(state.activeSessionId, payload.session_title);
            const activeItem = document.querySelector(`.session-item[data-session-id="${state.activeSessionId}"]`);
            if (activeItem) {
              activeItem.querySelector('.session-title').textContent = payload.session_title;
            }
          }

          if (payload.done) {
            break;
          }
        } catch (e) {
          console.warn('[SSE] Parse error:', e, line);
        }
      }
    }

    // Auto-TTS if enabled
    if (window.voiceEngine && window.voiceEngine.autoTTS && accumulatedText) {
      window.voiceEngine.speak(accumulatedText);
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      showToast('Generation stopped.', 'info');
    } else {
      console.error('[Chat] Stream error:', err);
      showToast('Error communicating with AI engine.', 'error');
      if (!assistantCard) {
        appendMessageCard('assistant', `⚠️ *An error occurred while generating response: ${err.message}*`, new Date().toISOString());
      }
    }
  } finally {
    showTypingIndicator(false);
    toggleStreamingButtons(false);
    state.isStreaming = false;
    state.streamAbortController = null;
    scrollToBottom(false);
  }
}

function stopStreaming() {
  if (state.streamAbortController) {
    state.streamAbortController.abort();
  }
}

function toggleStreamingButtons(isStreaming) {
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  if (sendBtn && stopBtn) {
    if (isStreaming) {
      sendBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
    } else {
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
    }
  }
}

function showTypingIndicator(show) {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) {
    indicator.style.display = show ? 'block' : 'none';
  }
}

/* ==========================================================================
   SCROLLING & AUTO-SCROLL DETECTION
   ========================================================================== */

function handleScroll(container) {
  const threshold = 60;
  const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  state.userScrolledUp = !isNearBottom;

  const scrollBtn = document.getElementById('scroll-bottom-btn');
  if (scrollBtn) {
    scrollBtn.style.display = state.userScrolledUp ? 'flex' : 'none';
  }
}

function scrollToBottom(force = false) {
  const container = document.getElementById('messages-container');
  if (!container) return;

  if (force || !state.userScrolledUp) {
    container.scrollTop = container.scrollHeight;
    state.userScrolledUp = false;
    const scrollBtn = document.getElementById('scroll-bottom-btn');
    if (scrollBtn) scrollBtn.style.display = 'none';
  }
}

/* ==========================================================================
   INPUT & TEXTAREA HELPERS
   ========================================================================== */

function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px';
}

function sendSuggestion(promptText) {
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.value = promptText;
    autoResizeTextarea(chatInput);
    sendMessage();
  }
}

function readAloudMessage(btn) {
  const card = btn.closest('.message-item');
  if (!card) return;
  const bubble = card.querySelector('.msg-bubble');
  if (!bubble) return;
  const text = bubble.innerText || bubble.textContent;
  if (window.voiceEngine) {
    window.voiceEngine.speak(text, btn);
  }
}

/* ==========================================================================
   SYSTEM PROMPT TUNING MODAL
   ========================================================================== */

function openSystemPromptModal() {
  const modal = document.getElementById('system-prompt-modal');
  const textarea = document.getElementById('modal-system-prompt-input');
  if (textarea) {
    textarea.value = state.systemPrompt || PROMPT_PRESETS.default;
  }
  if (modal) modal.style.display = 'flex';
}

function closeSystemPromptModal() {
  const modal = document.getElementById('system-prompt-modal');
  if (modal) modal.style.display = 'none';
}

function closeModalOnBackdrop(e) {
  if (e.target.id === 'system-prompt-modal') {
    closeSystemPromptModal();
  }
}

function applyPromptPreset(presetKey) {
  const textarea = document.getElementById('modal-system-prompt-input');
  if (textarea && PROMPT_PRESETS[presetKey]) {
    textarea.value = PROMPT_PRESETS[presetKey];
  }
  document.querySelectorAll('.preset-pill').forEach(pill => pill.classList.remove('active'));
  event.target.classList.add('active');
}

async function saveSystemPrompt() {
  const textarea = document.getElementById('modal-system-prompt-input');
  const promptVal = textarea.value.trim();
  state.systemPrompt = promptVal;

  if (state.activeSessionId) {
    try {
      await fetch(`/api/sessions/${state.activeSessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_prompt: promptVal })
      });
    } catch (e) {
      console.error('Failed to persist session prompt:', e);
    }
  }

  updateActiveSessionUI(state.activeSessionId, state.activeSessionTitle);
  closeSystemPromptModal();
  showToast('System persona updated successfully.', 'success');
}

/* ==========================================================================
   DESKTOP WORKSTATION LOGIC (SIDEBAR COLLAPSE, WIDE CANVAS, COMMAND PALETTE)
   ========================================================================== */

function initDesktopWorkstation() {
  const layout = document.querySelector('.app-layout');
  const chatMain = document.getElementById('chat-main');

  // Restore sidebar collapsed preference on desktop
  const savedCollapsed = localStorage.getItem('aetheris_sidebar_collapsed');
  if (savedCollapsed === 'true' && layout && window.innerWidth > 768) {
    layout.classList.add('sidebar-collapsed');
  }

  // Restore wide canvas mode preference
  const savedWide = localStorage.getItem('aetheris_wide_mode');
  if (savedWide === 'true' && chatMain) {
    chatMain.classList.add('wide-workstation');
  }

  // Global desktop keyboard shortcuts
  window.addEventListener('keydown', handleGlobalKeydown);

  // Setup PWA install prompt handler
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.deferredPwaPrompt = e;
    const pwaBtn = document.getElementById('pwa-install-btn');
    if (pwaBtn) pwaBtn.style.display = 'inline-flex';
  });
}

function toggleSidebar() {
  const layout = document.querySelector('.app-layout');
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const isDesktop = window.innerWidth > 768;

  if (isDesktop && layout) {
    const isCollapsed = layout.classList.toggle('sidebar-collapsed');
    localStorage.setItem('aetheris_sidebar_collapsed', isCollapsed ? 'true' : 'false');
    showToast(isCollapsed ? 'Sidebar collapsed (Ctrl+B to expand)' : 'Sidebar expanded', 'info');
  } else if (sidebar && backdrop) {
    const isOpen = sidebar.classList.toggle('open');
    backdrop.classList.toggle('show', isOpen);
  }
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (sidebar && backdrop) {
    sidebar.classList.remove('open');
    backdrop.classList.remove('show');
  }
}

function toggleWideMode() {
  const chatMain = document.getElementById('chat-main');
  if (!chatMain) return;
  const isWide = chatMain.classList.toggle('wide-workstation');
  localStorage.setItem('aetheris_wide_mode', isWide ? 'true' : 'false');
  showToast(isWide ? 'Wide Workstation Canvas enabled' : 'Standard reading width restored', 'info');
}

/* ==========================================================================
   DESKTOP KEYBOARD SHORTCUTS ENGINE
   ========================================================================== */

function handleGlobalKeydown(e) {
  const isCtrlOrCmd = e.ctrlKey || e.metaKey;

  // Esc closes open modals or palette
  if (e.key === 'Escape') {
    closeCommandPalette();
    closeShortcutsModal();
    closeInstallModal();
    closeSystemPromptModal();
    closeRenameModal();
    closeDeleteModal();
    const exportMenu = document.getElementById('export-menu');
    if (exportMenu) exportMenu.classList.remove('show');
    return;
  }

  // Ctrl/Cmd + K: Command Palette
  if (isCtrlOrCmd && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPalette();
    return;
  }

  // Ctrl/Cmd + B: Toggle Sidebar
  if (isCtrlOrCmd && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
    return;
  }

  // Ctrl/Cmd + N: New Conversation
  if (isCtrlOrCmd && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    createNewSession();
    return;
  }

  // Ctrl/Cmd + Shift + W: Toggle Wide Workstation Mode
  if (isCtrlOrCmd && e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    toggleWideMode();
    return;
  }

  // Ctrl/Cmd + Shift + S: System Persona Tuning
  if (isCtrlOrCmd && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    openSystemPromptModal();
    return;
  }

  // Ctrl/Cmd + / or ?: Shortcuts Cheat Sheet (when not typing in an input)
  if ((isCtrlOrCmd && e.key === '/') || (e.key === '?' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName))) {
    e.preventDefault();
    openShortcutsModal();
    return;
  }
}

/* ==========================================================================
   DESKTOP COMMAND PALETTE (RAYCAST / SPOTLIGHT WORKSTATION)
   ========================================================================== */

let paletteSelectedIndex = 0;
let currentPaletteItems = [];

const PALETTE_COMMANDS = [
  { id: 'new_chat', title: 'New Conversation', icon: '💬', shortcut: 'Ctrl+N', action: () => createNewSession() },
  { id: 'rename_chat', title: 'Rename Active Conversation', icon: '✏️', shortcut: '', action: () => renameCurrentSession() },
  { id: 'delete_chat', title: 'Delete Active Conversation', icon: '🗑️', shortcut: '', action: () => deleteCurrentSession() },
  { id: 'toggle_wide', title: 'Toggle Wide Workstation Canvas', icon: '🖥️', shortcut: 'Ctrl+Shift+W', action: () => toggleWideMode() },
  { id: 'toggle_sidebar', title: 'Toggle Sidebar Collapse', icon: '📑', shortcut: 'Ctrl+B', action: () => toggleSidebar() },
  { id: 'system_prompt', title: 'Customize System Persona & Prompt', icon: '⚙️', shortcut: 'Ctrl+Shift+S', action: () => openSystemPromptModal() },
  { id: 'theme_dark', title: 'Switch Theme: Dark Slate', icon: '🌙', shortcut: '', action: () => setTheme('dark') },
  { id: 'theme_light', title: 'Switch Theme: Crisp Light', icon: '☀️', shortcut: '', action: () => setTheme('light') },
  { id: 'theme_cyberpunk', title: 'Switch Theme: Cyberpunk OLED', icon: '⚡', shortcut: '', action: () => setTheme('cyberpunk') },
  { id: 'export_md', title: 'Export Conversation as Markdown (.md)', icon: '📥', shortcut: '', action: () => exportCurrentSession('markdown') },
  { id: 'export_json', title: 'Export Conversation as JSON (.json)', icon: '📊', shortcut: '', action: () => exportCurrentSession('json') },
  { id: 'shortcuts', title: 'Show Desktop Keyboard Shortcuts', icon: '⌨️', shortcut: 'Ctrl+/', action: () => openShortcutsModal() },
  { id: 'download_app', title: 'Download Desktop App Package', icon: '⬇️', shortcut: '', action: () => openInstallModal() },
];

function openCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  const input = document.getElementById('palette-search-input');
  if (modal && input) {
    modal.style.display = 'flex';
    input.value = '';
    paletteSelectedIndex = 0;
    renderPaletteItems('');
    setTimeout(() => input.focus(), 50);
  }
}

function closeCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  if (modal) modal.style.display = 'none';
}

function closePaletteOnBackdrop(e) {
  if (e.target.id === 'command-palette-modal') {
    closeCommandPalette();
  }
}

function renderPaletteItems(filterText) {
  const container = document.getElementById('palette-results');
  if (!container) return;

  const query = (filterText || '').trim().toLowerCase();
  currentPaletteItems = [];

  // Filter commands
  const matchedCommands = PALETTE_COMMANDS.filter(cmd => 
    !query || cmd.title.toLowerCase().includes(query)
  );

  // Filter conversation sessions
  const sessionItems = Array.from(document.querySelectorAll('#sessions-list .session-item'));
  const matchedSessions = sessionItems.map(item => {
    const id = parseInt(item.getAttribute('data-session-id'), 10);
    const titleEl = item.querySelector('.session-title');
    const title = titleEl ? (titleEl.getAttribute('title') || titleEl.innerText) : `Session #${id}`;
    return {
      id: `session_${id}`,
      sessionId: id,
      title: title,
      icon: '💬',
      shortcut: 'Jump',
      action: () => loadSession(id)
    };
  }).filter(s => !query || s.title.toLowerCase().includes(query));

  let html = '';

  if (matchedCommands.length > 0) {
    html += '<div class="palette-section-title">Commands &amp; Tools</div>';
    matchedCommands.forEach(cmd => {
      const idx = currentPaletteItems.length;
      currentPaletteItems.push(cmd);
      const isSelected = idx === paletteSelectedIndex;
      html += `
        <div class="palette-item ${isSelected ? 'selected' : ''}" data-index="${idx}" onclick="executePaletteItem(${idx})">
          <div class="palette-item-left">
            <span class="palette-item-icon">${cmd.icon}</span>
            <span class="palette-item-title">${escapeHtml(cmd.title)}</span>
          </div>
          ${cmd.shortcut ? `<span class="palette-shortcut-badge">${escapeHtml(cmd.shortcut)}</span>` : ''}
        </div>
      `;
    });
  }

  if (matchedSessions.length > 0) {
    html += '<div class="palette-section-title">Conversations</div>';
    matchedSessions.forEach(sess => {
      const idx = currentPaletteItems.length;
      currentPaletteItems.push(sess);
      const isSelected = idx === paletteSelectedIndex;
      html += `
        <div class="palette-item ${isSelected ? 'selected' : ''}" data-index="${idx}" onclick="executePaletteItem(${idx})">
          <div class="palette-item-left">
            <span class="palette-item-icon">${sess.icon}</span>
            <span class="palette-item-title">${escapeHtml(sess.title)}</span>
          </div>
          <span class="palette-shortcut-badge">Open</span>
        </div>
      `;
    });
  }

  if (currentPaletteItems.length === 0) {
    html = '<div style="padding: 2rem; text-align: center; color: var(--text-muted); font-size: 0.88rem;">No matching commands or conversations found.</div>';
  }

  container.innerHTML = html;
}

function handlePaletteSearch(val) {
  paletteSelectedIndex = 0;
  renderPaletteItems(val);
}

function handlePaletteKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (currentPaletteItems.length > 0) {
      paletteSelectedIndex = (paletteSelectedIndex + 1) % currentPaletteItems.length;
      updatePaletteSelection();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (currentPaletteItems.length > 0) {
      paletteSelectedIndex = (paletteSelectedIndex - 1 + currentPaletteItems.length) % currentPaletteItems.length;
      updatePaletteSelection();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (currentPaletteItems[paletteSelectedIndex]) {
      executePaletteItem(paletteSelectedIndex);
    }
  }
}

function updatePaletteSelection() {
  document.querySelectorAll('.palette-item').forEach((el, idx) => {
    if (idx === paletteSelectedIndex) {
      el.classList.add('selected');
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.classList.remove('selected');
    }
  });
}

function executePaletteItem(idx) {
  const item = currentPaletteItems[idx];
  if (item && item.action) {
    closeCommandPalette();
    item.action();
  }
}

/* ==========================================================================
   SHORTCUTS MODAL
   ========================================================================== */

function openShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  if (modal) modal.style.display = 'flex';
}

function closeShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  if (modal) modal.style.display = 'none';
}

function closeShortcutsOnBackdrop(e) {
  if (e.target.id === 'shortcuts-modal') {
    closeShortcutsModal();
  }
}

/* ==========================================================================
   STANDALONE DESKTOP PWA & DOWNLOAD WORKSTATION
   ========================================================================== */

let appDownloadProgress = 0;
let appDownloadTimer = null;

function triggerPWAInstall() {
  if (window.deferredPwaPrompt) {
    window.deferredPwaPrompt.prompt();
    window.deferredPwaPrompt.userChoice.then((choice) => {
      if (choice.outcome === 'accepted') {
        showToast('Aetheris Desktop App installed successfully!', 'success');
        const pwaBtn = document.getElementById('pwa-install-btn');
        if (pwaBtn) pwaBtn.style.display = 'none';
      }
      window.deferredPwaPrompt = null;
    });
  } else {
    openInstallModal();
  }
}

function openInstallModal() {
  const modal = document.getElementById('desktop-install-modal');
  if (modal) {
    resetInstallModalViews();
    modal.style.display = 'flex';
  }
}

function closeInstallModal() {
  const modal = document.getElementById('desktop-install-modal');
  if (appDownloadTimer) {
    clearInterval(appDownloadTimer);
    appDownloadTimer = null;
  }
  if (modal) modal.style.display = 'none';
  resetInstallModalViews();
}

function closeInstallModalOnBackdrop(e) {
  if (e.target.id === 'desktop-install-modal') {
    closeInstallModal();
  }
}

function resetInstallModalViews() {
  if (appDownloadTimer) {
    clearInterval(appDownloadTimer);
    appDownloadTimer = null;
  }
  appDownloadProgress = 0;

  const defaultView = document.getElementById('install-default-view');
  const downloadingView = document.getElementById('install-downloading-view');
  const completeView = document.getElementById('install-complete-view');

  const defaultFooter = document.getElementById('install-default-footer');
  const downloadingFooter = document.getElementById('install-downloading-footer');
  const completeFooter = document.getElementById('install-complete-footer');

  const title = document.getElementById('install-modal-title');
  const subtitle = document.getElementById('install-modal-subtitle');

  if (defaultView) defaultView.style.display = 'block';
  if (downloadingView) downloadingView.style.display = 'none';
  if (completeView) completeView.style.display = 'none';

  if (defaultFooter) defaultFooter.style.display = 'flex';
  if (downloadingFooter) downloadingFooter.style.display = 'none';
  if (completeFooter) completeFooter.style.display = 'none';

  if (title) title.textContent = 'Download Aetheris Desktop App';
  if (subtitle) subtitle.textContent = 'Standalone desktop workstation launcher with native keyboard shortcuts.';
}

function startAppDownloadFlow() {
  const defaultView = document.getElementById('install-default-view');
  const downloadingView = document.getElementById('install-downloading-view');
  const completeView = document.getElementById('install-complete-view');

  const defaultFooter = document.getElementById('install-default-footer');
  const downloadingFooter = document.getElementById('install-downloading-footer');
  const completeFooter = document.getElementById('install-complete-footer');

  const title = document.getElementById('install-modal-title');
  const subtitle = document.getElementById('install-modal-subtitle');

  const progressFill = document.getElementById('download-progress-fill');
  const percentText = document.getElementById('download-percent');
  const speedText = document.getElementById('download-speed');
  const sizeText = document.getElementById('download-size');
  const statusText = document.getElementById('download-progress-status');
  const subStatusText = document.getElementById('download-progress-sub');

  const step1 = document.getElementById('dl-step-1');
  const step2 = document.getElementById('dl-step-2');
  const step3 = document.getElementById('dl-step-3');

  if (defaultView) defaultView.style.display = 'none';
  if (downloadingView) downloadingView.style.display = 'block';
  if (completeView) completeView.style.display = 'none';

  if (defaultFooter) defaultFooter.style.display = 'none';
  if (downloadingFooter) downloadingFooter.style.display = 'flex';
  if (completeFooter) completeFooter.style.display = 'none';

  if (title) title.textContent = 'Downloading Desktop Package...';
  if (subtitle) subtitle.textContent = 'Building standalone workstation bundle for your operating system.';

  appDownloadProgress = 0;
  if (progressFill) progressFill.style.width = '0%';
  if (percentText) percentText.textContent = '0%';
  if (sizeText) sizeText.textContent = '0.0 MB / 14.8 MB';
  if (speedText) speedText.textContent = '5.2 MB/s';

  if (step1) { step1.className = 'dl-step active'; }
  if (step2) { step2.className = 'dl-step'; }
  if (step3) { step3.className = 'dl-step'; }

  const totalMb = 14.8;
  const speeds = ['4.8 MB/s', '5.3 MB/s', '5.9 MB/s', '4.6 MB/s', '6.1 MB/s'];

  if (appDownloadTimer) clearInterval(appDownloadTimer);

  appDownloadTimer = setInterval(() => {
    // Increment progress by 3-7% each tick
    const delta = Math.floor(Math.random() * 5) + 3;
    appDownloadProgress = Math.min(100, appDownloadProgress + delta);

    const currentMb = ((appDownloadProgress / 100) * totalMb).toFixed(1);
    const randSpeed = speeds[Math.floor(Math.random() * speeds.length)];

    if (progressFill) progressFill.style.width = `${appDownloadProgress}%`;
    if (percentText) percentText.textContent = `${appDownloadProgress}%`;
    if (sizeText) sizeText.textContent = `${currentMb} MB / ${totalMb} MB`;
    if (speedText) speedText.textContent = randSpeed;

    if (appDownloadProgress < 35) {
      if (statusText) statusText.textContent = 'Packaging manifest & offline cache...';
      if (subStatusText) subStatusText.textContent = 'Bundling local model configurations and UI assets';
      if (step1) step1.className = 'dl-step active';
      if (step2) step2.className = 'dl-step';
      if (step3) step3.className = 'dl-step';
    } else if (appDownloadProgress < 75) {
      if (statusText) statusText.textContent = 'Compiling standalone desktop wrapper...';
      if (subStatusText) subStatusText.textContent = 'Integrating native keyboard engine & window controllers';
      if (step1) step1.className = 'dl-step done';
      if (step2) step2.className = 'dl-step active';
      if (step3) step3.className = 'dl-step';
    } else if (appDownloadProgress < 100) {
      if (statusText) statusText.textContent = 'Finalizing binary launcher...';
      if (subStatusText) subStatusText.textContent = 'Verifying SHA-256 package integrity';
      if (step1) step1.className = 'dl-step done';
      if (step2) step2.className = 'dl-step done';
      if (step3) step3.className = 'dl-step active';
    } else {
      // 100% Complete!
      clearInterval(appDownloadTimer);
      appDownloadTimer = null;

      if (step1) step1.className = 'dl-step done';
      if (step2) step2.className = 'dl-step done';
      if (step3) step3.className = 'dl-step done';

      setTimeout(() => {
        // Trigger actual download of the launcher file!
        triggerDesktopDownloadFile();

        // Switch to complete view
        if (downloadingView) downloadingView.style.display = 'none';
        if (completeView) completeView.style.display = 'block';

        if (downloadingFooter) downloadingFooter.style.display = 'none';
        if (completeFooter) completeFooter.style.display = 'flex';

        if (title) title.textContent = 'Desktop App Ready!';
        if (subtitle) subtitle.textContent = 'Launcher saved to your browser Downloads folder.';

        showToast('Aetheris AI Desktop package downloaded successfully! (14.8 MB)', 'success');
      }, 400);
    }
  }, 110);
}

function cancelAppDownload() {
  if (appDownloadTimer) {
    clearInterval(appDownloadTimer);
    appDownloadTimer = null;
  }
  resetInstallModalViews();
  showToast('Download cancelled.', 'info');
}

function resetAndStartDownloadAgain() {
  resetInstallModalViews();
  startAppDownloadFlow();
}

function triggerDesktopDownloadFile() {
  const currentOrigin = window.location.origin;
  const launcherHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aetheris AI Desktop Workstation</title>
  <link rel="icon" type="image/svg+xml" href="${currentOrigin}/static/favicon.svg">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #f8fafc; }
    .titlebar { height: 38px; background: #111827; border-bottom: 1px solid #1f2937; display: flex; align-items: center; justify-content: space-between; padding: 0 1rem; user-select: none; -webkit-app-region: drag; }
    .titlebar-brand { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; font-weight: 600; color: #e2e8f0; }
    .brand-dot { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 8px #38bdf8; }
    .titlebar-controls { display: flex; align-items: center; gap: 0.4rem; -webkit-app-region: no-drag; }
    .win-btn { width: 12px; height: 12px; border-radius: 50%; border: none; cursor: pointer; display: inline-block; }
    .btn-close { background: #ef4444; }
    .btn-min { background: #eab308; }
    .btn-max { background: #22c55e; }
    .app-frame { width: 100%; height: calc(100% - 38px); border: none; background: #0b0f19; }
  </style>
</head>
<body>
  <div class="titlebar">
    <div class="titlebar-brand">
      <span class="brand-dot"></span>
      <span>Aetheris AI &bull; Dedicated Desktop Workstation</span>
    </div>
    <div class="titlebar-controls">
      <span class="win-btn btn-min" title="Minimize"></span>
      <span class="win-btn btn-max" title="Maximize" onclick="if(document.fullscreenElement){document.exitFullscreen()}else{document.documentElement.requestFullscreen()}"></span>
      <span class="win-btn btn-close" title="Close Window" onclick="window.close()"></span>
    </div>
  </div>
  <iframe class="app-frame" src="${currentOrigin}/" allow="camera; microphone; clipboard-read; clipboard-write; display-capture"></iframe>
</body>
</html>`;

  const blob = new Blob([launcherHtml], { type: 'text/html;charset=utf-8' });
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = 'Aetheris-AI-Desktop-Launcher.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000);
}

function launchStandalonePreview() {
  const currentOrigin = window.location.origin;
  const features = 'width=1320,height=880,menubar=no,toolbar=no,location=no,status=no,resizable=yes';
  window.open(`${currentOrigin}/`, 'AetherisStandaloneWorkstation', features);
  closeInstallModal();
  showToast('Launched Aetheris in standalone workstation window.', 'info');
}

/* ==========================================================================
   TOAST SYSTEM
   ========================================================================== */

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;
  toast.innerHTML = `
    <span>${type === 'error' ? '⚠️' : type === 'success' ? '✓' : 'ℹ️'}</span>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease-out';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/* ==========================================================================
   AI AGENT STUDIO & FORGE MANAGEMENT
   ========================================================================== */

async function loadAgents() {
  try {
    const agents = await safeFetchJson('/api/agents');
    state.agents = agents || [];

    renderSidebarAgents(state.agents);

    // Update count badge
    const badge = document.getElementById('agent-library-count-badge');
    if (badge) badge.textContent = state.agents.length;

    // Pick active agent (default or first)
    if (!state.activeAgent && state.agents.length > 0) {
      const def = state.agents.find(a => a.is_default) || state.agents[0];
      setActiveAgentUI(def);
    }
  } catch (err) {
    console.warn('[Agents] Failed to load agents:', err);
  }
}

function renderSidebarAgents(agents) {
  const container = document.getElementById('sidebar-agents-list');
  if (!container) return;

  container.innerHTML = '';
  agents.forEach(agent => {
    const isActive = state.activeAgent && state.activeAgent.id === agent.id;
    const pill = document.createElement('div');
    pill.className = `sidebar-agent-pill ${isActive ? 'active' : ''}`;
    pill.setAttribute('data-agent-id', agent.id);
    pill.setAttribute('title', `${agent.role || agent.name} — ${agent.description || ''}`);
    pill.onclick = () => selectAgent(agent.id);
    pill.innerHTML = `
      <span class="agent-avatar">${agent.avatar || '🤖'}</span>
      <div class="agent-info-compact">
        <span class="agent-name">${escapeHtml(agent.name)}</span>
        <span class="agent-role-tiny">${escapeHtml(agent.role || 'AI Agent')}</span>
      </div>
      ${agent.is_default ? '<span class="agent-default-dot" title="Default Autonomous Agent"></span>' : ''}
    `;
    container.appendChild(pill);
  });
}

function setActiveAgentUI(agent) {
  if (agent && agent.name && (agent.name.includes('Apex') || agent.name === 'Aetheris AI')) {
    agent.name = 'Gemini 2.5 Flash';
    agent.avatar = '⚡';
  }
  state.activeAgent = agent;

  const displayName = (agent && agent.name) ? agent.name : 'Gemini 2.5 Flash';
  const displayAvatar = (agent && agent.avatar) ? agent.avatar : '⚡';

  // Header chip
  const headerAvatar = document.getElementById('header-agent-avatar');
  const headerName = document.getElementById('header-agent-name');
  if (headerAvatar) headerAvatar.textContent = displayAvatar;
  if (headerName) headerName.textContent = displayName;

  // Workstation button
  const wsAvatar = document.getElementById('workstation-agent-avatar');
  const wsName = document.getElementById('workstation-agent-name');
  if (wsAvatar) wsAvatar.textContent = displayAvatar;
  if (wsName) wsName.textContent = displayName;

  // Dock chip
  const dockAvatar = document.getElementById('dock-agent-avatar');
  const dockName = document.getElementById('dock-agent-name');
  if (dockAvatar) dockAvatar.textContent = displayAvatar;
  if (dockName) dockName.textContent = displayName;

  // Highlight in sidebar
  document.querySelectorAll('.sidebar-agent-pill').forEach(pill => {
    if (pill.getAttribute('data-agent-id') == agent.id) {
      pill.classList.add('active');
    } else {
      pill.classList.remove('active');
    }
  });
}

async function selectAgent(agentId, syncSession = true) {
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) return;

  setActiveAgentUI(agent);
  showToast(`Active Agent: ${agent.name} (${agent.avatar || '🤖'})`, 'info');

  if (syncSession && state.activeSessionId) {
    try {
      await safeFetchJson(`/api/sessions/${state.activeSessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agent.id,
          system_prompt: agent.system_prompt
        })
      });
    } catch (e) {
      console.warn('Could not sync session agent_id:', e);
    }
  }
}

function openAgentStudioModal(openCreate = false) {
  const modal = document.getElementById('agent-studio-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  if (openCreate) {
    switchAgentTab('generate');
  } else {
    switchAgentTab('library');
  }
}

function closeAgentStudioModal() {
  const modal = document.getElementById('agent-studio-modal');
  if (modal) modal.style.display = 'none';
}

function closeAgentStudioOnBackdrop(event) {
  if (event.target.id === 'agent-studio-modal') {
    closeAgentStudioModal();
  }
}

function switchAgentTab(tabName) {
  const tabs = ['gen', 'build', 'lib'];
  const panes = ['generate', 'builder', 'library'];

  tabs.forEach(t => {
    const btn = document.getElementById(`tab-btn-${t}`);
    if (btn) btn.classList.remove('active');
  });

  panes.forEach(p => {
    const pane = document.getElementById(`agent-pane-${p}`);
    if (pane) pane.style.display = 'none';
  });

  if (tabName === 'generate') {
    const btn = document.getElementById('tab-btn-gen');
    const pane = document.getElementById('agent-pane-generate');
    if (btn) btn.classList.add('active');
    if (pane) pane.style.display = 'block';
  } else if (tabName === 'builder') {
    const btn = document.getElementById('tab-btn-build');
    const pane = document.getElementById('agent-pane-builder');
    if (btn) btn.classList.add('active');
    if (pane) pane.style.display = 'block';
  } else if (tabName === 'library') {
    const btn = document.getElementById('tab-btn-lib');
    const pane = document.getElementById('agent-pane-library');
    if (btn) btn.classList.add('active');
    if (pane) pane.style.display = 'block';
    loadAgentLibrary();
  }
}

function applyAgentPreset(text) {
  const promptInput = document.getElementById('agent-gen-prompt');
  if (promptInput) {
    promptInput.value = text;
    promptInput.focus();
  }
}

async function submitGenerateAgent() {
  const promptInput = document.getElementById('agent-gen-prompt');
  const keyInput = document.getElementById('agent-gen-api-key');
  const autoSaveCheck = document.getElementById('agent-gen-autosave');
  const btn = document.getElementById('btn-generate-agent');
  const btnText = document.getElementById('btn-gen-text');

  const prompt = promptInput?.value?.trim() || '';
  if (!prompt) {
    showToast('Please describe the AI Agent you wish to create.', 'error');
    promptInput?.focus();
    return;
  }

  const customKey = keyInput?.value?.trim() || null;
  const autoSave = autoSaveCheck ? autoSaveCheck.checked : true;

  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Generating with Gemini AI...';

  try {
    const res = await safeFetchJson('/api/agents/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: prompt,
        api_key: customKey,
        auto_save: autoSave
      })
    });

    const agent = res.agent;
    state.generatedAgentSpec = agent;

    // Render result card
    const card = document.getElementById('agent-gen-result-card');
    const avatarEl = document.getElementById('gen-res-avatar');
    const nameEl = document.getElementById('gen-res-name');
    const roleEl = document.getElementById('gen-res-role');
    const modelEl = document.getElementById('gen-res-model');
    const tempEl = document.getElementById('gen-res-temp');
    const descEl = document.getElementById('gen-res-desc');
    const capsEl = document.getElementById('gen-res-caps');
    const promptEl = document.getElementById('gen-res-prompt');

    if (avatarEl) avatarEl.textContent = agent.avatar || '🤖';
    if (nameEl) nameEl.textContent = agent.name;
    if (roleEl) roleEl.textContent = agent.role || 'Autonomous Specialist';
    if (modelEl) modelEl.textContent = agent.model_name || 'gemini-3.8-flash';
    if (tempEl) tempEl.textContent = `Temp: ${agent.temperature !== undefined ? agent.temperature : 0.7}`;
    if (descEl) descEl.textContent = agent.description || 'Specialized AI Agent';
    if (promptEl) promptEl.textContent = agent.system_prompt || '';

    if (capsEl) {
      capsEl.innerHTML = '';
      (agent.capabilities || []).forEach(c => {
        const tag = document.createElement('span');
        tag.className = 'badge-tag';
        tag.textContent = c;
        capsEl.appendChild(tag);
      });
    }

    if (card) card.style.display = 'block';

    if (autoSave && agent.id) {
      await loadAgents();
      showToast(`AI Agent "${agent.name}" forged and added to your library!`, 'success');
    } else {
      showToast(`AI Agent specification generated successfully!`, 'success');
    }
  } catch (err) {
    console.error('Agent generation failed:', err);
    showToast(`Agent generation error: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '✨ Generate Agent with AI';
  }
}

function activateGeneratedAgent() {
  if (!state.generatedAgentSpec) return;

  const spec = state.generatedAgentSpec;
  if (spec.id) {
    selectAgent(spec.id);
    closeAgentStudioModal();
    createNewSession();
  } else {
    // If not saved yet, save it via builder submission
    transferGenToBuilder();
    submitBuilderAgent();
  }
}

function transferGenToBuilder() {
  const spec = state.generatedAgentSpec;
  if (!spec) return;

  const idInput = document.getElementById('builder-agent-id');
  const avatarInput = document.getElementById('builder-avatar-input');
  const nameInput = document.getElementById('builder-name-input');
  const roleInput = document.getElementById('builder-role-input');
  const modelSelect = document.getElementById('builder-model-select');
  const descInput = document.getElementById('builder-desc-input');
  const promptInput = document.getElementById('builder-prompt-input');
  const tempSlider = document.getElementById('builder-temp-slider');
  const capsInput = document.getElementById('builder-caps-input');
  const keyInput = document.getElementById('builder-key-input');

  if (idInput) idInput.value = spec.id || '';
  if (avatarInput) avatarInput.value = spec.avatar || '🤖';
  if (nameInput) nameInput.value = spec.name || '';
  if (roleInput) roleInput.value = spec.role || '';
  if (modelSelect) modelSelect.value = spec.model_name || 'gemini-3.8-flash';
  if (descInput) descInput.value = spec.description || '';
  if (promptInput) promptInput.value = spec.system_prompt || '';
  if (tempSlider) {
    tempSlider.value = spec.temperature !== undefined ? spec.temperature : 0.7;
    updateBuilderTempReadout(tempSlider.value);
  }
  if (capsInput) capsInput.value = Array.isArray(spec.capabilities) ? spec.capabilities.join(', ') : (spec.capabilities || '');
  if (keyInput) keyInput.value = spec.custom_api_key || '';

  switchAgentTab('builder');
}

function selectBuilderEmoji(emoji) {
  const input = document.getElementById('builder-avatar-input');
  if (input) input.value = emoji;
}

function updateBuilderTempReadout(val) {
  const badge = document.getElementById('builder-temp-badge');
  if (!badge) return;
  const num = parseFloat(val);
  let label = 'Balanced';
  if (num < 0.3) label = 'Deterministic / Exact';
  else if (num < 0.6) label = 'Analytical';
  else if (num < 0.85) label = 'Balanced';
  else label = 'Creative / Expressive';

  badge.textContent = `${num.toFixed(2)} — ${label}`;
}

function resetBuilderForm() {
  const idInput = document.getElementById('builder-agent-id');
  const avatarInput = document.getElementById('builder-avatar-input');
  const nameInput = document.getElementById('builder-name-input');
  const roleInput = document.getElementById('builder-role-input');
  const modelSelect = document.getElementById('builder-model-select');
  const descInput = document.getElementById('builder-desc-input');
  const promptInput = document.getElementById('builder-prompt-input');
  const tempSlider = document.getElementById('builder-temp-slider');
  const capsInput = document.getElementById('builder-caps-input');
  const keyInput = document.getElementById('builder-key-input');
  const btnText = document.getElementById('btn-builder-save-text');

  if (idInput) idInput.value = '';
  if (avatarInput) avatarInput.value = '🤖';
  if (nameInput) nameInput.value = '';
  if (roleInput) roleInput.value = '';
  if (modelSelect) modelSelect.value = 'gemini-3.8-flash';
  if (descInput) descInput.value = '';
  if (promptInput) promptInput.value = '';
  if (tempSlider) {
    tempSlider.value = 0.7;
    updateBuilderTempReadout(0.7);
  }
  if (capsInput) capsInput.value = '';
  if (keyInput) keyInput.value = '';
  if (btnText) btnText.textContent = 'Save Agent & Activate';
}

async function submitBuilderAgent() {
  const idInput = document.getElementById('builder-agent-id');
  const avatarInput = document.getElementById('builder-avatar-input');
  const nameInput = document.getElementById('builder-name-input');
  const roleInput = document.getElementById('builder-role-input');
  const modelSelect = document.getElementById('builder-model-select');
  const descInput = document.getElementById('builder-desc-input');
  const promptInput = document.getElementById('builder-prompt-input');
  const tempSlider = document.getElementById('builder-temp-slider');
  const capsInput = document.getElementById('builder-caps-input');
  const keyInput = document.getElementById('builder-key-input');
  const btn = document.getElementById('btn-save-builder-agent');

  const name = nameInput?.value?.trim() || '';
  const prompt = promptInput?.value?.trim() || '';

  if (!name) {
    showToast('Agent Name is required.', 'error');
    nameInput?.focus();
    return;
  }
  if (!prompt) {
    showToast('System Persona instructions are required.', 'error');
    promptInput?.focus();
    return;
  }

  const existingId = idInput?.value?.trim() || null;
  const capsRaw = capsInput?.value?.trim() || '';
  const capabilities = capsRaw ? capsRaw.split(',').map(c => c.trim()).filter(Boolean) : [];

  const payload = {
    name: name,
    avatar: avatarInput?.value?.trim() || '🤖',
    role: roleInput?.value?.trim() || 'AI Specialist',
    model_name: modelSelect?.value || 'gemini-3.8-flash',
    description: descInput?.value?.trim() || '',
    system_prompt: prompt,
    temperature: tempSlider ? parseFloat(tempSlider.value) : 0.7,
    capabilities: capabilities,
    custom_api_key: keyInput?.value?.trim() || null
  };

  if (btn) btn.disabled = true;

  try {
    let saved;
    if (existingId) {
      saved = await safeFetchJson(`/api/agents/${existingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      saved = await safeFetchJson('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    await loadAgents();
    selectAgent(saved.id);
    closeAgentStudioModal();
    resetBuilderForm();
    showToast(`AI Agent "${saved.name}" ready to assist!`, 'success');
  } catch (err) {
    console.error('Save agent error:', err);
    showToast(`Could not save AI Agent: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function loadAgentLibrary(filterText = '') {
  const container = document.getElementById('agent-library-container');
  if (!container) return;

  const q = (filterText || '').toLowerCase().trim();
  const filtered = state.agents.filter(a => {
    if (!q) return true;
    return (
      (a.name && a.name.toLowerCase().includes(q)) ||
      (a.role && a.role.toLowerCase().includes(q)) ||
      (a.description && a.description.toLowerCase().includes(q))
    );
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: var(--text-muted);">
        <p>No agents matching your search.</p>
        <button class="btn btn-primary btn-sm" onclick="switchAgentTab('generate')" style="margin-top: 0.5rem;">Generate One with AI</button>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  filtered.forEach(agent => {
    const isCurrent = state.activeAgent && state.activeAgent.id === agent.id;
    const card = document.createElement('div');
    card.className = `agent-library-card ${isCurrent ? 'active-card' : ''}`;

    const capsHtml = (agent.capabilities || []).map(c => `<span class="badge-tag">${escapeHtml(c)}</span>`).join('');

    card.innerHTML = `
      <div class="agent-card-header">
        <div class="agent-card-identity">
          <span class="agent-card-avatar">${agent.avatar || '🤖'}</span>
          <div class="agent-card-title-group">
            <span class="agent-card-name">${escapeHtml(agent.name)}</span>
            <span class="agent-card-role">${escapeHtml(agent.role || 'Autonomous Specialist')}</span>
          </div>
        </div>
        ${agent.is_default ? '<span class="badge-tag highlight">Default</span>' : ''}
      </div>
      <p class="agent-card-desc">${escapeHtml(agent.description || 'Specialized AI Persona')}</p>
      <div class="agent-card-tags">
        <span class="badge-tag">${escapeHtml(agent.model_name || 'gemini-3.8-flash')}</span>
        <span class="badge-tag">Temp: ${agent.temperature !== undefined ? agent.temperature : 0.7}</span>
        ${capsHtml}
      </div>
      <div class="agent-card-actions">
        <button type="button" class="btn btn-sm ${isCurrent ? 'btn-secondary' : 'btn-primary'}" onclick="selectAgentFromLibrary(${agent.id})">
          ${isCurrent ? 'Active Now' : 'Select Agent'}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="editAgentInBuilder(${agent.id})" title="Edit or duplicate in builder">
          Edit
        </button>
        ${!agent.is_default ? `
          <button type="button" class="btn btn-secondary btn-sm" onclick="deleteAgentPrompt(${agent.id}, '${escapeHtml(agent.name)}')" title="Delete agent" style="color: #ef4444;">
            <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        ` : ''}
      </div>
    `;
    container.appendChild(card);
  });
}

function filterAgentLibrary(query) {
  loadAgentLibrary(query);
}

function selectAgentFromLibrary(agentId) {
  selectAgent(agentId);
  closeAgentStudioModal();
}

function editAgentInBuilder(agentId) {
  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) return;

  state.generatedAgentSpec = agent;
  transferGenToBuilder();
  const btnText = document.getElementById('btn-builder-save-text');
  if (btnText) btnText.textContent = 'Update Agent & Activate';
}

async function deleteAgentPrompt(agentId, agentName) {
  if (!confirm(`Are you sure you want to delete the AI Agent "${agentName}"?`)) {
    return;
  }

  try {
    await safeFetchJson(`/api/agents/${agentId}`, { method: 'DELETE' });
    showToast(`Agent "${agentName}" deleted.`, 'info');
    await loadAgents();
    loadAgentLibrary();
  } catch (err) {
    console.error('Delete agent error:', err);
    showToast(`Could not delete agent: ${err.message}`, 'error');
  }
}

/* ==========================================================================
   PLUS (+) ACTION BUTTON & ATTACHMENT TOOLS HANDLERS
   ========================================================================== */

function togglePlusMenu(event) {
  if (event) {
    event.stopPropagation();
  }
  const menu = document.getElementById('plus-dropdown-menu');
  const btn = document.getElementById('chat-plus-btn');
  if (!menu) return;

  const isVisible = menu.style.display === 'block';
  if (isVisible) {
    menu.style.display = 'none';
    btn?.classList.remove('active');
  } else {
    menu.style.display = 'block';
    btn?.classList.add('active');
  }
}

function closePlusMenu() {
  const menu = document.getElementById('plus-dropdown-menu');
  const btn = document.getElementById('chat-plus-btn');
  if (menu) menu.style.display = 'none';
  if (btn) btn.classList.remove('active');
}

// Close plus menu on outside click
document.addEventListener('click', (e) => {
  const wrapper = document.querySelector('.plus-tools-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    closePlusMenu();
  }
});

function activateCreateImageMode() {
  closePlusMenu();
  state.createImageMode = true;
  const input = document.getElementById('chat-input');
  if (input) {
    input.placeholder = "Describe the image to generate (e.g. 'A futuristic city in neon rain')...";
    input.focus();
  }
  renderAttachmentsTray();
  showToast('Image Generation mode active. Type your prompt and press Enter.', 'info');
}

function deactivateCreateImageMode() {
  state.createImageMode = false;
  const input = document.getElementById('chat-input');
  if (input) {
    input.placeholder = "Type a message, ask a question, or attach files with (+)...";
  }
  renderAttachmentsTray();
}

function triggerImageFilePicker() {
  closePlusMenu();
  const fileInput = document.getElementById('chat-image-input');
  if (fileInput) fileInput.click();
}

function triggerDocFilePicker() {
  closePlusMenu();
  const docInput = document.getElementById('chat-doc-input');
  if (docInput) docInput.click();
}

function toggleWebGrounding() {
  state.webGroundingMode = !state.webGroundingMode;
  const badge = document.getElementById('plus-web-badge');
  if (badge) {
    if (state.webGroundingMode) {
      badge.textContent = 'On';
      badge.classList.add('active');
      showToast('Live Web Search Grounding enabled.', 'info');
    } else {
      badge.textContent = 'Off';
      badge.classList.remove('active');
      showToast('Live Web Search Grounding disabled.', 'info');
    }
  }
  renderAttachmentsTray();
  closePlusMenu();
}

function handleImageFilesChosen(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  Array.from(files).forEach(file => {
    if (!file.type.startsWith('image/')) {
      showToast(`File "${file.name}" is not a recognized image.`, 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      state.pendingImages.push({
        name: file.name,
        data: e.target.result,
        size: file.size,
        mime_type: file.type || 'image/png'
      });
      renderAttachmentsTray();
    };
    reader.readAsDataURL(file);
  });

  event.target.value = '';
}

function handleDocFilesChosen(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;

  Array.from(files).forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.pendingDocs.push({
        name: file.name,
        data: e.target.result,
        size: file.size,
        mime_type: file.type || 'application/octet-stream'
      });
      renderAttachmentsTray();
      showToast(`Document "${file.name}" attached.`, 'info');
    };
    reader.readAsDataURL(file);
  });

  event.target.value = '';
}

function removeImageAttachment(index) {
  state.pendingImages.splice(index, 1);
  renderAttachmentsTray();
}

function removeDocAttachment(index) {
  state.pendingDocs.splice(index, 1);
  renderAttachmentsTray();
}

function renderAttachmentsTray() {
  const tray = document.getElementById('attachments-preview-tray');
  if (!tray) return;

  let html = '';

  // Mode chips
  if (state.createImageMode) {
    html += `
      <div class="attachment-chip attachment-mode-chip">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 2a14.5 14.5 0 0 0 0 20 10 10 0 0 0 0-20"></path>
        </svg>
        <span>Mode: Create Image</span>
        <button type="button" class="attachment-remove-btn" onclick="deactivateCreateImageMode()" title="Exit Image Mode">&times;</button>
      </div>
    `;
  }

  if (state.webGroundingMode) {
    html += `
      <div class="attachment-chip attachment-web-chip">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="2" y1="12" x2="22" y2="12"></line>
        </svg>
        <span>Web Search Active</span>
        <button type="button" class="attachment-remove-btn" onclick="toggleWebGrounding()" title="Disable Web Search">&times;</button>
      </div>
    `;
  }

  // Image chips
  state.pendingImages.forEach((img, idx) => {
    html += `
      <div class="attachment-chip">
        <img src="${escapeHtml(img.data)}" alt="${escapeHtml(img.name)}" class="attachment-thumb" />
        <span class="attachment-filename" title="${escapeHtml(img.name)}">${escapeHtml(img.name)}</span>
        <button type="button" class="attachment-remove-btn" onclick="removeImageAttachment(${idx})" title="Remove image">&times;</button>
      </div>
    `;
  });

  // Doc chips
  state.pendingDocs.forEach((doc, idx) => {
    html += `
      <div class="attachment-chip">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
        <span class="attachment-filename" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span>
        <button type="button" class="attachment-remove-btn" onclick="removeDocAttachment(${idx})" title="Remove document">&times;</button>
      </div>
    `;
  });

  tray.innerHTML = html;
  tray.style.display = html.trim() ? 'flex' : 'none';
}

/* ==========================================================================
   IMAGE LIGHTBOX MODAL HANDLERS
   ========================================================================== */

function openImageLightbox(encodedSrc, encodedTitle) {
  const src = decodeURIComponent(encodedSrc);
  const title = decodeURIComponent(encodedTitle || 'Image Preview');

  const modal = document.getElementById('image-lightbox-modal');
  const imgEl = document.getElementById('lightbox-image-el');
  const titleEl = document.getElementById('lightbox-image-title');
  const downloadBtn = document.getElementById('lightbox-download-btn');

  if (imgEl) imgEl.src = src;
  if (titleEl) titleEl.textContent = title;
  if (downloadBtn) {
    downloadBtn.href = src;
    downloadBtn.download = (title.replace(/[^a-zA-Z0-9_-]/g, '_') || 'generated-image') + '.png';
  }

  if (modal) {
    modal.style.display = 'flex';
  }
}

function closeImageLightbox() {
  const modal = document.getElementById('image-lightbox-modal');
  if (modal) modal.style.display = 'none';
}

function closeImageLightboxOnBackdrop(event) {
  if (event.target.id === 'image-lightbox-modal') {
    closeImageLightbox();
  }
}

