"""
Configuration settings for the Flask AI Chatbot application.
Handles environment variables and application constants.
"""

import os
from datetime import timedelta
from dotenv import load_dotenv

# Load environment variables from .env file with override
load_dotenv(override=True)

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
os.makedirs(INSTANCE_DIR, exist_ok=True)


class Config:
    """Base application configuration."""

    # Secret key for session management and CSRF protection
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-super-secure-change-in-prod-994x")

    # SQLite Database configuration
    _db_url = os.environ.get("DATABASE_URL", "").strip()
    if not _db_url or "sqlite:///" in _db_url:
        SQLALCHEMY_DATABASE_URI = f"sqlite:///{os.path.join(INSTANCE_DIR, 'chatbot.db')}"
    else:
        SQLALCHEMY_DATABASE_URI = _db_url
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Google Gemini API configuration
    USER_CONFIGURED_KEY = "AQ.Ab8RN6LpfJZg-n9xIx4eGvWRLRKwcjpKk0XMMYOyw2IdhArP5g"
    GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY") or USER_CONFIGURED_KEY
    _env_model = os.environ.get("GEMINI_MODEL", "").strip()
    GEMINI_MODEL = (
        _env_model
        if (_env_model.startswith("gemini-") or _env_model.startswith("models/gemini-") or "llama" in _env_model)
        else "gemini-2.5-flash"
    )

    # Session security settings for iframe and workstation compatibility
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "None"
    SESSION_COOKIE_SECURE = True
    PERMANENT_SESSION_LIFETIME = timedelta(days=7)

    # Application constants
    APP_NAME = "Aetheris AI"
    DEFAULT_SYSTEM_PROMPT = (
        "You are Aetheris AI, an enterprise-grade, highly capable, and articulate AI assistant. "
        "Provide thorough, concise, and structured answers using rich GitHub-flavored Markdown. "
        "When generating code, always specify the programming language tag and write idiomatic, clean code."
    )
