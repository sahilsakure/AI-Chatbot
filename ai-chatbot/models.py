"""
Database models for Users, ChatSessions, and Messages using Flask-SQLAlchemy.
Includes secure password hashing and clean serialization methods.
"""

from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()


class User(db.Model):
    """User account model for authentication and session ownership."""

    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    # Relationship to ChatSessions (cascading delete)
    sessions = db.relationship(
        "ChatSession",
        backref="user",
        lazy=True,
        cascade="all, delete-orphan",
        order_by="desc(ChatSession.updated_at)",
    )

    # Relationship to Agents (cascading delete)
    agents = db.relationship(
        "Agent",
        backref="user",
        lazy=True,
        cascade="all, delete-orphan",
        order_by="desc(Agent.updated_at)",
    )

    def set_password(self, password: str) -> None:
        """Hash and store user password."""
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        """Verify user password against stored hash."""
        return check_password_hash(self.password_hash, password)

    def to_dict(self) -> dict:
        """Serialize user object to dictionary."""
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "created_at": self.created_at.isoformat(),
            "session_count": len(self.sessions),
        }


class ChatSession(db.Model):
    """Chat session container representing a distinct conversation thread."""

    __tablename__ = "chat_sessions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    agent_id = db.Column(db.Integer, db.ForeignKey("agents.id", ondelete="SET NULL"), nullable=True, index=True)
    title = db.Column(db.String(200), default="New Chat", nullable=False)
    system_prompt = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationship to Messages (cascading delete, ordered chronologically)
    messages = db.relationship(
        "Message",
        backref="session",
        lazy=True,
        cascade="all, delete-orphan",
        order_by="Message.timestamp",
    )

    def to_dict(self, include_messages: bool = False) -> dict:
        """Serialize chat session object to dictionary."""
        data = {
            "id": self.id,
            "user_id": self.user_id,
            "agent_id": self.agent_id,
            "agent": self.agent.to_dict() if self.agent else None,
            "title": self.title,
            "system_prompt": self.system_prompt,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "message_count": len(self.messages),
        }
        if include_messages:
            data["messages"] = [msg.to_dict() for msg in self.messages]
        return data


class Agent(db.Model):
    """Custom AI Agent with specialized persona, capabilities, model configs, and prompt."""

    __tablename__ = "agents"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = db.Column(db.String(100), nullable=False)
    role = db.Column(db.String(150), nullable=False)
    avatar = db.Column(db.String(30), default="🤖", nullable=False)
    description = db.Column(db.String(300), nullable=True)
    system_prompt = db.Column(db.Text, nullable=False)
    temperature = db.Column(db.Float, default=0.7, nullable=False)
    capabilities = db.Column(db.Text, default="[]", nullable=False)  # JSON array string
    model = db.Column(db.String(60), default="gemini-3.8-flash", nullable=False)
    api_key = db.Column(db.String(255), nullable=True)
    is_default = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationship to sessions
    sessions = db.relationship("ChatSession", backref="agent", lazy=True)

    def to_dict(self) -> dict:
        """Serialize agent object to dictionary."""
        import json
        caps = []
        try:
            caps = json.loads(self.capabilities) if self.capabilities else []
        except Exception:
            caps = [c.strip() for c in (self.capabilities or "").split(",") if c.strip()]

        return {
            "id": self.id,
            "user_id": self.user_id,
            "name": self.name,
            "role": self.role,
            "avatar": self.avatar,
            "description": self.description or "",
            "system_prompt": self.system_prompt,
            "temperature": float(self.temperature if self.temperature is not None else 0.7),
            "capabilities": caps,
            "model": self.model,
            "has_custom_api_key": bool(self.api_key and self.api_key.strip()),
            "is_default": bool(self.is_default),
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class Message(db.Model):
    """Individual message log within a chat session."""

    __tablename__ = "messages"

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(
        db.Integer, db.ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role = db.Column(db.String(20), nullable=False)  # 'user' | 'assistant' | 'system'
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self) -> dict:
        """Serialize message object to dictionary."""
        return {
            "id": self.id,
            "session_id": self.session_id,
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
        }
