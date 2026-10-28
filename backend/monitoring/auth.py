import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from functools import wraps
from html import escape
from pathlib import Path

from botocore.exceptions import BotoCoreError, ClientError
from django.contrib.auth.hashers import check_password, make_password
from django.core import signing
from django.core.cache import cache
from django.core.mail import EmailMultiAlternatives, get_connection
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST
from dotenv import dotenv_values

logger = logging.getLogger(__name__)

SESSION_HOURS = float(os.getenv("ARG_SESSION_HOURS", "12"))
MAX_ATTEMPTS = int(os.getenv("ARG_LOGIN_MAX_ATTEMPTS", "5"))
LOCKOUT_MINUTES = int(os.getenv("ARG_LOGIN_LOCKOUT_MINUTES", "15"))
RESET_MINUTES = int(os.getenv("ARG_RESET_LINK_MINUTES", "30"))
RESET_REQUESTS_PER_IP = 3
RESET_MAIL_COOLDOWN_SECONDS = 120
MIN_PASSWORD_LENGTH = 10
STORE_CACHE_SECONDS = 30
TOKEN_SALT = "ddma-arg-dashboard-session"
RESET_SALT = "ddma-arg-dashboard-password-reset"
BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_DIR / ".env"
LOCAL_STORE_FILE = BACKEND_DIR / ".dashboard_credentials.json"
IST = timezone(timedelta(hours=5, minutes=30))

_env_cache = {"mtime": None, "values": {}}
_store = {"data": None, "loaded": 0.0}
_store_lock = threading.Lock()


class CredentialStoreUnavailable(RuntimeError):
    pass


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


def store_location():
    bucket = (_setting("ARG_AUTH_S3_BUCKET") or _setting("AWS_S3_BUCKET")).strip()
    key = _setting("ARG_AUTH_S3_KEY", "dashboard-auth/credentials.json").strip()
    if bucket:
        return f"s3://{bucket}/{key}"
    return str(LOCAL_STORE_FILE)


def _s3():
    from .services import _s3_client

    return _s3_client()


def _read_store():
    bucket = (_setting("ARG_AUTH_S3_BUCKET") or _setting("AWS_S3_BUCKET")).strip()
    key = _setting("ARG_AUTH_S3_KEY", "dashboard-auth/credentials.json").strip()
    if bucket:
        try:
            body = _s3().get_object(Bucket=bucket, Key=key)["Body"].read()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                return {}
            raise
        data = json.loads(body or b"{}")
    elif LOCAL_STORE_FILE.exists():
        data = json.loads(LOCAL_STORE_FILE.read_text(encoding="utf-8") or "{}")
    else:
        data = {}
    return data if isinstance(data, dict) else {}


def _stored(force=False):
    with _store_lock:
        fresh = time.time() - _store["loaded"] < STORE_CACHE_SECONDS
        if _store["data"] is not None and fresh and not force:
            return _store["data"]
        try:
            data = _read_store()
        except (ClientError, BotoCoreError, OSError, ValueError) as exc:
            if _store["data"] is not None:
                logger.warning("Could not refresh dashboard credentials, using cached copy: %s", exc)
                return _store["data"]
            logger.error("Could not read dashboard credentials from %s: %s", store_location(), exc)
            raise CredentialStoreUnavailable() from exc
        _store.update(data=data, loaded=time.time())
        return data


def write_store(data):
    payload = json.dumps(data, indent=2)
    bucket = (_setting("ARG_AUTH_S3_BUCKET") or _setting("AWS_S3_BUCKET")).strip()
    key = _setting("ARG_AUTH_S3_KEY", "dashboard-auth/credentials.json").strip()
    if bucket:
        _s3().put_object(
            Bucket=bucket,
            Key=key,
            Body=payload.encode(),
            ContentType="application/json",
            CacheControl="no-store",
        )
    else:
        LOCAL_STORE_FILE.write_text(payload, encoding="utf-8")
    with _store_lock:
        _store.update(data=data, loaded=time.time())


def _now_ist():
    return datetime.now(IST)


def save_password(new_password, source, ip="-"):
    write_store({
        "password_hash": make_password(new_password),
        "updated_at": _now_ist().isoformat(timespec="seconds"),
        "updated_by": source,
        "updated_ip": ip,
    })


