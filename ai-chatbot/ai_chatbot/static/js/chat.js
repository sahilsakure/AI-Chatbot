/**
 * Aetheris AI — Production Chat Engine
 * Handles SSE token streaming, Markdown parsing with XSS sanitization, syntax highlighting,
 * intelligent auto-scrolling, session lifecycle, and multi-theme management.
 */

// Application State
const state = {
  activeSessionId: null,
  activeSessionTitle: 'New Conversation',
  systemPrompt: null,
  isStreaming: false,
  streamAbortController: null,
  userScrolledUp: false,
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
      ADD_ATTR: ['onclick', 'target', 'class'],
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

function initInitialSession() {
  const firstItem = document.querySelector('.session-item');
  if (firstItem) {
    const sessionId = firstItem.getAttribute('data-session-id');
    loadSession(sessionId);
  } else {
    // Show welcome state
    updateActiveSessionUI(null, 'New Conversation');
  }
}

async function loadSession(sessionId) {
  if (state.isStreaming) {
    stopStreaming();
  }

  state.activeSessionId = sessionId;
  highlightActiveSession(sessionId);

  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    if (!res.ok) throw new Error('Failed to fetch session');
    const data = await res.json();

    state.activeSessionTitle = data.title;
    state.systemPrompt = data.system_prompt;
    updateActiveSessionUI(data.id, data.title);

    renderMessagesList(data.messages || []);
    closeMobileSidebar();
  } catch (err) {
    console.error('[Session] Load error:', err);
    showToast('Error loading conversation.', 'error');
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
    const res = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'New Conversation',
        system_prompt: state.systemPrompt
      })
    });

    if (!res.ok) throw new Error('Failed to create session');
    const newSession = await res.json();

    // Prepend to sessions list
    prependSessionItem(newSession);
    await loadSession(newSession.id);
    showToast('New conversation initialized.', 'info');
  } catch (err) {
    console.error('[Session] Create error:', err);
    showToast('Could not initialize conversation.', 'error');
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
      <button class="session-action-btn" title="Rename conversation" onclick="renameSessionPrompt(${session.id}, '${escapeHtml(session.title)}')">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
        </svg>
      </button>
      <button class="session-action-btn delete-btn" title="Delete conversation" onclick="deleteSessionConfirm(${session.id})">
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
    badge.textContent = Math.max(0, current + delta);
  }
}

async function renameCurrentSession() {
  if (!state.activeSessionId) return;
  renameSessionPrompt(state.activeSessionId, state.activeSessionTitle);
}

async function renameSessionPrompt(sessionId, currentTitle) {
  const newTitle = prompt('Rename conversation:', currentTitle);
  if (!newTitle || newTitle.trim() === '' || newTitle === currentTitle) return;

  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() })
    });

    if (!res.ok) throw new Error('Rename failed');
    const updated = await res.json();

    // Update in DOM
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) {
      item.querySelector('.session-title').textContent = updated.title;
      item.querySelector('.session-title').setAttribute('title', updated.title);
    }

    if (state.activeSessionId == sessionId) {
      state.activeSessionTitle = updated.title;
      updateActiveSessionUI(sessionId, updated.title);
    }
    showToast('Conversation renamed.', 'success');
  } catch (err) {
    console.error('Rename error:', err);
    showToast('Could not rename conversation.', 'error');
  }
}

async function deleteSessionConfirm(sessionId) {
  if (!confirm('Are you sure you want to delete this conversation? This action cannot be undone.')) {
    return;
  }

  try {
    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Delete failed');

    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.remove();
    updateSessionCount(-1);

    if (state.activeSessionId == sessionId) {
      state.activeSessionId = null;
      initInitialSession();
    }
    showToast('Conversation deleted.', 'info');
  } catch (err) {
    console.error('Delete error:', err);
    showToast('Could not delete conversation.', 'error');
  }
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

function appendMessageCard(role, content, timestamp = null, animate = true) {
  const stream = document.getElementById('messages-stream');
  const welcome = document.getElementById('welcome-state');
  if (welcome) welcome.style.display = 'none';

  const isUser = role === 'user';
  const timeStr = timestamp ? formatTimestamp(timestamp) : 'Just now';

  const card = document.createElement('div');
  card.className = `message-item ${isUser ? 'user' : 'assistant'}`;
  if (!animate) card.style.animation = 'none';

  if (isUser) {
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
        <div class="msg-bubble">${escapeHtml(content).replace(/\n/g, '<br>')}</div>
      </div>
    `;
  } else {
    card.innerHTML = `
      <div class="msg-avatar assistant-avatar">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
      </div>
      <div class="msg-bubble-wrapper">
        <div class="msg-header">
          <span class="msg-role-name">Aetheris AI</span>
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
  const message = chatInput.value.trim();
  if (!message) return;

  chatInput.value = '';
  autoResizeTextarea(chatInput);

  // Stop any previous speech
  if (window.voiceEngine) {
    window.voiceEngine.stopSpeaking();
  }

  // Append user message immediately to the UI
  appendMessageCard('user', message, new Date().toISOString(), true);
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
        stream: true
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
              assistantCard = appendMessageCard('assistant', '', new Date().toISOString(), true);
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
   MOBILE SIDEBAR DRAWER
   ========================================================================== */

function toggleSidebar() {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (sidebar && backdrop) {
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
