/**
 * Aetheris AI — Voice Engine
 * Web Speech API implementation for Speech-to-Text (Dictation) and Text-to-Speech (Playback).
 */

class VoiceEngine {
  constructor() {
    this.recognition = null;
    this.isRecording = false;
    this.autoTTS = localStorage.getItem('aetheris_auto_tts') === 'true';
    this.currentUtterance = null;

    this.initSpeechRecognition();
    this.initTTSState();
  }

  /* ==========================================================================
     SPEECH-TO-TEXT (VOICE DICTATION)
     ========================================================================== */
  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[VoiceEngine] Web SpeechRecognition API is not supported in this browser.');
      return;
    }

    try {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      this.recognition.onstart = () => {
        this.isRecording = true;
        this.updateMicUI(true);
        if (typeof showToast === 'function') {
          showToast('Voice dictation active. Speak clearly into your mic...', 'info');
        }
      };

      this.recognition.onresult = (event) => {
        const chatInput = document.getElementById('chat-input');
        if (!chatInput) return;

        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        if (finalTranscript) {
          const currentVal = chatInput.value;
          const space = currentVal && !currentVal.endsWith(' ') ? ' ' : '';
          chatInput.value = currentVal + space + finalTranscript.trim();
          if (typeof autoResizeTextarea === 'function') {
            autoResizeTextarea(chatInput);
          }
        }
      };

      this.recognition.onerror = (event) => {
        console.error('[VoiceEngine] Recognition error:', event.error);
        this.stopRecording();
        if (event.error === 'not-allowed') {
          if (typeof showToast === 'function') {
            showToast('Microphone permission denied. Please allow microphone access.', 'error');
          }
        } else if (event.error !== 'no-speech') {
          if (typeof showToast === 'function') {
            showToast(`Voice error: ${event.error}`, 'error');
          }
        }
      };

      this.recognition.onend = () => {
        this.isRecording = false;
        this.updateMicUI(false);
      };
    } catch (err) {
      console.error('[VoiceEngine] Failed to initialize SpeechRecognition:', err);
    }
  }

  toggleRecording() {
    if (!this.recognition) {
      if (typeof showToast === 'function') {
        showToast('Speech-to-Text is not supported on this browser or environment.', 'error');
      }
      return;
    }

    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  startRecording() {
    if (!this.recognition) return;
    try {
      this.recognition.start();
    } catch (e) {
      console.warn('[VoiceEngine] Recognition start exception:', e);
    }
  }

  stopRecording() {
    if (!this.recognition || !this.isRecording) return;
    try {
      this.recognition.stop();
    } catch (e) {
      console.warn('[VoiceEngine] Recognition stop exception:', e);
    }
    this.isRecording = false;
    this.updateMicUI(false);
  }

  updateMicUI(recording) {
    const micBtn = document.getElementById('mic-btn');
    if (!micBtn) return;
    if (recording) {
      micBtn.classList.add('recording');
      micBtn.setAttribute('title', 'Listening... Click to stop recording');
    } else {
      micBtn.classList.remove('recording');
      micBtn.setAttribute('title', 'Voice Dictation (Speech-to-Text)');
    }
  }

  /* ==========================================================================
     TEXT-TO-SPEECH (PLAYBACK)
     ========================================================================== */
  initTTSState() {
    const toggle = document.getElementById('tts-global-toggle');
    if (toggle) {
      toggle.checked = this.autoTTS;
    }
  }

  setAutoTTS(enabled) {
    this.autoTTS = enabled;
    localStorage.setItem('aetheris_auto_tts', enabled ? 'true' : 'false');
    if (typeof showToast === 'function') {
      showToast(enabled ? 'Auto-Speak enabled for assistant responses.' : 'Auto-Speak disabled.', 'info');
    }
    if (!enabled) {
      this.stopSpeaking();
    }
  }

  cleanTextForSpeech(markdownText) {
    // Strip code blocks, markdown links, headers, backticks, asterisks for clean audible speech
    return markdownText
      .replace(/```[\s\S]*?```/g, ' [code omitted] ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
      .replace(/[#*_~>]/g, '')
      .replace(/\n+/g, ' ')
      .trim();
  }

  speak(text, buttonElement = null) {
    if (!('speechSynthesis' in window)) {
      if (typeof showToast === 'function') {
        showToast('Text-to-Speech is not supported in this browser.', 'error');
      }
      return;
    }

    // If already speaking the same thing, stop
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      this.resetSpeakingUI();
      if (buttonElement && buttonElement.classList.contains('speaking')) {
        return;
      }
    }

    const cleanText = this.cleanTextForSpeech(text);
    if (!cleanText) return;

    this.currentUtterance = new SpeechSynthesisUtterance(cleanText);
    this.currentUtterance.rate = 1.0;
    this.currentUtterance.pitch = 1.0;

    // Pick natural voice if available
    const voices = window.speechSynthesis.getVoices();
    const englishVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha')));
    if (englishVoice) {
      this.currentUtterance.voice = englishVoice;
    }

    if (buttonElement) {
      buttonElement.classList.add('speaking');
      const label = buttonElement.querySelector('span');
      if (label) label.textContent = 'Stop Audio';
    }

    this.currentUtterance.onend = () => {
      this.resetSpeakingUI();
    };

    this.currentUtterance.onerror = () => {
      this.resetSpeakingUI();
    };

    window.speechSynthesis.speak(this.currentUtterance);
  }

  stopSpeaking() {
    if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
    }
    this.resetSpeakingUI();
  }

  resetSpeakingUI() {
    document.querySelectorAll('.msg-footer-btn.speaking').forEach(btn => {
      btn.classList.remove('speaking');
      const label = btn.querySelector('span');
      if (label) label.textContent = 'Read Aloud';
    });
  }
}

// Global instance
const voiceEngine = new VoiceEngine();

function toggleVoiceDictation() {
  voiceEngine.toggleRecording();
}

function toggleAutoTTS(enabled) {
  voiceEngine.setAutoTTS(enabled);
}

function speakMessage(text, btn) {
  voiceEngine.speak(text, btn);
}