def _account(force=False):
    username = _setting("ARG_LOGIN_USERNAME").strip()
    if not username:
        return None
    stored = _stored(force)
    if stored.get("password_hash"):
        password, password_hash = "", stored["password_hash"]
    else:
        password = _setting("ARG_LOGIN_PASSWORD").strip()
        password_hash = "" if password else _setting("ARG_LOGIN_PASSWORD_HASH").strip()
    if not (password or password_hash):
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


def _unavailable():
    return _error("The sign-in service is temporarily unavailable. Please try again in a minute.", 503, code="store")


def _body(request):
    try:
        data = json.loads(request.body or b"{}")
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _session_payload(account):
    return {
        "success": True,
        "token": issue_token(account),
        "user": {"username": account["username"], "name": account["display_name"]},
        "expiresAt": int((time.time() + SESSION_HOURS * 3600) * 1000),
    }


def issue_token(account):
    return signing.dumps(
        {"u": account["username"], "f": _fingerprint(account)},
        salt=TOKEN_SALT,
        compress=True,
    )


def _token_valid_for(data, account):
    return bool(account) and data.get("u") == account["username"] and data.get("f") == _fingerprint(account)


def verify_token(token):
    if not token:
        return None
    try:
        data = signing.loads(token, salt=TOKEN_SALT, max_age=int(SESSION_HOURS * 3600))
    except signing.BadSignature:
        return None
    account = _account()
    if _token_valid_for(data, account):
        return account
    account = _account(force=True)
    return account if _token_valid_for(data, account) else None


