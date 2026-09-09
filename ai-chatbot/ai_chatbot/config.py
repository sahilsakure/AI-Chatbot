"""
Configuration settings for the Flask AI Chatbot application.
Handles environment variables and application constants.
"""

import os
from datetime import timedelta
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
os.makedirs(INSTANCE_DIR, exist_ok=True)


class Config:
    """Base application configuration."""

    # Secret key for session management and CSRF protection
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-key-super-secure-change-in-prod-994x")

    # SQLite Database configuration
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL", f"sqlite:///{os.path.join(INSTANCE_DIR, 'chatbot.db')}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Google Gemini API configuration
    GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
    GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    # Session security settings
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    PERMANENT_SESSION_LIFETIME = timedelta(days=7)

    # Application constants
    APP_NAME = "Aetheris AI"
    DEFAULT_SYSTEM_PROMPT = (
        "You are Aetheris AI, an enterprise-grade, highly capable, and articulate AI assistant. "
        "Provide thorough, concise, and structured answers using rich GitHub-flavored Markdown. "
        "When generating code, always specify the programming language tag and write idiomatic, clean code."
    )
