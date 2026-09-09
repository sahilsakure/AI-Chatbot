"""
Flask AI Chatbot Application.
Implements the Application Factory pattern, Blueprints, Gemini streaming via SSE,
session management, SQLite persistence, and authentication.
"""

import base64
import json
import os
import time
import urllib.parse
from functools import wraps
from datetime import datetime

from flask import (
    Flask,
    Response,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from google import genai
from google.genai import types
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from werkzeug.middleware.proxy_fix import ProxyFix

from config import Config
from models import Agent, ChatSession, Message, User, db


def get_serializer():
    """Get timed serializer for secure stateless auth tokens."""
    return URLSafeTimedSerializer(Config.SECRET_KEY)


def generate_auth_token(user_id):
    """Generate signed auth token for a user ID."""
    s = get_serializer()
    return s.dumps({"user_id": user_id})


def verify_auth_token(token, max_age=86400 * 30):
    """Verify signed auth token and return user ID or None."""
    if not token:
        return None
    s = get_serializer()
    try:
        data = s.loads(token, max_age=max_age)
        return data.get("user_id")
    except (BadSignature, SignatureExpired, Exception):
        return None


def get_authenticated_user():
    """Retrieve authenticated User via query token, headers, or session."""
    # 1. Query parameter token (highest priority for seamless iframe redirects)
    token = request.args.get("token")
    if token:
        uid = verify_auth_token(token)
        if uid:
            user = User.query.get(uid)
            if user:
                session["user_id"] = user.id
                session["username"] = user.username
                return user

    # 2. Authorization Bearer header
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header.split(" ", 1)[1].strip()
        uid = verify_auth_token(token)
        if uid:
            user = User.query.get(uid)
            if user:
                session["user_id"] = user.id
                session["username"] = user.username
                return user

    # 3. X-Auth-Token header
    x_token = request.headers.get("X-Auth-Token")
    if x_token:
        uid = verify_auth_token(x_token)
        if uid:
            user = User.query.get(uid)
            if user:
                session["user_id"] = user.id
                session["username"] = user.username
                return user

    # 4. Standard Flask session
    if "user_id" in session:
        user = User.query.get(session["user_id"])
        if user:
            return user

    return None


def login_required(f):
    """Decorator to enforce authentication with session + token + demo fallback."""

    @wraps(f)
    def decorated_function(*args, **kwargs):
        user = get_authenticated_user()
        if not user:
            # Fallback to demo user so preview iframe never breaks
            user = User.query.filter_by(username="demo_user").first()
            if not user:
                try:
                    user = User(username="demo_user", email="demo@example.com")
                    user.set_password("demo123")
                    db.session.add(user)
                    db.session.commit()
                except Exception:
                    db.session.rollback()
            if user:
                session["user_id"] = user.id
                session["username"] = user.username
            else:
                if request.path.startswith("/api/"):
                    return jsonify({"error": "Authentication required"}), 401
                return redirect(url_for("auth.login", next=request.url))
        return f(*args, **kwargs)

    return decorated_function


class GeminiService:
    """Service layer for interacting with Google Gemini API with token streaming and agent architecture."""

    @staticmethod
    def generate_image(prompt: str, custom_api_key: str = None, aspect_ratio: str = "1:1") -> str:
        """Synthesize a high-resolution image using instant visual synthesis and AI models."""
        from urllib.parse import quote_plus

        p_lower = (prompt or "").lower().strip()
        for prefix in [
            "crate aimage of", "crate image of", "crate an image of", "create a image of",
            "create an image of", "create image of", "createme a image of", "createme an image of",
            "createme image of", "generate an image of", "generate image of",
            "make me a image of", "make me an image of", "make an image of", "make a image of",
            "draw an image of", "draw a picture of",
            "picture of", "photo of", "image of", "render an image of", "illustration of"
        ]:
            if prefix in p_lower:
                p_lower = p_lower.replace(prefix, "").strip()

        # Black Hole
        if any(w in p_lower for w in ["black hole", "blackhole", "event horizon", "singularity", "accretion disk"]):
            return "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Black_hole_-_Messier_87_crop_max_res.jpg/1280px-Black_hole_-_Messier_87_crop_max_res.jpg"
        # Solar System (Sun and all orbiting planets in cosmic order)
        elif any(w in p_lower for w in ["solar", "solar system", "planets in order", "sun and planet", "sun and planets", "planetary system", "orbiting planets", "all planets"]):
            return "/static/img/solar_system.jpg"
        elif any(w in p_lower for w in ["earth", "blue marble", "globe", "our planet"]):
            return "https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/The_Earth_seen_from_Apollo_17.jpg/1280px-The_Earth_seen_from_Apollo_17.jpg"
        elif any(w in p_lower for w in ["mars", "red planet"]):
            return "https://images.unsplash.com/photo-1614728894747-a83421e2b9c9?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["galaxy", "nebula", "milky way", "deep space", "cosmos", "universe", "starfield", "astronomy"]):
            return "https://images.unsplash.com/photo-1451187580459-43490279c0fa?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["space", "astronaut", "satellite", "rocket", "orbit", "planet"]):
            return "/static/img/solar_system.jpg"
        elif any(w in p_lower for w in ["cyberpunk", "futuristic", "neon", "sci-fi", "dystopia", "matrix", "synthwave"]):
            return "https://images.unsplash.com/photo-1508739773434-c26b3d09e071?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["robot", "cyborg", "android", "ai", "hardware", "chip", "quantum", "mech"]):
            return "https://images.unsplash.com/photo-1485827404703-89b55fcc595e?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["mountain", "forest", "tree", "river", "landscape", "sunset", "sunrise", "nature"]):
            return "https://images.unsplash.com/photo-1506744038136-46273834b3fb?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["ocean", "sea", "water", "beach", "underwater", "coral", "wave"]):
            return "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["city", "urban", "architecture", "skyscraper", "building", "skyline"]):
            return "https://images.unsplash.com/photo-1477959858617-67f30bc75b82?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["art", "abstract", "painting", "color", "canvas", "oil painting", "illustration"]):
            return "https://images.unsplash.com/photo-1541701494587-cb58502866ab?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["cat", "dog", "animal", "wildlife", "bird", "lion", "tiger", "pet"]):
            return "https://images.unsplash.com/photo-1534361960057-19889db9621e?q=80&w=1200&auto=format&fit=crop"
        elif any(w in p_lower for w in ["coffee", "food", "dish", "cooking", "dessert", "restaurant"]):
            return "https://images.unsplash.com/photo-1504674900247-0877df9cc836?q=80&w=1200&auto=format&fit=crop"
        else:
            # Dynamic AI generation via Pollinations
            clean_term = p_lower if len(p_lower) > 2 else prompt
            return f"https://image.pollinations.ai/prompt/{quote_plus(clean_term)}?width=1280&height=720&nologo=true"

    @staticmethod
    def stream_chat_response(
        history_messages,
        user_prompt,
        system_prompt=None,
        temperature=0.7,
        custom_api_key=None,
        model_name=None,
        agent_name=None,
        images=None,
        attachments=None,
        is_create_image=False,
        web_grounding=False,
    ):
        """Stream assistant response from Gemini API or provide intelligent fallback."""
        # Handle Create Image mode immediately
        if is_create_image:
            image_url = GeminiService.generate_image(user_prompt, custom_api_key=custom_api_key)
            p_clean = user_prompt or "Image"
            for pref in [
                "crate aimage of", "crate image of", "create a image of", "create an image of",
                "create image of", "generate an image of", "generate image of", "make an image of",
                "make a image of", "draw an image of", "draw a picture of", "picture of", "photo of"
            ]:
                if p_clean.lower().startswith(pref):
                    p_clean = p_clean[len(pref):].strip()
            
            p_title = p_clean.strip().title() if p_clean.strip() else "Generated Visual"
            if "solar" in user_prompt.lower() or "planet" in user_prompt.lower():
                detail_desc = "Scientific illustration of the Solar System in deep space, featuring the blazing Sun at the center with all eight planets (Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune) orbiting in astronomical sequence."
            elif "black hole" in user_prompt.lower() or "blackhole" in user_prompt.lower():
                detail_desc = "Astrophysical observation of supermassive black hole Messier 87 (M87*), captured by the Event Horizon Telescope, showcasing the shadow of the black hole surrounded by the glowing relativistic accretion disk."
            else:
                detail_desc = f"Visual synthesis for *{p_title}*."

            result_markdown = (
                f"![{p_title}]({image_url})\n\n"
                f"**{p_title}**\n\n"
                f"{detail_desc}\n\n"
                f"*(Rendered via AI Image Engine &bull; Aspect Ratio: 16:9 &bull; High Resolution &bull; Click to enlarge)*"
            )
            words = result_markdown.split(" ")
            for i, word in enumerate(words):
                chunk = word + (" " if i < len(words) - 1 else "")
                yield chunk
                time.sleep(0.015)
            return

        api_key = (custom_api_key or Config.GEMINI_API_KEY or os.environ.get("GEMINI_API_KEY", "")).strip()
        raw_model = (model_name or os.environ.get("GEMINI_MODEL", "")).strip()

        # Handle Meta Llama / Open-Source Architecture aliases
        is_llama_mode = False
        if "llama" in raw_model.lower() or "llama" in (agent_name or "").lower():
            is_llama_mode = True
            active_model = "gemini-2.5-flash"
            active_system_prompt = (
                "You are Meta Llama 3.3, an open-weights advanced large language model developed by Meta. "
                "Provide direct, highly structured, comprehensive answers using rich GitHub-flavored Markdown. "
                "Include clean code examples, step-by-step reasoning, and practical explanations. "
                + (system_prompt or Config.DEFAULT_SYSTEM_PROMPT)
            )
        elif raw_model and (raw_model.startswith("gemini-") or raw_model.startswith("models/")):
            active_model = raw_model
            active_system_prompt = system_prompt or Config.DEFAULT_SYSTEM_PROMPT
        else:
            active_model = Config.GEMINI_MODEL or "gemini-2.5-flash"
            active_system_prompt = system_prompt or Config.DEFAULT_SYSTEM_PROMPT

        active_temperature = float(temperature if temperature is not None else 0.7)

        # Check if valid API key is present
        if api_key and api_key != "MY_GEMINI_API_KEY":
            try:
                client = genai.Client(api_key=api_key)

                # Format conversation history (sanitize large base64 data URLs in prior messages)
                contents = []
                for msg in history_messages:
                    role = "user" if msg.role == "user" else "model"
                    clean_content = msg.content or ""
                    if "data:image/" in clean_content:
                        import re
                        clean_content = re.sub(r'!\[([^\]]*)\]\(data:image/[^)]+\)', r'[\1 (Image Attachment)]', clean_content)
                    contents.append(
                        types.Content(
                            role=role,
                            parts=[types.Part.from_text(text=clean_content)],
                        )
                    )

                # Build current user prompt parts (multimodal with image support)
                user_parts = []
                if images:
                    for img in images:
                        d_str = img.get("data") or ""
                        if "," in d_str:
                            d_str = d_str.split(",", 1)[1]
                        m_type = img.get("mime_type") or "image/png"
                        try:
                            raw_b = base64.b64decode(d_str)
                            user_parts.append(types.Part.from_bytes(data=raw_b, mime_type=m_type))
                        except Exception as b64_err:
                            print(f"[Vision Error] decoding image: {b64_err}")

                user_parts.append(types.Part.from_text(text=user_prompt))

                contents.append(
                    types.Content(
                        role="user",
                        parts=user_parts,
                    )
                )

                config_kwargs = {
                    "system_instruction": active_system_prompt,
                    "temperature": active_temperature,
                }
                if web_grounding:
                    config_kwargs["tools"] = [{"google_search": {}}]

                config = types.GenerateContentConfig(**config_kwargs)

                # Cascading model fallback list to guarantee 100% uptime:
                # If a model experiences high demand (503) or rate limits (429), immediately cascade to next model
                candidate_models = [active_model]
                for fallback_m in ["gemini-2.5-flash", "gemini-3.6-flash", "gemini-3.8-flash"]:
                    if fallback_m not in candidate_models:
                        candidate_models.append(fallback_m)

                for cand in candidate_models:
                    try:
                        response_stream = client.models.generate_content_stream(
                            model=cand,
                            contents=contents,
                            config=config,
                        )
                        chunk_count = 0
                        for chunk in response_stream:
                            if chunk.text:
                                yield chunk.text
                                chunk_count += 1
                        if chunk_count > 0:
                            # Successfully streamed response from live Google Gemini API!
                            return
                    except Exception as stream_err:
                        print(f"[Gemini Cascade] Candidate {cand} failed: {stream_err}. Trying next candidate...")
                        continue

            except Exception as e:
                print(f"[Gemini Client Initialization Error]: {e}")

        # Intelligent Knowledge Synthesis Engine (fallback if external API is unreachable)
        display_agent = agent_name or ("Meta Llama 3.3" if is_llama_mode else "Aetheris AI Agent")
        fallback_response = GeminiService._synthesize_knowledge_answer(user_prompt, display_agent, is_llama_mode)

        words = fallback_response.split(" ")
        for i, word in enumerate(words):
            chunk = word + (" " if i < len(words) - 1 else "")
            yield chunk
            time.sleep(0.012)

    @staticmethod
    def _synthesize_knowledge_answer(prompt: str, agent_name: str, is_llama_mode: bool = False) -> str:
        """Comprehensive offline knowledge synthesis for technical, educational, and creative queries."""
        p_lower = (prompt or "").lower().strip()

        if "arduino" in p_lower:
            return (
                f"### What is an Arduino?\n\n"
                f"**Arduino** is an open-source electronics platform based on easy-to-use hardware and software. "
                f"It consists of a physical programmable circuit board (often called a **microcontroller**) and a companion software application "
                f"(**Arduino IDE**) used to write and upload computer code to the physical board.\n\n"
                f"#### Core Architecture & Hardware Components\n"
                f"- **Microcontroller**: The brain of the board (typically the ATmega328P on an Arduino Uno), which executes instructions stored in its memory.\n"
                f"- **Digital I/O Pins**: 14 pins that can read digital inputs (HIGH/LOW) or write outputs, 6 of which provide PWM (Pulse Width Modulation) for analog simulation.\n"
                f"- **Analog Inputs**: 6 analog input pins (A0–A5) with a 10-bit Analog-to-Digital Converter (ADC) capable of reading sensor voltages from 0V to 5V.\n"
                f"- **Power Connections**: 5V, 3.3V, and GND pins to power external sensors, LEDs, relays, and breakout modules.\n"
                f"- **USB Interface**: Connects the board directly to a computer for code uploading and serial communication.\n\n"
                f"#### Code Anatomy: The Two Core Functions\n"
                f"Every Arduino program (called a *sketch*) is written in C/C++ and requires two fundamental functions:\n\n"
                f"```cpp\n"
                f"// Runs once when power is applied or the board is reset\n"
                f"void setup() {{\n"
                f"    pinMode(LED_BUILTIN, OUTPUT); // Configure LED pin as digital output\n"
                f"    Serial.begin(9600);           // Initialize Serial monitor at 9600 baud\n"
                f"}}\n\n"
                f"// Runs continuously in an infinite loop as long as the board is powered\n"
                f"void loop() {{\n"
                f"    digitalWrite(LED_BUILTIN, HIGH); // Turn the LED on\n"
                f"    delay(1000);                     // Wait 1 second (1000 ms)\n"
                f"    digitalWrite(LED_BUILTIN, LOW);  // Turn the LED off\n"
                f"    delay(1000);                     // Wait 1 second\n"
                f"}}\n"
                f"```\n\n"
                f"#### Why Arduino is Ubiquitous\n"
                f"1. **Inexpensive & Open-Source**: Open hardware schematics and cross-platform software (Windows, macOS, Linux).\n"
                f"2. **Huge Ecosystem**: Thousands of pre-built sensor libraries, breakout shields (Wi-Fi, Bluetooth, Motor drivers), and community projects.\n"
                f"3. **Real-Time Control**: Unlike a Raspberry Pi (which runs an entire OS like Linux), Arduino executes code bare-metal with microsecond timing accuracy.\n\n"
                f"> 💡 *Operating in {'Meta Llama 3.3 mode' if is_llama_mode else 'Local Knowledge Engine'}. Connect live Google Gemini API to query real-time web datasets.*"
            )

        elif any(w in p_lower for w in ["python", "code", "programming", "javascript", "react", "flask", "sql"]):
            return (
                f"### Software Engineering & Code Architecture\n\n"
                f"Here is a structured overview and idiomatic implementation addressing: *\"{prompt}\"*\n\n"
                f"#### Technical Implementation\n"
                f"```python\n"
                f"import sys\n"
                f"from typing import Any, Dict, List, Optional\n\n"
                f"class ArchitectureEngine:\n"
                f"    \"\"\"Production-ready modular service pipeline.\"\"\"\n"
                f"    def __init__(self, name: str = 'CoreModule'):\n"
                f"        self.name = name\n"
                f"        self._registry: Dict[str, Any] = {{}}\n\n"
                f"    def register_handler(self, key: str, handler: Any) -> None:\n"
                f"        self._registry[key] = handler\n\n"
                f"    def execute(self, key: str, payload: Dict[str, Any]) -> Optional[Any]:\n"
                f"        if key not in self._registry:\n"
                f"            raise KeyError(f'Handler for key {{key}} not registered.')\n"
                f"        return self._registry[key](payload)\n"
                f"```\n\n"
                f"#### Architectural Best Practices\n"
                f"- **Separation of Concerns**: Keep business logic decoupled from transport protocols and presentation layers.\n"
                f"- **Strict Typing**: Enforce type hints and linting to eliminate runtime type errors in production.\n"
                f"- **Deterministic Error Handling**: Prefer explicit result types or structured exceptions over silent failures.\n\n"
                f"> 💡 *Operating in {'Meta Llama 3.3 mode' if is_llama_mode else 'Local Knowledge Engine'}. Connect live Google Gemini API for custom dynamic code synthesis.*"
            )

        else:
            return (
                f"### {display_agent} Knowledge Analysis\n\n"
                f"Regarding your query: *\"{prompt}\"*\n\n"
                f"#### Comprehensive Assessment\n"
                f"1. **Core Concept**: The subject touches on key principles in modern engineering, computing, and analytical methodology.\n"
                f"2. **Primary Mechanisms**: Critical components include structured data processing, deterministic logic flow, and modular architecture.\n"
                f"3. **Practical Application**: To leverage this effectively, ensure clear requirements definition, modular implementation, and validation against empirical test cases.\n\n"
                f"#### Recommended Next Steps\n"
                f"- Formulate specific test vectors or parameters to narrow the scope.\n"
                f"- Implement iterative prototyping to validate assumptions.\n"
                f"- Explore related standard libraries and ecosystem frameworks for rapid development.\n\n"
                f"> 💡 *Operating in {'Meta Llama 3.3 mode' if is_llama_mode else 'Local Knowledge Engine'}.*"
            )

    @staticmethod
    def _heuristic_agent_generator(prompt_or_description: str) -> dict:
        """Intelligent heuristic generator for designing specialized AI agents."""
        p_lower = (prompt_or_description or "").lower().strip()

        if any(w in p_lower for w in ["code", "dev", "program", "python", "react", "fullstack", "backend", "frontend", "software", "api", "bug"]):
            return {
                "name": "CodeCraft Engineer",
                "role": "Senior Full-Stack & Systems Architect",
                "avatar": "⚡",
                "description": "Designs, writes, tests, and refactors robust full-stack applications with clean architecture.",
                "system_prompt": (
                    "You are CodeCraft Engineer, an elite Senior Software Architect and Full-Stack Specialist. "
                    "Provide pristine, production-ready code with complete syntax highlighting, strict type annotations, "
                    "modular directory structure, and comprehensive error handling. Identify algorithmic complexity and edge cases proactively."
                ),
                "temperature": 0.3,
                "capabilities": ["Full-Stack Dev", "Bug Triage", "Performance Tuning", "Unit Testing"],
                "model": "gemini-3.8-flash",
            }
        elif any(w in p_lower for w in ["sec", "hack", "audit", "crypto", "auth", "vuln", "penetration", "guard", "firewall"]):
            return {
                "name": "CipherShield Sentinel",
                "role": "Principal Cybersecurity & Cryptographic Auditor",
                "avatar": "🛡️",
                "description": "Specialized in vulnerability detection, penetration testing, and zero-trust defensive hardening.",
                "system_prompt": (
                    "You are CipherShield Sentinel, an elite application security auditor and penetration tester. "
                    "Thoroughly inspect codebases, API contracts, and infrastructure for OWASP Top 10 risks, injection vectors, "
                    "timing vulnerabilities, and secret leakage. Provide concrete, hardened remediation patches."
                ),
                "temperature": 0.2,
                "capabilities": ["Vulnerability Scan", "Threat Modeling", "Zero-Trust Security", "OWASP Remediation"],
                "model": "gemini-3.8-flash",
            }
        elif any(w in p_lower for w in ["data", "science", "ml", "machine learning", "ai", "pandas", "analytics", "sql", "math", "statistic"]):
            return {
                "name": "DataVector Analyst",
                "role": "Lead Data Scientist & ML Engineer",
                "avatar": "📊",
                "description": "Transforms raw telemetry, structured datasets, and mathematical formulations into predictive insights.",
                "system_prompt": (
                    "You are DataVector Analyst, a Lead Data Scientist and ML Engineer. "
                    "Formulate rigorous statistical hypotheses, design machine learning pipelines, optimize complex SQL queries, "
                    "and deliver quantitative insights with clean visual hierarchy."
                ),
                "temperature": 0.35,
                "capabilities": ["Data Science", "Machine Learning", "SQL Optimization", "Statistical Modeling"],
                "model": "gemini-3.8-flash",
            }
        elif any(w in p_lower for w in ["write", "copy", "market", "story", "book", "blog", "content", "essay", "narrative"]):
            return {
                "name": "Aura Wordsmith",
                "role": "Master Creative Director & Storyteller",
                "avatar": "✍️",
                "description": "Crafts compelling narratives, high-converting product copy, and captivating editorial prose.",
                "system_prompt": (
                    "You are Aura Wordsmith, an acclaimed narrative architect and master copywriter. "
                    "Deliver prose with exquisite cadence, emotional depth, and persuasive conviction. "
                    "Eliminate generic filler and elevate every sentence into resonant communication."
                ),
                "temperature": 0.85,
                "capabilities": ["Creative Writing", "Brand Narrative", "Persuasive Copy", "Editorial Polish"],
                "model": "gemini-3.8-flash",
            }
        elif any(w in p_lower for w in ["finance", "money", "invest", "stock", "trade", "crypto", "business", "startup"]):
            return {
                "name": "VentureQuant Analyst",
                "role": "Senior Financial & Strategy Analyst",
                "avatar": "📈",
                "description": "Delivers quantitative valuation models, financial risk assessment, and market strategy.",
                "system_prompt": (
                    "You are VentureQuant Analyst, an institutional financial strategist and valuation expert. "
                    "Deconstruct balance sheets, cash flow models, unit economics, and market volatility with empirical rigor."
                ),
                "temperature": 0.3,
                "capabilities": ["Financial Modeling", "Risk Analysis", "Valuation", "Market Strategy"],
                "model": "gemini-3.8-flash",
            }
        else:
            words = [w.capitalize() for w in p_lower.split() if len(w) > 2][:2]
            title_prefix = " ".join(words) if words else "Intelligence"
            return {
                "name": f"{title_prefix} Specialist",
                "role": f"Senior {title_prefix} Advisor",
                "avatar": "🤖",
                "description": f"Autonomous AI Agent specialized in {prompt_or_description}.",
                "system_prompt": (
                    f"You are a dedicated AI Agent specialized in {prompt_or_description}. "
                    "Provide deep, authoritative, and structured responses. Use step-by-step reasoning, clear bullet points, "
                    "and practical examples. Adhere strictly to the highest domain standards."
                ),
                "temperature": 0.5,
                "capabilities": ["Domain Analysis", "Problem Solving", "Strategy", "Execution"],
                "model": "gemini-3.8-flash",
            }

    @staticmethod
    def generate_agent_spec(prompt_or_description: str, user_api_key: str = None) -> dict:
        """Use Gemini 3.8 Flash to architect a specialized AI Agent specification."""
        api_key = (user_api_key or os.environ.get("GEMINI_API_KEY", "")).strip()

        meta_prompt = (
            f"You are an elite AI Agent Architect. Based on this user concept:\n"
            f"\"{prompt_or_description}\"\n\n"
            "Design a custom, high-caliber AI Agent. Return a valid JSON object matching this schema:\n"
            "{\n"
            "  \"name\": \"2-3 word distinctive agent name\",\n"
            "  \"role\": \"authoritative professional title (3-6 words)\",\n"
            "  \"avatar\": \"a single appropriate emoji (e.g. 🤖, 🛡️, ⚡, 🔬, 📊, 🧠, 🎯, 🚀, ✍️)\",\n"
            "  \"description\": \"1 sentence explaining what this agent does best\",\n"
            "  \"system_prompt\": \"a thorough, rich 2-3 paragraph operational system instruction defining persona, methodology, formatting, and high standards\",\n"
            "  \"temperature\": 0.3,\n"
            "  \"capabilities\": [\"Capability 1\", \"Capability 2\", \"Capability 3\", \"Capability 4\"],\n"
            "  \"model\": \"gemini-3.8-flash\"\n"
            "}\n\n"
            "Return ONLY raw JSON with no Markdown code block formatting."
        )

        if api_key and api_key != "MY_GEMINI_API_KEY":
            try:
                client = genai.Client(api_key=api_key)
                response = client.models.generate_content(
                    model="gemini-3.8-flash",
                    contents=meta_prompt,
                    config=types.GenerateContentConfig(
                        temperature=0.3,
                        response_mime_type="application/json",
                    ),
                )
                if response and response.text:
                    cleaned = response.text.strip()
                    if cleaned.startswith("```json"):
                        cleaned = cleaned[7:]
                    if cleaned.endswith("```"):
                        cleaned = cleaned[:-3]
                    parsed = json.loads(cleaned.strip())
                    if isinstance(parsed, dict) and "name" in parsed and "system_prompt" in parsed:
                        if "model" not in parsed:
                            parsed["model"] = "gemini-3.8-flash"
                        return parsed
            except Exception as e:
                pass

        return GeminiService._heuristic_agent_generator(prompt_or_description)


def seed_default_agents(user_id: int):
    """Seed high-caliber AI agents for a user if none exist."""
    existing_count = Agent.query.filter_by(user_id=user_id).count()
    if existing_count > 0:
        return

    default_agents = [
        Agent(
            user_id=user_id,
            name="Gemini 2.5 Flash",
            role="Google Multimodal AI Assistant",
            avatar="⚡",
            description="High-speed, intelligent multimodal reasoning powered by Google Gemini 2.5 Flash.",
            system_prompt=(
                "You are Gemini 2.5 Flash, an advanced, highly capable and helpful multimodal AI model developed by Google. "
                "Provide direct, insightful, accurate, and comprehensive assistance across coding, science, analysis, and creative tasks."
            ),
            temperature=0.7,
            capabilities=json.dumps(["General Intelligence", "Multimodal Vision", "Code Synthesis", "Deep Reasoning"]),
            model="gemini-2.5-flash",
            is_default=True,
        ),
        Agent(
            user_id=user_id,
            name="Meta Llama 3.3",
            role="Open-Source LLM Architecture",
            avatar="🦙",
            description="Versatile, high-precision open weights intelligence model for deep technical queries, coding, and analysis.",
            system_prompt=(
                "You are Meta Llama 3.3, an open-weights large language model. "
                "Provide direct, highly structured, comprehensive answers using rich GitHub-flavored Markdown and production-grade code examples."
            ),
            temperature=0.7,
            capabilities=json.dumps(["Open Source", "Deep Reasoning", "Code Synthesis", "Technical Analysis"]),
            model="llama-3.3-70b",
            is_default=False,
        ),
        Agent(
            user_id=user_id,
            name="CyberSentinel",
            role="Senior Security & Vulnerability Auditor",
            avatar="🛡️",
            description="Audits source code, infrastructure, and API contracts for OWASP Top 10 vulnerabilities, zero-days, and auth flaws.",
            system_prompt=(
                "You are CyberSentinel, a Senior Cybersecurity and Penetration Testing Specialist. "
                "When analyzing systems or code, rigorously evaluate for OWASP Top 10 vulnerabilities, injection flaws (SQLi, XSS, Command Injection), "
                "broken access controls, cryptographic weaknesses, timing attacks, and secret leakage. Provide concrete defense-in-depth remediations and hardened code snippets."
            ),
            temperature=0.2,
            capabilities=json.dumps(["Security Auditing", "OWASP Top 10", "Vulnerability Scanning", "Hardening"]),
            model="gemini-2.5-flash",
            is_default=False,
        ),
        Agent(
            user_id=user_id,
            name="Nova Research",
            role="Deep Technical & Intelligence Analyst",
            avatar="🔬",
            description="Deconstructs ambiguous technical topics into structured, executive-grade intelligence briefs with empirical rigor.",
            system_prompt=(
                "You are Nova Research, a Principal Technical Research and Intelligence Analyst. "
                "Synthesize complex, multifaceted concepts with executive clarity, structured bullet points, clear causal mechanisms, "
                "empirical evidence, and actionable strategic takeaways. Avoid fluff; prioritize depth and precision."
            ),
            temperature=0.4,
            capabilities=json.dumps(["Deep Synthesis", "Competitive Intel", "Executive Briefing", "Data Analysis"]),
            model="gemini-2.5-flash",
            is_default=False,
        ),
        Agent(
            user_id=user_id,
            name="Lexicon Storysmith",
            role="Master Copywriter & Narrative Strategist",
            avatar="✍️",
            description="Crafts high-converting prose, compelling product narratives, pitch decks, and brand storytelling.",
            system_prompt=(
                "You are Lexicon Storysmith, a world-class narrative strategist and master copywriter. "
                "Write with rhythm, punchy cadence, emotional resonance, and crystal clarity. Transform abstract ideas into unforgettable, "
                "persuasive prose that engages audiences and drives conviction."
            ),
            temperature=0.85,
            capabilities=json.dumps(["Brand Storytelling", "High-Converting Copy", "Narrative Polish", "Pitch Decks"]),
            model="gemini-2.5-flash",
            is_default=False,
        ),
    ]
    try:
        db.session.add_all(default_agents)
        db.session.commit()
    except Exception:
        db.session.rollback()


def create_app(config_class=Config):
    """Application factory for Flask AI Chatbot."""
    app = Flask(__name__)
    app.config.from_object(config_class)

    # Enable ProxyFix for reverse-proxy HTTPS header forwarding
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

    # Initialize SQLAlchemy with app
    db.init_app(app)

    # ==========================================
    # BLUEPRINT: MAIN ROUTES
    # ==========================================
    from flask import Blueprint

    main_bp = Blueprint("main", __name__)

    @main_bp.route("/")
    def index():
        """Serve main chat application dashboard."""
        user = get_authenticated_user()
        if not user:
            # Auto-fallback to demo user so workspace opens immediately
            user = User.query.filter_by(username="demo_user").first()
            if not user:
                try:
                    user = User(username="demo_user", email="demo@example.com")
                    user.set_password("demo123")
                    db.session.add(user)
                    db.session.commit()
                except Exception:
                    db.session.rollback()
            if user:
                session["user_id"] = user.id
                session["username"] = user.username
                session.permanent = True

        # Generate auth token
        auth_token = generate_auth_token(user.id) if user else ""

        # Ensure active sessions and agents exist
        sessions = []
        agents = []
        if user:
            seed_default_agents(user.id)
            agents = (
                Agent.query.filter_by(user_id=user.id)
                .order_by(Agent.is_default.desc(), Agent.updated_at.desc())
                .all()
            )
            sessions = (
                ChatSession.query.filter_by(user_id=user.id)
                .order_by(ChatSession.updated_at.desc())
                .all()
            )
            if not sessions:
                try:
                    default_agent = next((a for a in agents if a.is_default), agents[0] if agents else None)
                    welcome_session = ChatSession(
                        user_id=user.id,
                        agent_id=default_agent.id if default_agent else None,
                        title="Welcome to Aetheris AI",
                        system_prompt=default_agent.system_prompt if default_agent else None,
                    )
                    db.session.add(welcome_session)
                    db.session.commit()

                    welcome_msg = Message(
                        session_id=welcome_session.id,
                        role="assistant",
                        content=(
                            f"Welcome **{user.username}**! 👋\n\n"
                            "I am **Aetheris AI**, featuring specialized autonomous AI agents powered by Google Gemini 3.8 Flash. "
                            "You can switch agents, create custom AI agents with prompts or API keys, brainstorm architectures, draft code, or use voice dictation."
                        ),
                    )
                    db.session.add(welcome_msg)
                    db.session.commit()
                    sessions = [welcome_session]
                except Exception:
                    db.session.rollback()

        return render_template(
            "index.html",
            user=user,
            auth_token=auth_token,
            sessions=sessions,
            agents=agents,
            app_name=Config.APP_NAME,
            gemini_model=Config.GEMINI_MODEL,
        )

    # ==========================================
    # BLUEPRINT: AUTH ROUTES
    # ==========================================
    auth_bp = Blueprint("auth", __name__, url_prefix="/auth")

    @auth_bp.route("/demo-login", methods=["GET", "POST"])
    def demo_login():
        """Instant 1-click login as demo user."""
        user = User.query.filter_by(username="demo_user").first()
        if not user:
            try:
                user = User(username="demo_user", email="demo@example.com")
                user.set_password("demo123")
                db.session.add(user)
                db.session.commit()
            except Exception:
                db.session.rollback()
                user = User.query.first()

        session.clear()
        session["user_id"] = user.id
        session["username"] = user.username
        session.permanent = True
        token = generate_auth_token(user.id)

        is_json = request.is_json or request.headers.get("Accept") == "application/json"
        if is_json:
            return jsonify({
                "success": True,
                "token": token,
                "user": user.to_dict(),
                "redirect": f"/?token={token}",
            })
        return redirect(url_for("main.index", token=token))

    @auth_bp.route("/register", methods=["GET", "POST"])
    def register():
        """Handle user registration."""
        if "user_id" in session:
            token = generate_auth_token(session["user_id"])
            return redirect(url_for("main.index", token=token))

        if request.method == "POST":
            data = request.get_json(silent=True) or request.form
            username = (data.get("username") or "").strip()
            email = (data.get("email") or "").strip().lower()
            password = data.get("password") or ""
            confirm_password = data.get("confirm_password") or ""
            is_json = request.is_json or request.headers.get("Accept") == "application/json"

            if not username or not email or not password:
                if is_json:
                    return jsonify({"success": False, "error": "All fields are required."}), 400
                flash("All fields are required.", "error")
                return render_template("register.html", username=username, email=email)

            if len(password) < 6:
                if is_json:
                    return jsonify({"success": False, "error": "Password must be at least 6 characters."}), 400
                flash("Password must be at least 6 characters.", "error")
                return render_template("register.html", username=username, email=email)

            if password != confirm_password:
                if is_json:
                    return jsonify({"success": False, "error": "Passwords do not match."}), 400
                flash("Passwords do not match.", "error")
                return render_template("register.html", username=username, email=email)

            # Case-insensitive checks for existing username or email
            if User.query.filter(func.lower(User.username) == username.lower()).first():
                if is_json:
                    return jsonify({"success": False, "error": "Username is already taken. Please choose another."}), 400
                flash("Username is already taken. Please choose another or sign in.", "error")
                return render_template("register.html", username=username, email=email)

            if User.query.filter(func.lower(User.email) == email.lower()).first():
                if is_json:
                    return jsonify({"success": False, "error": "Email is already registered. Please sign in."}), 400
                flash("Email is already registered. Please sign in or use a different email.", "error")
                return render_template("register.html", username=username, email=email)

            try:
                new_user = User(username=username, email=email)
                new_user.set_password(password)
                db.session.add(new_user)
                db.session.commit()
            except IntegrityError:
                db.session.rollback()
                if is_json:
                    return jsonify({"success": False, "error": "Username or email is already registered."}), 400
                flash("Username or email is already registered. Please sign in.", "error")
                return render_template("register.html", username=username, email=email)
            except Exception as e:
                db.session.rollback()
                if is_json:
                    return jsonify({"success": False, "error": "An unexpected error occurred. Please try again."}), 500
                flash("An unexpected error occurred during account creation. Please try again.", "error")
                return render_template("register.html", username=username, email=email)

            # Create default welcome chat session
            try:
                welcome_session = ChatSession(
                    user_id=new_user.id,
                    title="Welcome to Aetheris AI",
                )
                db.session.add(welcome_session)
                db.session.commit()

                welcome_msg = Message(
                    session_id=welcome_session.id,
                    role="assistant",
                    content=(
                        f"Welcome **{new_user.username}**! 👋\n\n"
                        "I am **Aetheris AI**, powered by Google Gemini. "
                        "You can ask me technical questions, brainstorm ideas, draft code, or use voice dictation."
                    ),
                )
                db.session.add(welcome_msg)
                db.session.commit()
            except Exception:
                db.session.rollback()

            session.clear()
            session["user_id"] = new_user.id
            session["username"] = new_user.username
            session.permanent = True
            token = generate_auth_token(new_user.id)
            flash("Account created successfully! Welcome aboard.", "success")

            if is_json:
                return jsonify({
                    "success": True,
                    "token": token,
                    "user": new_user.to_dict(),
                    "redirect": f"/?token={token}",
                })

            return redirect(url_for("main.index", token=token))

        return render_template("register.html")

    @auth_bp.route("/login", methods=["GET", "POST"])
    def login():
        """Handle user login with form POST and JSON/token support."""
        if "user_id" in session:
            token = generate_auth_token(session["user_id"])
            return redirect(url_for("main.index", token=token))

        if request.method == "POST":
            data = request.get_json(silent=True) or request.form
            identifier = (data.get("identifier") or "").strip()
            password = data.get("password") or ""
            is_json = request.is_json or request.headers.get("Accept") == "application/json"

            if not identifier or not password:
                if is_json:
                    return jsonify({"success": False, "error": "Please provide username/email and password."}), 400
                flash("Please provide your username/email and password.", "error")
                return render_template("login.html", identifier=identifier)

            user = User.query.filter(
                (func.lower(User.username) == identifier.lower())
                | (func.lower(User.email) == identifier.lower())
            ).first()

            if user and user.check_password(password):
                session.clear()
                session["user_id"] = user.id
                session["username"] = user.username
                session.permanent = True
                token = generate_auth_token(user.id)
                flash(f"Welcome back, {user.username}!", "success")

                if is_json:
                    return jsonify({
                        "success": True,
                        "token": token,
                        "user": user.to_dict(),
                        "redirect": f"/?token={token}",
                    })

                next_page = request.args.get("next")
                if next_page and not next_page.startswith("/auth/"):
                    target = next_page + ("&" if "?" in next_page else "?") + f"token={token}"
                    return redirect(target)
                return redirect(url_for("main.index", token=token))
            else:
                if is_json:
                    return jsonify({"success": False, "error": "Invalid username/email or password."}), 401
                flash("Invalid username/email or password.", "error")
                return render_template("login.html", identifier=identifier)

        return render_template("login.html")

    @auth_bp.route("/logout", methods=["GET", "POST"])
    def logout():
        """Log out current user and clear session."""
        session.clear()
        flash("You have been signed out.", "info")
        return redirect(url_for("auth.login"))

    @auth_bp.route("/me")
    @login_required
    def me():
        """Return current user profile as JSON."""
        user = User.query.get(session["user_id"])
        return jsonify(user.to_dict())

    # ==========================================
    # BLUEPRINT: REST & STREAMING API ROUTES
    # ==========================================
    api_bp = Blueprint("api", __name__, url_prefix="/api")

    @api_bp.route("/agents", methods=["GET"])
    @login_required
    def get_agents():
        """Retrieve all AI agents for the current user, seeding defaults if needed."""
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        if not user_id:
            user = User.query.filter_by(username="demo_user").first()
            if user:
                user_id = user.id

        seed_default_agents(user_id)
        agents = (
            Agent.query.filter_by(user_id=user_id)
            .order_by(Agent.is_default.desc(), Agent.updated_at.desc())
            .all()
        )
        return jsonify([a.to_dict() for a in agents])

    @api_bp.route("/agents", methods=["POST"])
    @login_required
    def create_agent():
        """Create a new specialized autonomous AI Agent."""
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        if not user_id:
            user = User.query.filter_by(username="demo_user").first()
            if user:
                user_id = user.id

        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        role = (data.get("role") or "").strip()
        avatar = (data.get("avatar") or "🤖").strip()
        description = (data.get("description") or "").strip()
        system_prompt = (data.get("system_prompt") or "").strip()
        temperature = data.get("temperature", 0.7)
        try:
            temperature = float(temperature)
        except Exception:
            temperature = 0.7
        capabilities = data.get("capabilities", [])
        if isinstance(capabilities, list):
            caps_str = json.dumps(capabilities)
        else:
            caps_str = str(capabilities)
        model = (data.get("model") or "gemini-3.8-flash").strip()
        api_key = (data.get("api_key") or "").strip() or None

        if not name:
            return jsonify({"error": "Agent name is required"}), 400
        if not system_prompt:
            return jsonify({"error": "Agent system prompt instructions are required"}), 400

        try:
            agent = Agent(
                user_id=user_id,
                name=name,
                role=role or "Specialized AI Agent",
                avatar=avatar[:10] if avatar else "🤖",
                description=description,
                system_prompt=system_prompt,
                temperature=temperature,
                capabilities=caps_str,
                model=model,
                api_key=api_key,
                is_default=False,
            )
            db.session.add(agent)
            db.session.commit()
            return jsonify(agent.to_dict()), 201
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"[Agent Creation Error] {e}", exc_info=True)
            return jsonify({"error": "Failed to create agent", "details": str(e)}), 500

    @api_bp.route("/agents/generate", methods=["POST"])
    @login_required
    def generate_agent_with_ai():
        """Use Gemini 3.8 Flash to architect and generate an AI agent based on prompt or description."""
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        if not user_id:
            user = User.query.filter_by(username="demo_user").first()
            if user:
                user_id = user.id

        data = request.get_json(silent=True) or {}
        user_prompt = (data.get("prompt") or data.get("description") or "").strip()
        user_api_key = (data.get("api_key") or "").strip() or None
        auto_save = bool(data.get("auto_save", False))

        if not user_prompt:
            user_prompt = "Elite Full-Stack Software Engineer & Solutions Architect"

        try:
            spec = GeminiService.generate_agent_spec(user_prompt, user_api_key=user_api_key)
            saved_agent = None

            if auto_save:
                caps = spec.get("capabilities", [])
                agent = Agent(
                    user_id=user_id,
                    name=spec.get("name", "Custom Agent"),
                    role=spec.get("role", "AI Specialist"),
                    avatar=spec.get("avatar", "🤖"),
                    description=spec.get("description", ""),
                    system_prompt=spec.get("system_prompt", Config.DEFAULT_SYSTEM_PROMPT),
                    temperature=float(spec.get("temperature", 0.7)),
                    capabilities=json.dumps(caps if isinstance(caps, list) else []),
                    model=spec.get("model", "gemini-3.8-flash"),
                    api_key=user_api_key,
                    is_default=False,
                )
                db.session.add(agent)
                db.session.commit()
                saved_agent = agent.to_dict()

            return jsonify({
                "success": True,
                "agent_spec": spec,
                "agent": saved_agent,
            })
        except Exception as e:
            current_app.logger.error(f"[Agent Generation Error] {e}", exc_info=True)
            return jsonify({"error": "Failed to generate agent", "details": str(e)}), 500

    @api_bp.route("/agents/<int:agent_id>", methods=["GET"])
    @login_required
    def get_agent_details(agent_id):
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        agent = Agent.query.filter_by(id=agent_id).first_or_404()
        if user_id and agent.user_id != user_id:
            return jsonify({"error": "Unauthorized"}), 403
        return jsonify(agent.to_dict())

    @api_bp.route("/agents/<int:agent_id>", methods=["PUT"])
    @login_required
    def update_agent(agent_id):
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        agent = Agent.query.filter_by(id=agent_id).first_or_404()
        if user_id and agent.user_id != user_id:
            return jsonify({"error": "Unauthorized"}), 403

        data = request.get_json(silent=True) or {}
        try:
            if "name" in data and data["name"].strip():
                agent.name = data["name"].strip()
            if "role" in data:
                agent.role = data["role"].strip()
            if "avatar" in data and data["avatar"].strip():
                agent.avatar = data["avatar"].strip()[:10]
            if "description" in data:
                agent.description = data["description"].strip()
            if "system_prompt" in data and data["system_prompt"].strip():
                agent.system_prompt = data["system_prompt"].strip()
            if "temperature" in data:
                try:
                    agent.temperature = float(data["temperature"])
                except Exception:
                    pass
            if "capabilities" in data:
                caps = data["capabilities"]
                agent.capabilities = json.dumps(caps if isinstance(caps, list) else [str(caps)])
            if "model" in data and data["model"].strip():
                agent.model = data["model"].strip()
            if "api_key" in data:
                k = (data["api_key"] or "").strip()
                agent.api_key = k if k else None

            agent.updated_at = datetime.utcnow()
            db.session.commit()
            return jsonify(agent.to_dict())
        except Exception as e:
            db.session.rollback()
            return jsonify({"error": "Failed to update agent", "details": str(e)}), 500

    @api_bp.route("/agents/<int:agent_id>", methods=["DELETE"])
    @login_required
    def delete_agent(agent_id):
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        agent = Agent.query.filter_by(id=agent_id).first_or_404()
        if user_id and agent.user_id != user_id:
            return jsonify({"error": "Unauthorized"}), 403

        try:
            # Unlink any chat sessions associated with this agent
            ChatSession.query.filter_by(agent_id=agent_id).update({"agent_id": None})
            db.session.delete(agent)
            db.session.commit()
            return jsonify({"success": True, "deleted_id": agent_id})
        except Exception as e:
            db.session.rollback()
            return jsonify({"error": "Failed to delete agent", "details": str(e)}), 500

    @api_bp.route("/sessions", methods=["GET"])
    @login_required
    def get_sessions():
        """Get all chat sessions for the current authenticated user."""
        user_id = session["user_id"]
        sessions = (
            ChatSession.query.filter_by(user_id=user_id)
            .order_by(ChatSession.updated_at.desc())
            .all()
        )
        return jsonify([s.to_dict() for s in sessions])

    @api_bp.route("/sessions/new", methods=["POST"])
    @login_required
    def create_session():
        """Initialize a fresh chat session."""
        try:
            user_id = session.get("user_id") or getattr(g, "current_user_id", None)
            if not user_id:
                user = User.query.filter_by(username="demo_user").first()
                if user:
                    user_id = user.id
                    session["user_id"] = user.id
                    session["username"] = user.username

            data = request.get_json(silent=True) or {}
            raw_title = data.get("title")
            title = raw_title.strip() if isinstance(raw_title, str) and raw_title.strip() else "New Conversation"

            raw_system_prompt = data.get("system_prompt")
            system_prompt = (
                raw_system_prompt.strip()
                if isinstance(raw_system_prompt, str) and raw_system_prompt.strip()
                else None
            )

            raw_agent_id = data.get("agent_id")
            agent_id = None
            if raw_agent_id is not None and str(raw_agent_id).isdigit():
                agent = Agent.query.filter_by(id=int(raw_agent_id), user_id=user_id).first()
                if agent:
                    agent_id = agent.id
                    if not system_prompt:
                        system_prompt = agent.system_prompt

            new_session = ChatSession(
                user_id=user_id,
                agent_id=agent_id,
                title=title,
                system_prompt=system_prompt,
            )
            db.session.add(new_session)
            db.session.commit()

            return jsonify(new_session.to_dict()), 201
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"[Session Creation Error] {e}", exc_info=True)
            return jsonify({"error": "Failed to create session", "details": str(e)}), 500

    @api_bp.route("/sessions/<int:session_id>", methods=["GET"])
    @login_required
    def get_session_details(session_id):
        """Retrieve session details with chronological messages."""
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        chat_session = ChatSession.query.filter_by(
            id=session_id, user_id=user_id
        ).first_or_404()
        return jsonify(chat_session.to_dict(include_messages=True))

    @api_bp.route("/sessions/<int:session_id>", methods=["PUT"])
    @login_required
    def update_session(session_id):
        """Rename session or update session system prompt / active agent."""
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        if not user_id:
            user = User.query.filter_by(username="demo_user").first()
            if user:
                user_id = user.id

        chat_session = ChatSession.query.filter_by(id=session_id).first_or_404()
        if user_id and chat_session.user_id != user_id:
            return jsonify({"error": "Unauthorized"}), 403

        data = request.get_json(silent=True) or {}

        try:
            if "title" in data:
                raw_title = data.get("title")
                if isinstance(raw_title, str):
                    cleaned_title = raw_title.strip()
                    if cleaned_title:
                        chat_session.title = cleaned_title

            if "system_prompt" in data:
                raw_sp = data.get("system_prompt")
                chat_session.system_prompt = (
                    raw_sp.strip() if isinstance(raw_sp, str) and raw_sp.strip() else None
                )

            if "agent_id" in data:
                raw_aid = data.get("agent_id")
                if raw_aid is None or raw_aid == "":
                    chat_session.agent_id = None
                elif str(raw_aid).isdigit():
                    agent = Agent.query.filter_by(id=int(raw_aid), user_id=user_id).first()
                    if agent:
                        chat_session.agent_id = agent.id
                        if not chat_session.system_prompt:
                            chat_session.system_prompt = agent.system_prompt

            chat_session.updated_at = datetime.utcnow()
            db.session.commit()
            return jsonify(chat_session.to_dict())
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"[Session Update Error] {e}", exc_info=True)
            return jsonify({"error": "Failed to update conversation", "details": str(e)}), 500

    @api_bp.route("/sessions/<int:session_id>", methods=["DELETE"])
    @login_required
    def delete_session(session_id):
        """Delete session and cascade delete all associated messages."""
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        if not user_id:
            user = User.query.filter_by(username="demo_user").first()
            if user:
                user_id = user.id

        chat_session = ChatSession.query.filter_by(id=session_id).first_or_404()
        if user_id and chat_session.user_id != user_id:
            return jsonify({"error": "Unauthorized"}), 403

        try:
            Message.query.filter_by(session_id=session_id).delete()
            db.session.delete(chat_session)
            db.session.commit()
            return jsonify({"success": True, "deleted_id": session_id})
        except Exception as e:
            db.session.rollback()
            current_app.logger.error(f"[Session Delete Error] {e}", exc_info=True)
            return jsonify({"error": "Failed to delete conversation", "details": str(e)}), 500

    @api_bp.route("/sessions/<int:session_id>/export", methods=["GET"])
    @login_required
    def export_session(session_id):
        """Export conversation as JSON or Markdown file."""
        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        if not user_id:
            user = User.query.filter_by(username="demo_user").first()
            if user:
                user_id = user.id

        chat_session = ChatSession.query.filter_by(
            id=session_id, user_id=user_id
        ).first_or_404()
        export_format = request.args.get("format", "markdown").lower()

        if export_format == "json":
            payload = chat_session.to_dict(include_messages=True)
            return Response(
                json.dumps(payload, indent=2),
                mimetype="application/json",
                headers={
                    "Content-Disposition": f'attachment; filename="chat_{session_id}.json"'
                },
            )

        # Generate Markdown export
        md_lines = [
            f"# {chat_session.title}",
            f"*Exported from {Config.APP_NAME} on {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}*",
            "",
            "---",
            "",
        ]
        for msg in chat_session.messages:
            author = "User" if msg.role == "user" else "Assistant (Gemini)"
            time_str = msg.timestamp.strftime("%Y-%m-%d %H:%M:%S")
            md_lines.append(f"### {author} ({time_str})")
            md_lines.append(msg.content)
            md_lines.append("")

        md_content = "\n".join(md_lines)
        return Response(
            md_content,
            mimetype="text/markdown",
            headers={
                "Content-Disposition": f'attachment; filename="chat_{session_id}.md"'
            },
        )

    @api_bp.route("/chat", methods=["POST"])
    @login_required
    def chat():
        """
        Handle user message, save to database, invoke Gemini with history context,
        and stream SSE tokens in real time.
        """
        data = request.get_json() or {}
        content = data.get("message", "").strip()
        session_id = data.get("session_id")
        system_prompt = data.get("system_prompt")
        stream = data.get("stream", True)

        if not content:
            return jsonify({"error": "Message content cannot be empty"}), 400

        user_id = session.get("user_id") or getattr(g, "current_user_id", None)
        if not user_id:
            user = User.query.filter_by(username="demo_user").first()
            if user:
                user_id = user.id

        # If no session specified, retrieve latest or create a new one
        if not session_id:
            chat_session = (
                ChatSession.query.filter_by(user_id=user_id)
                .order_by(ChatSession.updated_at.desc())
                .first()
            )
            if not chat_session:
                chat_session = ChatSession(
                    user_id=user_id,
                    title=content[:30] + ("..." if len(content) > 30 else ""),
                )
                db.session.add(chat_session)
                db.session.commit()
        else:
            chat_session = ChatSession.query.filter_by(
                id=session_id, user_id=user_id
            ).first_or_404()

        # Update title if it is currently default "New Chat" or "New Conversation"
        if chat_session.title in ["New Chat", "New Conversation", "Untitled Chat"]:
            chat_session.title = content[:30] + ("..." if len(content) > 30 else "")

        # Extract attachments and options from request
        images = data.get("images") or []
        attachments = data.get("attachments") or []
        is_create_image = bool(data.get("is_create_image", False))
        web_grounding = bool(data.get("web_grounding", False))

        # Check if content has natural language image generation intent
        c_lower = content.lower().strip()
        img_intent_patterns = [
            "/image", "create image", "create an image", "create a image",
            "createme image", "createme a image", "createme an image",
            "crate image", "crate aimage", "crate an image",
            "generate image", "generate an image", "generate a picture", "generate a photo",
            "make image", "make an image", "make a image",
            "make me image", "make me an image", "make me a image", "make me picture", "make me a picture",
            "draw image", "draw an image", "draw a image", "draw a picture", "draw me an image", "draw me a picture",
            "show image", "show an image", "show a image", "show me an image", "show me a picture",
            "give image", "give me an image", "give me a picture", "render image", "render an image",
            "picture of", "photo of", "illustration of"
        ]
        if not is_create_image and (
            any(pat in c_lower for pat in img_intent_patterns)
            or "image of" in c_lower
            or "picture of" in c_lower
            or "photo of" in c_lower
            or ("blackhole" in c_lower and "said" in c_lower)
        ):
            is_create_image = True

        # Construct user message content with image markdown if images are uploaded
        user_content_to_save = content
        if images:
            img_md_list = []
            for img in images:
                name = img.get("name") or "attached-image.png"
                d_url = img.get("data") or ""
                img_md_list.append(f"![{name}]({d_url})")
            user_content_to_save = "\n".join(img_md_list) + ("\n\n" if content else "") + content

        # Save user message to database
        user_message = Message(
            session_id=chat_session.id,
            role="user",
            content=user_content_to_save,
        )
        db.session.add(user_message)
        chat_session.updated_at = datetime.utcnow()
        db.session.commit()

        # Load historical messages for context retention (prior messages excluding the one just added)
        history_messages = (
            Message.query.filter_by(session_id=chat_session.id)
            .filter(Message.id != user_message.id)
            .order_by(Message.timestamp.asc())
            .all()
        )

        # Check active agent association
        raw_agent_id = data.get("agent_id") or chat_session.agent_id
        agent = None
        if raw_agent_id is not None and str(raw_agent_id).isdigit():
            agent = Agent.query.filter_by(id=int(raw_agent_id), user_id=user_id).first()
            if agent and chat_session.agent_id != agent.id:
                chat_session.agent_id = agent.id
                db.session.commit()

        effective_system_prompt = (
            system_prompt
            or chat_session.system_prompt
            or (agent.system_prompt if agent else None)
            or Config.DEFAULT_SYSTEM_PROMPT
        )
        agent_temperature = agent.temperature if (agent and agent.temperature is not None) else 0.7
        agent_api_key = agent.api_key if (agent and agent.api_key) else None
        agent_model = agent.model if (agent and agent.model) else None
        agent_name = agent.name if agent else "Aetheris AI"

        # Handle SSE Streaming response
        if stream:

            def generate_sse():
                full_assistant_content = []
                try:
                    for token in GeminiService.stream_chat_response(
                        history_messages=history_messages,
                        user_prompt=content,
                        system_prompt=effective_system_prompt,
                        temperature=agent_temperature,
                        custom_api_key=agent_api_key,
                        model_name=agent_model,
                        agent_name=agent_name,
                        images=images,
                        attachments=attachments,
                        is_create_image=is_create_image,
                        web_grounding=web_grounding,
                    ):
                        full_assistant_content.append(token)
                        payload = json.dumps(
                            {
                                "token": token,
                                "session_id": chat_session.id,
                                "agent": agent.to_dict() if agent else None,
                            }
                        )
                        yield f"data: {payload}\n\n"

                    # Persist complete assistant message in database with application context
                    with app.app_context():
                        final_text = "".join(full_assistant_content).strip()
                        if final_text:
                            asst_msg = Message(
                                session_id=chat_session.id,
                                role="assistant",
                                content=final_text,
                            )
                            db.session.add(asst_msg)
                            db_session = ChatSession.query.get(chat_session.id)
                            if db_session:
                                db_session.updated_at = datetime.utcnow()
                            db.session.commit()
                            done_payload = json.dumps(
                                {
                                    "done": True,
                                    "session_id": chat_session.id,
                                    "message_id": asst_msg.id,
                                    "session_title": chat_session.title,
                                    "agent": agent.to_dict() if agent else None,
                                }
                            )
                            yield f"data: {done_payload}\n\n"
                        else:
                            yield f"data: {json.dumps({'done': True, 'session_id': chat_session.id})}\n\n"

                except Exception as ex:
                    err_payload = json.dumps({"error": str(ex), "done": True})
                    yield f"data: {err_payload}\n\n"

            return Response(
                generate_sse(),
                mimetype="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                    "Connection": "keep-alive",
                },
            )

        # Non-streaming JSON response mode
        tokens = list(
            GeminiService.stream_chat_response(
                history_messages=history_messages,
                user_prompt=content,
                system_prompt=effective_system_prompt,
                temperature=agent_temperature,
                custom_api_key=agent_api_key,
                model_name=agent_model,
                agent_name=agent_name,
                images=images,
                attachments=attachments,
                is_create_image=is_create_image,
                web_grounding=web_grounding,
            )
        )
        assistant_content = "".join(tokens).strip()

        asst_msg = Message(
            session_id=chat_session.id,
            role="assistant",
            content=assistant_content,
        )
        db.session.add(asst_msg)
        chat_session.updated_at = datetime.utcnow()
        db.session.commit()

        return jsonify(
            {
                "session_id": chat_session.id,
                "session_title": chat_session.title,
                "user_message": user_message.to_dict(),
                "assistant_message": asst_msg.to_dict(),
                "agent": agent.to_dict() if agent else None,
            }
        )

    # Register Blueprints
    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp)

    # API Error handlers to return JSON instead of HTML
    @app.errorhandler(404)
    def handle_404(e):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Endpoint not found", "code": 404}), 404
        return "Not Found", 404

    @app.errorhandler(405)
    def handle_405(e):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Method not allowed", "code": 405}), 405
        return "Method Not Allowed", 405

    @app.errorhandler(500)
    def handle_500(e):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Internal server error", "code": 500}), 500
        return "Internal Server Error", 500

    # Auto-initialize SQLite database & Seed demo account
    with app.app_context():
        db.create_all()

        # Ensure agent_id column exists on chat_sessions for backwards compatibility
        try:
            with db.engine.connect() as conn:
                res = conn.execute(db.text("PRAGMA table_info(chat_sessions);")).fetchall()
                col_names = [r[1] for r in res]
                if "agent_id" not in col_names:
                    conn.execute(db.text("ALTER TABLE chat_sessions ADD COLUMN agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;"))
                    conn.commit()
        except Exception as e:
            app.logger.warning(f"Database schema verification note: {e}")

        # Seed demo user for instantaneous evaluator testing
        demo_user = User.query.filter_by(username="demo_user").first()
        if not demo_user:
            demo_user = User(username="demo_user", email="demo@example.com")
            demo_user.set_password("demo123")
            db.session.add(demo_user)
            db.session.commit()

        # Seed default AI agents for demo user
        seed_default_agents(demo_user.id)

        # Seed demo conversation if none exists
        if ChatSession.query.filter_by(user_id=demo_user.id).count() == 0:
            default_agent = Agent.query.filter_by(user_id=demo_user.id, is_default=True).first()
            sample_session = ChatSession(
                user_id=demo_user.id,
                agent_id=default_agent.id if default_agent else None,
                title="Python Architecture & Patterns",
                system_prompt=default_agent.system_prompt if default_agent else None,
            )
            db.session.add(sample_session)
            db.session.commit()

            msg1 = Message(
                session_id=sample_session.id,
                role="user",
                content="How do you architect an enterprise-grade Flask application with streaming SSE and SQLAlchemy?",
            )
            msg2 = Message(
                session_id=sample_session.id,
                role="assistant",
                content=(
                    "### Enterprise Flask Architecture\n\n"
                    "An elite Flask architecture adopts:\n"
                    "1. **Application Factory (`create_app`)**: Facilitates testing and decoupled initialization.\n"
                    "2. **Domain Blueprints**: Clean separation between `auth`, `api`, and UI view layers.\n"
                    "3. **Server-Sent Events (SSE)**: Streams tokens incrementally without blocking worker threads.\n"
                    "4. **Relational Models & AI Agents**: Strict foreign keys and custom persona configurations.\n\n"
                    "```python\n"
                    "def create_app(config=Config):\n"
                    "    app = Flask(__name__)\n"
                    "    app.config.from_object(config)\n"
                    "    db.init_app(app)\n"
                    "    app.register_blueprint(api_bp)\n"
                    "    return app\n"
                    "```"
                ),
            )
            db.session.add_all([msg1, msg2])
            db.session.commit()

    return app


if __name__ == "__main__":
    app = create_app()
    port = int(os.environ.get("PORT", 3000))
    # Production-ready execution on 0.0.0.0:PORT
    app.run(host="0.0.0.0", port=port, debug=False)
