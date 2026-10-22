import hashlib
import hmac
import json
import os
import time
from functools import wraps
from pathlib import Path

from django.contrib.auth.hashers import check_password
from django.core import signing
from django.core.cache import cache
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST
from dotenv import dotenv_values

SESSION_HOURS = float(os.getenv("ARG_SESSION_HOURS", "12"))
MAX_ATTEMPTS = int(os.getenv("ARG_LOGIN_MAX_ATTEMPTS", "5"))
LOCKOUT_MINUTES = int(os.getenv("ARG_LOGIN_LOCKOUT_MINUTES", "15"))
TOKEN_SALT = "ddma-arg-dashboard-session"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
_env_cache = {"mtime": None, "values": {}}


def _env_file_values():
    try:
        mtime = ENV_FILE.stat().st_mtime
    except OSError:
        return {}
    if _env_cache["mtime"] != mtime:
        _env_cache["values"] = {k: v for k, v in dotenv_values(ENV_FILE).items() if v is not None}
        _env_cache["mtime"] = mtime
    return _env_cache["values"]


def _setting(name, default=""):
    values = _env_file_values()
    if name in values:
        return values[name]
    return os.environ.get(name, default)


def _account():
    username = _setting("ARG_LOGIN_USERNAME").strip()
    password = _setting("ARG_LOGIN_PASSWORD").strip()
    password_hash = "" if password else _setting("ARG_LOGIN_PASSWORD_HASH").strip()
    if not username or not (password or password_hash):
        return None
    return {
        "username": username,
        "password": password,
        "password_hash": password_hash,
        "display_name": _setting("ARG_LOGIN_DISPLAY_NAME", "DDMA Ernakulam").strip() or "DDMA Ernakulam",
    }


def _password_matches(account, attempt):
    if account["password"]:
        return hmac.compare_digest(attempt.encode(), account["password"].encode())
    return check_password(attempt, account["password_hash"])


def _fingerprint(account):
    secret = account["password"] or account["password_hash"]
    material = f"{secret}|{_setting('ARG_TOKEN_VERSION', '1')}"
    return hashlib.sha256(material.encode()).hexdigest()[:24]


def _client_ip(request):
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "unknown")


def _error(message, status, **extra):
    return JsonResponse({"success": False, "error": message, **extra}, status=status)


def issue_token(account):
    return signing.dumps(
        {"u": account["username"], "f": _fingerprint(account)},
        salt=TOKEN_SALT,
        compress=True,
    )


def verify_token(token):
    account = _account()
    if not account or not token:
        return None
    try:
        data = signing.loads(token, salt=TOKEN_SALT, max_age=int(SESSION_HOURS * 3600))
    except signing.BadSignature:
        return None
    if data.get("u") != account["username"] or data.get("f") != _fingerprint(account):
        return None
    return account


def _token_from(request):
    header = request.META.get("HTTP_AUTHORIZATION", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def require_auth(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        if not verify_token(_token_from(request)):
            return _error("Your session has expired. Please sign in again.", 401, code="auth")
        return view(request, *args, **kwargs)

    return wrapper


@csrf_exempt
@require_POST
def login_view(request):
    account = _account()
    if not account:
        return _error("Login is not configured on the server.", 503)

    key = f"arg-login-fail:{_client_ip(request)}"
    failures = cache.get(key, 0)
    if failures >= MAX_ATTEMPTS:
        return _error(
            f"Too many failed attempts. Try again in {LOCKOUT_MINUTES} minutes.",
            429,
            code="locked",
        )

    try:
        body = json.loads(request.body or b"{}")
    except ValueError:
        return _error("Invalid request.", 400)

    username = str(body.get("username", "")).strip()
    password = str(body.get("password", "")).strip()

    password_ok = _password_matches(account, password)
    user_ok = hmac.compare_digest(username.lower(), account["username"].lower())

    if not (password_ok and user_ok):
        failures += 1
        cache.set(key, failures, LOCKOUT_MINUTES * 60)
        time.sleep(0.6)
        remaining = max(0, MAX_ATTEMPTS - failures)
        if remaining == 0:
            return _error(
                f"Too many failed attempts. Try again in {LOCKOUT_MINUTES} minutes.",
                429,
                code="locked",
            )
        return _error("Incorrect username or password.", 401, attemptsLeft=remaining)

    cache.delete(key)
    expires_at = int((time.time() + SESSION_HOURS * 3600) * 1000)
    return JsonResponse({
        "success": True,
        "token": issue_token(account),
        "user": {"username": account["username"], "name": account["display_name"]},
        "expiresAt": expires_at,
    })


@require_GET
@require_auth
def session_view(request):
    account = _account()
    return JsonResponse({
        "success": True,
        "user": {"username": account["username"], "name": account["display_name"]},
    })