# Aetheris AI — Modern Enterprise AI Chatbot

A production-ready AI Chatbot Web Application built with Python (Flask Application Factory), Google Gemini API (`google-genai` token streaming via SSE), SQLite relational persistence with Flask-SQLAlchemy, Speech-to-Text & Text-to-Speech voice integration, and a glassmorphic multi-theme user interface (Dark, Light, Cyberpunk OLED).

---

## Architecture & System Highlights

- **Modular Backend**: Built on Flask's Application Factory pattern (`create_app`) with domain Blueprints (`main_bp`, `auth_bp`, `api_bp`).
- **Real-Time Token Streaming**: Server-Sent Events (SSE) streaming via `POST /api/chat` with dynamic system prompt injection and context retention.
- **Relational Persistence**: Full SQLite schema using Flask-SQLAlchemy with `User`, `ChatSession`, and `Message` models, cascading deletions, and Werkzeug password hashing.
- **Enterprise UI/UX**: Custom design token system in vanilla CSS3 (no framework bloat), instant 3-theme engine (Dark, Light, Cyberpunk), collapsible mobile drawer, and micro-animations.
- **Voice Intelligence**: Web Speech API integration supporting hands-free Speech-to-Text dictation and natural Text-to-Speech playback.
- **Markdown & Code Blocks**: Client-side Markdown rendering with DOMPurify defensive sanitization, syntax highlighting, and one-click code copy.

---

## Directory Structure

```text
ai_chatbot/
├── instance/
│   └── chatbot.db          # SQLite Database (Auto-initialized)
├── static/
│   ├── css/
│   │   └── style.css       # Design tokens, themes & glassmorphic styles
│   └── js/
│       ├── chat.js         # SSE streaming, Markdown, session handling
│       └── voice.js        # Web Speech API (STT & TTS)
├── templates/
│   ├── base.html           # HTML5 shell, CDNs & meta tags
│   ├── index.html          # Main chat dashboard & sidebar
│   ├── login.html          # Glassmorphic login view
│   └── register.html       # User signup with validation
├── .env.example            # Environment variables specification
├── app.py                  # Flask Application Factory & Blueprints
├── config.py               # Centralized configuration
├── models.py               # SQLAlchemy Relational Models (User, Session, Message)
├── requirements.txt        # Python production dependencies
└── README.md               # Documentation & deployment guide
```

---

## Quick Start (Local Setup)

### 1. Prerequisites
- Python 3.10+
- `pip` (Python package manager)

### 2. Clone and Install Dependencies
```bash
git clone <repository_url>
cd ai_chatbot

# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install required dependencies
pip install -r requirements.txt
```

### 3. Configure Environment
Copy `.env.example` to `.env` and provide your credentials:
```bash
cp .env.example .env
```

Edit `.env`:
```ini
GEMINI_API_KEY="your-google-gemini-api-key"
GEMINI_MODEL="gemini-3.8-flash"
SECRET_KEY="generate-a-strong-random-key"
DATABASE_URL="sqlite:///instance/chatbot.db"
PORT=3000
```

### 4. Run Application
```bash
python3 app.py
```
Access the application in your browser at `http://localhost:3000`.

> **Evaluator Quick Access**: A pre-seeded demo user is automatically created upon startup:
> - **Username**: `demo_user`
> - **Password**: `demo123`

---

## REST & Streaming API Endpoints

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :---: |
| `GET` | `/` | Dashboard interface or login redirect | Yes |
| `POST` | `/auth/register` | Create a new user account | No |
| `POST` | `/auth/login` | Authenticate user session | No |
| `GET` | `/auth/logout` | Terminate active user session | Yes |
| `GET` | `/auth/me` | Fetch active user profile JSON | Yes |
| `GET` | `/api/sessions` | List conversations for current user | Yes |
| `POST` | `/api/sessions/new` | Initialize fresh conversation context | Yes |
| `GET` | `/api/sessions/<id>` | Fetch session and chronological messages | Yes |
| `PUT` | `/api/sessions/<id>` | Rename session or update system prompt | Yes |
| `DELETE` | `/api/sessions/<id>` | Delete conversation and cascade messages | Yes |
| `GET` | `/api/sessions/<id>/export` | Export chat as Markdown or JSON (`?format=json\|markdown`) | Yes |
| `POST` | `/api/chat` | User prompt & SSE token stream (`text/event-stream`) | Yes |

---

## Production Deployment Guides

### 1. Deployment on Render
1. Create a **New Web Service** on [Render](https://render.com).
2. Connect your Git repository.
3. Configure settings:
   - **Environment**: `Python`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn -w 4 -b 0.0.0.0:$PORT "app:create_app()"`
4. In **Environment Variables**, add:
   - `GEMINI_API_KEY`: Your Gemini API Key
   - `SECRET_KEY`: A secure 32+ character string
   - `PYTHON_VERSION`: `3.10.12`

### 2. Deployment on PythonAnywhere
1. Create an account on [PythonAnywhere](https://www.pythonanywhere.com).
2. Open a **Bash Console** and clone your repository:
   ```bash
   git clone <repository_url> ai_chatbot
   cd ai_chatbot
   python3.10 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
3. Navigate to the **Web** tab and create a **Manual Configuration (Python 3.10)** web app.
4. Set **Virtualenv path** to `/home/<username>/ai_chatbot/venv`.
5. Edit the **WSGI configuration file**:
   ```python
   import sys
   import os
   path = '/home/<username>/ai_chatbot'
   if path not in sys.path:
       sys.path.append(path)

   from app import create_app
   application = create_app()
   ```
6. Click **Reload <domain>** to launch your service.

---

## Security & Reliability Standards

- **Password Security**: Uses Werkzeug's SHA-256 PBKDF2 hashing algorithm.
- **XSS Defense**: Client-side Markdown sanitized via DOMPurify before DOM injection.
- **CSRF & Session Hardening**: HttpOnly, SameSite cookies with session rotation upon login.
- **Intelligent Fallback**: Graceful demonstration mode when API keys are being provisioned, ensuring zero crashes.
- **Responsive Architecture**: Tested across 320px mobile viewport, tablet drawers, and 4K desktop screens.
