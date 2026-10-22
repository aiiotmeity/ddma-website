import csv
import io
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import boto3
from dotenv import load_dotenv

load_dotenv()

REGION = os.getenv("AWS_REGION", "us-east-1")
DEFAULT_BUCKET = os.getenv("AWS_S3_BUCKET")
DEFAULT_STATION_ID = "ARGS1"
HISTORY_CACHE_SECONDS = int(os.getenv("HISTORY_CACHE_SECONDS", "60"))
IST = timezone(timedelta(hours=5, minutes=30))

STATIONS = [
    {
        "id": "ARGS1",
        "name": "Illithode",
        "bucket": os.getenv("ARGS1_S3_BUCKET", DEFAULT_BUCKET),
        "key": os.getenv("ARGS1_S3_KEY", os.getenv("AWS_S3_KEY")),
        "history_key": os.getenv("ARGS1_S3_HISTORY_KEY"),
    },
    {
        "id": "ARGS2",
        "name": "Kuttampuzha",
        "bucket": os.getenv("ARGS2_S3_BUCKET", DEFAULT_BUCKET),
        "key": os.getenv("ARGS2_S3_KEY"),
        "history_key": os.getenv("ARGS2_S3_HISTORY_KEY"),
    },
]

FIELDS = {
    "rainfall": ["rfdmm", "rfd", "rainfall", "rainfallmm", "rain", "precipitation"],
    "temperature": ["tc", "temp", "temperature", "temperaturec", "atc"],
    "humidity": ["rh", "humidity", "relativehumidity", "rhpercent"],
    "time": ["timestamp", "observedat", "datetime", "time", "date"],
}

TIME_FORMATS = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%d-%m-%Y %H:%M:%S",
    "%d-%m-%Y %H:%M",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
]


class StationNotFound(Exception):
    pass


class StationNotConfigured(RuntimeError):
    pass


class HistoryNotFound(Exception):
    pass


@lru_cache(maxsize=1)
def _s3_client():
    return boto3.client("s3", region_name=REGION)


def _is_configured(station):
    return bool(station.get("bucket") and station.get("key"))


def _history_key(station):
    if station.get("history_key"):
        return station["history_key"]
    key = station.get("key")
    if not key:
        return None
    folder, _, _ = key.rpartition("/")
    prefix = f"{folder}/" if folder else ""
    return f"{prefix}{station['id']}_MASTER_LOG.csv"


def get_station(station_id):
    wanted = str(station_id).strip().upper()
    for station in STATIONS:
        if station["id"].upper() == wanted:
            return station
    raise StationNotFound(station_id)


def list_stations():
    return [
        {
            "id": station["id"],
            "name": station["name"],
            "status": "active" if _is_configured(station) else "pending",
        }
        for station in STATIONS
    ]


def get_station_data(station_id):
    station = get_station(station_id)

    if not _is_configured(station):
        raise StationNotConfigured(f"{station['id']} is not configured yet")

    response = _s3_client().get_object(Bucket=station["bucket"], Key=station["key"])
    content = response["Body"].read().decode("utf-8")
    data = json.loads(content)

    if not isinstance(data, dict):
        raise ValueError("Expected a JSON object from S3")

    return station, data


def get_latest_arg_data():
    _, data = get_station_data(DEFAULT_STATION_ID)
    return data


def _normalize(name):
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def _column_map(headers):
    found = {}
    for header in headers:
        norm = _normalize(header)
        for field, names in FIELDS.items():
            if field not in found and norm in names:
                found[field] = header
    return found


