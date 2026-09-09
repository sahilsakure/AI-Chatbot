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
            "title": self.title,
            "system_prompt": self.system_prompt,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "message_count": len(self.messages),
        }
        if include_messages:
            data["messages"] = [msg.to_dict() for msg in self.messages]
        return data


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