def _token_from(request):
    header = request.META.get("HTTP_AUTHORIZATION", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def require_auth(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        try:
            account = verify_token(_token_from(request))
        except CredentialStoreUnavailable:
            return _unavailable()
        if not account:
            return _error("Your session has expired. Please sign in again.", 401, code="auth")
        request.dashboard_account = account
        return view(request, *args, **kwargs)

    return wrapper


def password_problem(new_password, account=None):
    if len(new_password) < MIN_PASSWORD_LENGTH:
        return f"Use at least {MIN_PASSWORD_LENGTH} characters."
    if len(new_password) > 128:
        return "Use 128 characters or fewer."
    if new_password != new_password.strip():
        return "The password cannot start or end with a space."
    if not re.search(r"[A-Za-z]", new_password) or not re.search(r"\d", new_password):
        return "Include at least one letter and one number."
    if account and account["username"].lower() in new_password.lower():
        return "The password must not contain the username."
    if account and _password_matches(account, new_password):
        return "The new password must be different from the current one."
    return None


def _mail_settings():
    return {
        "to": [e.strip() for e in _setting("ARG_ADMIN_EMAIL").split(",") if e.strip()],
        "from_email": _setting("ARG_MAIL_FROM").strip(),
        "from_name": _setting("ARG_MAIL_FROM_NAME", "DDMA Ernakulam ARG Dashboard").strip(),
        "relay_url": _setting("GMAIL_RELAY_URL").strip(),
        "relay_secret": _setting("GMAIL_RELAY_SECRET").strip(),
        "brevo_key": _setting("BREVO_API_KEY").strip(),
        "smtp_host": _setting("SMTP_HOST").strip(),
        "smtp_port": int(_setting("SMTP_PORT", "587") or 587),
        "smtp_user": _setting("SMTP_USER").strip(),
        "smtp_password": _setting("SMTP_PASSWORD").strip(),
        "smtp_ssl": _setting("SMTP_USE_SSL", "false").strip().lower() in ("1", "true", "yes"),
    }


def mail_configured():
    s = _mail_settings()
    if not s["to"]:
        return False
    if s["relay_url"]:
        return bool(s["relay_secret"])
    return bool(s["from_email"] and (s["brevo_key"] or s["smtp_host"]))


def _send_via_gmail_relay(s, subject, html):
    payload = {
        "secret": s["relay_secret"],
        "to": s["to"],
        "subject": subject,
        "html": html,
        "fromName": s["from_name"],
    }
    req = urllib.request.Request(
        s["relay_url"],
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            reply = json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Gmail relay returned HTTP {exc.code}") from exc
    except ValueError as exc:
        raise RuntimeError("Gmail relay did not return JSON. Check the web app deployment and access.") from exc
    if not reply.get("ok"):
        raise RuntimeError(f"Gmail relay refused the email: {reply.get('error', 'unknown error')}")


def send_mail(subject, html):
    s = _mail_settings()
    if s["relay_url"]:
        _send_via_gmail_relay(s, subject, html)
        return
    if s["brevo_key"]:
        payload = {
            "sender": {"name": s["from_name"], "email": s["from_email"]},
            "to": [{"email": e} for e in s["to"]],
            "subject": subject,
            "htmlContent": html,
        }
        req = urllib.request.Request(
            "https://api.brevo.com/v3/smtp/email",
            data=json.dumps(payload).encode(),
            headers={
                "accept": "application/json",
                "api-key": s["brevo_key"],
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status >= 300:
                    raise RuntimeError(f"Brevo returned HTTP {resp.status}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise RuntimeError(f"Brevo returned HTTP {exc.code}: {detail}") from exc
        return

    connection = get_connection(
        "django.core.mail.backends.smtp.EmailBackend",
        host=s["smtp_host"],
        port=s["smtp_port"],
        username=s["smtp_user"] or None,
        password=s["smtp_password"] or None,
        use_tls=not s["smtp_ssl"],
        use_ssl=s["smtp_ssl"],
        timeout=15,
    )
    text = re.sub(r"<[^>]+>", "", html.replace("<br>", "\n").replace("</p>", "\n\n"))
    message = EmailMultiAlternatives(
        subject, text, f"{s['from_name']} <{s['from_email']}>", s["to"], connection=connection
    )
    message.attach_alternative(html, "text/html")
    message.send()


def _mail_html(title, paragraphs, button=None, note=""):
    body = "".join(f'<p style="margin:0 0 14px;line-height:1.6">{p}</p>' for p in paragraphs)
    if button:
        label, url = button
        body += (
            f'<p style="margin:22px 0"><a href="{escape(url)}" style="background:#0b3c7a;color:#ffffff;'
            f'padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">'
            f"{escape(label)}</a></p>"
            f'<p style="margin:0 0 14px;font-size:13px;color:#5b6778">If the button does not work, copy this link '
            f'into your browser:<br><span style="word-break:break-all">{escape(url)}</span></p>'
        )
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;background:#f3f5f9;padding:24px">'
        '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d9dfe8;'
        'border-top:5px solid #ff9933;border-radius:10px;padding:26px;color:#1a2433">'
        '<p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;color:#a35a00;font-weight:bold">'
        "DDMA ERNAKULAM · AUTOMATIC RAIN GAUGE DASHBOARD</p>"
        f'<h2 style="margin:0 0 18px;color:#0b3c7a;font-size:20px">{escape(title)}</h2>{body}'
        f'<p style="margin:24px 0 0;font-size:12px;color:#8a94a3">{note}This is an automated security message. '
        "Do not reply to this email.</p></div></div>"
    )


def _notify_password_changed(how, ip):
    if not mail_configured():
        return
    when = _now_ist().strftime("%d %b %Y, %I:%M %p IST")
    html = _mail_html(
        "Dashboard password changed",
        [
            f"The sign-in password for the ARG monitoring dashboard was {escape(how)} on <b>{when}</b> "
            f"(request from IP {escape(ip)}).",
            "All devices that were signed in have been signed out.",
            "If you did not make this change, use <b>Forgot password?</b> on the sign-in page "
            "immediately and inform the system administrator.",
        ],
    )

    def run():
        try:
            send_mail("ARG dashboard password changed", html)
        except Exception:
            logger.exception("Could not send the password-changed email")

    threading.Thread(target=run, daemon=True).start()


def _reset_token(account):
    return signing.dumps({"u": account["username"], "f": _fingerprint(account)}, salt=RESET_SALT, compress=True)


def _account_for_reset(token):
    try:
        data = signing.loads(token, salt=RESET_SALT, max_age=RESET_MINUTES * 60)
    except signing.BadSignature:
        return None
    account = _account(force=True)
    return account if _token_valid_for(data, account) else None


@csrf_exempt
@require_POST
def login_view(request):
    try:
        account = _account()
    except CredentialStoreUnavailable:
        return _unavailable()
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

    body = _body(request)
    if body is None:
        return _error("Invalid request.", 400)

    username = str(body.get("username", "")).strip()
    password = str(body.get("password", "")).strip()
    user_ok = hmac.compare_digest(username.lower(), account["username"].lower())

    password_ok = _password_matches(account, password)
    if user_ok and not password_ok:
        try:
            account = _account(force=True)
        except CredentialStoreUnavailable:
            return _unavailable()
        password_ok = _password_matches(account, password)

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
    return JsonResponse(_session_payload(account))


@require_GET
@require_auth
def session_view(request):
    account = request.dashboard_account
    return JsonResponse({
        "success": True,
        "user": {"username": account["username"], "name": account["display_name"]},
    })


@csrf_exempt
@require_POST
@require_auth
def change_password_view(request):
    account = request.dashboard_account
    ip = _client_ip(request)
    body = _body(request)
    if body is None:
        return _error("Invalid request.", 400)

    fail_key = f"arg-change-fail:{ip}"
    failures = cache.get(fail_key, 0)
    if failures >= MAX_ATTEMPTS:
        return _error(f"Too many wrong attempts. Try again in {LOCKOUT_MINUTES} minutes.", 429, code="locked")

    current = str(body.get("currentPassword", "")).strip()
    new_password = str(body.get("newPassword", ""))

    if not _password_matches(account, current):
        cache.set(fail_key, failures + 1, LOCKOUT_MINUTES * 60)
        time.sleep(0.6)
        return _error("The current password is incorrect.", 400, field="current")

    problem = password_problem(new_password, account)
    if problem:
        return _error(problem, 400, field="new")

    try:
        save_password(new_password, "changed in dashboard", ip)
        account = _account(force=True)
    except (ClientError, BotoCoreError, OSError, CredentialStoreUnavailable):
        logger.exception("Could not save the new dashboard password")
        return _error("The password could not be saved right now. Please try again.", 503)

    cache.delete(fail_key)
    _notify_password_changed("changed from the dashboard", ip)
    return JsonResponse(_session_payload(account))


@csrf_exempt
@require_POST
def forgot_password_view(request):
    if not mail_configured():
        return _error(
            "Password reset by email is not set up on the server. Contact the system administrator.",
            503,
            code="mail",
        )

    ip = _client_ip(request)
    ip_key = f"arg-forgot:{ip}"
    requests_made = cache.get(ip_key, 0)
    if requests_made >= RESET_REQUESTS_PER_IP:
        return _error("Too many reset requests. Please try again after 30 minutes.", 429, code="locked")
    cache.set(ip_key, requests_made + 1, 30 * 60)

    body = _body(request)
    if body is None:
        return _error("Invalid request.", 400)

    generic = JsonResponse({
        "success": True,
        "message": (
            "If the username is correct, a reset link has been sent to the registered DDMA email "
            f"address. The link is valid for {RESET_MINUTES} minutes."
        ),
    })

    try:
        account = _account(force=True)
    except CredentialStoreUnavailable:
        return _unavailable()

    username = str(body.get("username", "")).strip()
    if not account or not hmac.compare_digest(username.lower(), account["username"].lower()):
        time.sleep(0.6)
        return generic

    if cache.get("arg-forgot-cooldown"):
        return generic
    cache.set("arg-forgot-cooldown", 1, RESET_MAIL_COOLDOWN_SECONDS)

    frontend = _setting("ARG_FRONTEND_URL", "http://localhost:5173").strip().rstrip("/")
    link = f"{frontend}/#reset={_reset_token(account)}"
    expires = (_now_ist() + timedelta(minutes=RESET_MINUTES)).strftime("%I:%M %p IST, %d %b %Y")
    html = _mail_html(
        "Reset your dashboard password",
        [
            "A request was made to reset the sign-in password of the DDMA Ernakulam Automatic Rain Gauge "
            f"monitoring dashboard (request from IP {escape(ip)}).",
            f"The link below can be used <b>once</b> and expires at <b>{expires}</b>.",
        ],
        button=("Set a new password", link),
        note="If you did not request this, ignore this email. The current password stays unchanged. ",
    )

    try:
        send_mail("Reset your ARG dashboard password", html)
    except Exception:
        logger.exception("Could not send the password reset email")
        cache.delete("arg-forgot-cooldown")
        return _error("The reset email could not be sent right now. Please try again later.", 502, code="mail")

    return generic


@csrf_exempt
@require_POST
def reset_check_view(request):
    body = _body(request) or {}
    try:
        account = _account_for_reset(str(body.get("token", "")))
    except CredentialStoreUnavailable:
        return _unavailable()
    if not account:
        return _error("This reset link is invalid, already used or expired. Request a new one.", 400, code="reset")
    return JsonResponse({"success": True, "username": account["username"], "minPasswordLength": MIN_PASSWORD_LENGTH})


@csrf_exempt
@require_POST
def reset_password_view(request):
    body = _body(request)
    if body is None:
        return _error("Invalid request.", 400)
    try:
        account = _account_for_reset(str(body.get("token", "")))
    except CredentialStoreUnavailable:
        return _unavailable()
    if not account:
        return _error("This reset link is invalid, already used or expired. Request a new one.", 400, code="reset")

    new_password = str(body.get("newPassword", ""))
    problem = password_problem(new_password, account)
    if problem:
        return _error(problem, 400, field="new")

    ip = _client_ip(request)
    try:
        save_password(new_password, "reset by email link", ip)
    except (ClientError, BotoCoreError, OSError):
        logger.exception("Could not save the reset dashboard password")
        return _error("The password could not be saved right now. Please try again.", 503)

    cache.delete(f"arg-login-fail:{ip}")
    _notify_password_changed("reset using the emailed link", ip)
    return JsonResponse({"success": True, "message": "Your password has been updated. Sign in with the new password."})


def _normalize_key(value):
    return "".join(str(value).split()).upper()


def recovery_configured():
    return bool(_setting("ARG_RECOVERY_KEY").strip())


def _recovery_matches(attempt):
    stored = _setting("ARG_RECOVERY_KEY").strip()
    if not stored or not attempt:
        return False
    if stored.startswith(("pbkdf2_", "argon2", "bcrypt", "scrypt")):
        return check_password(_normalize_key(attempt), stored)
    return hmac.compare_digest(_normalize_key(attempt).encode(), _normalize_key(stored).encode())


@require_GET
def options_view(request):
    return JsonResponse({
        "success": True,
        "emailReset": mail_configured(),
        "recoveryReset": recovery_configured(),
        "minPasswordLength": MIN_PASSWORD_LENGTH,
    })


@csrf_exempt
@require_POST
def recover_password_view(request):
    if not recovery_configured():
        return _error(
            "Reset with a recovery key is not set up on the server. Contact the system administrator.",
            503,
            code="recovery",
        )

    ip = _client_ip(request)
    fail_key = f"arg-recover-fail:{ip}"
    failures = cache.get(fail_key, 0)
    if failures >= MAX_ATTEMPTS:
        return _error(f"Too many failed attempts. Try again in {LOCKOUT_MINUTES} minutes.", 429, code="locked")

    body = _body(request)
    if body is None:
        return _error("Invalid request.", 400)

    try:
        account = _account(force=True)
    except CredentialStoreUnavailable:
        return _unavailable()
    if not account:
        return _error("Login is not configured on the server.", 503)

    username = str(body.get("username", "")).strip()
    user_ok = hmac.compare_digest(username.lower(), account["username"].lower())
    key_ok = _recovery_matches(body.get("recoveryKey", ""))

    if not (user_ok and key_ok):
        failures += 1
        cache.set(fail_key, failures, LOCKOUT_MINUTES * 60)
        time.sleep(0.6)
        remaining = max(0, MAX_ATTEMPTS - failures)
        if remaining == 0:
            return _error(f"Too many failed attempts. Try again in {LOCKOUT_MINUTES} minutes.", 429, code="locked")
        return _error("Incorrect username or recovery key.", 400, field="key", attemptsLeft=remaining)

    new_password = str(body.get("newPassword", ""))
    problem = password_problem(new_password, account)
    if problem:
        return _error(problem, 400, field="new")

    try:
        save_password(new_password, "reset with recovery key", ip)
    except (ClientError, BotoCoreError, OSError):
        logger.exception("Could not save the recovered dashboard password")
        return _error("The password could not be saved right now. Please try again.", 503)

    cache.delete(fail_key)
    cache.delete(f"arg-login-fail:{ip}")
    _notify_password_changed("reset using the recovery key", ip)
    return JsonResponse({"success": True, "message": "Your password has been reset. Sign in with the new password."})