def _to_float(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"na", "nan", "null", "none", "-"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_time(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    if text.replace(".", "", 1).isdigit():
        number = float(text)
        seconds = number / 1000 if number > 1e12 else number
        return datetime.fromtimestamp(seconds, tz=timezone.utc)

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
        for fmt in TIME_FORMATS:
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue

    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=IST)
    return parsed


def _parse_log(content):
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    headers = [h for h in (reader.fieldnames or []) if h]
    columns = _column_map(headers)

    if "time" not in columns:
        raise ValueError("Master log has no timestamp column")

    readings = {}
    skipped = 0
    for row in reader:
        moment = parse_time(row.get(columns["time"]))
        if moment is None:
            skipped += 1
            continue
        ms = int(moment.timestamp() * 1000)
        readings[ms] = {
            "t": ms,
            "label": str(row.get(columns["time"], "")).strip(),
            "rainfall": _to_float(row.get(columns.get("rainfall"))) if "rainfall" in columns else None,
            "temperature": _to_float(row.get(columns.get("temperature"))) if "temperature" in columns else None,
            "humidity": _to_float(row.get(columns.get("humidity"))) if "humidity" in columns else None,
        }

    ordered = [readings[k] for k in sorted(readings)]
    return ordered, {"columns": columns, "headers": headers, "skippedRows": skipped}


_cache = {}
_cache_lock = threading.Lock()


def _load_history(station):
    if not _is_configured(station):
        raise StationNotConfigured(f"{station['id']} is not configured yet")

    key = _history_key(station)
    cache_id = (station["bucket"], key)
    now = time.monotonic()

    with _cache_lock:
        cached = _cache.get(cache_id)
        if cached and now - cached["at"] < HISTORY_CACHE_SECONDS:
            return cached["readings"], cached["meta"]

    client = _s3_client()
    try:
        if cached:
            head = client.head_object(Bucket=station["bucket"], Key=key)
            if head.get("ETag") == cached["etag"]:
                with _cache_lock:
                    cached["at"] = now
                return cached["readings"], cached["meta"]

        response = client.get_object(Bucket=station["bucket"], Key=key)
    except client.exceptions.NoSuchKey as exc:
        raise HistoryNotFound(key) from exc
    except Exception as exc:
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if code in {"NoSuchKey", "404", "NotFound"}:
            raise HistoryNotFound(key) from exc
        raise

    readings, meta = _parse_log(response["Body"].read())
    meta["source"] = f"s3://{station['bucket']}/{key}"

    with _cache_lock:
        _cache[cache_id] = {
            "at": now,
            "etag": response.get("ETag"),
            "readings": readings,
            "meta": meta,
        }
    return readings, meta


def thin_readings(readings, interval_minutes):
    if not interval_minutes or interval_minutes <= 0:
        return readings
    slot_ms = int(interval_minutes * 60 * 1000)
    kept = []
    last_slot = None
    for reading in readings:
        slot = reading["t"] // slot_ms
        if slot != last_slot:
            kept.append(reading)
            last_slot = slot
    return kept


def get_station_history(station_id, hours=None, interval_minutes=None):
    station = get_station(station_id)
    readings, meta = _load_history(station)

    selected = readings
    if hours and readings:
        cutoff = readings[-1]["t"] - int(hours * 3600 * 1000)
        selected = [r for r in readings if r["t"] >= cutoff]
    selected = thin_readings(selected, interval_minutes)

    summary = {
        "source": meta["source"],
        "totalReadings": len(readings),
        "firstReading": readings[0]["t"] if readings else None,
        "lastReading": readings[-1]["t"] if readings else None,
        "skippedRows": meta["skippedRows"],
        "columns": meta["columns"],
        "intervalMinutes": interval_minutes or None,
    }
    return station, selected, summary


def open_master_log(station_id):
    station = get_station(station_id)
    if not _is_configured(station):
        raise StationNotConfigured(f"{station['id']} is not configured yet")

    key = _history_key(station)
    client = _s3_client()
    try:
        response = client.get_object(Bucket=station["bucket"], Key=key)
    except Exception as exc:
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if code in {"NoSuchKey", "404", "NotFound"}:
            raise HistoryNotFound(key) from exc
        raise
    return station, key.rpartition("/")[2], response["Body"]