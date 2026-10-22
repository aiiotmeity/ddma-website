from datetime import datetime, timezone

from botocore.exceptions import BotoCoreError, ClientError
from django.http import JsonResponse, StreamingHttpResponse
from rest_framework.decorators import api_view

from .auth import require_auth
from .services import (
    DEFAULT_STATION_ID,
    HistoryNotFound,
    StationNotConfigured,
    StationNotFound,
    get_station_data,
    get_station_history,
    list_stations,
    open_master_log,
)


DEFAULT_INTERVAL_MINUTES = 30


def _error(message, status):
    return JsonResponse({"success": False, "error": message}, status=status)


def _handle(station_id, action):
    try:
        return action()
    except StationNotFound:
        return _error(f"Unknown station: {station_id}", 404)
    except StationNotConfigured:
        return _error("This station is not commissioned yet", 503)
    except HistoryNotFound:
        return _error("Master log not found for this station", 404)
    except (ClientError, BotoCoreError):
        return _error("Unable to read station data from AWS S3", 502)
    except (ValueError, UnicodeDecodeError) as exc:
        return _error(f"Invalid data in S3: {exc}", 502)


def _station_response(station_id):
    def action():
        station, data = get_station_data(station_id)
        return JsonResponse({
            "success": True,
            "station": {"id": station["id"], "name": station["name"]},
            "data": data,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        })

    return _handle(station_id, action)


@api_view(["GET"])
@require_auth
def station_list(request):
    return JsonResponse({"success": True, "stations": list_stations()})


@api_view(["GET"])
@require_auth
def station_latest(request, station_id):
    return _station_response(station_id)


@api_view(["GET"])
@require_auth
def latest_arg_data(request):
    return _station_response(DEFAULT_STATION_ID)


@api_view(["GET"])
@require_auth
def station_history(request, station_id):
    try:
        hours = float(request.GET.get("hours", "24"))
    except ValueError:
        return _error("hours must be a number", 400)
    if hours < 0:
        return _error("hours must be 0 or more", 400)

    try:
        interval = int(request.GET.get("interval", str(DEFAULT_INTERVAL_MINUTES)))
    except ValueError:
        return _error("interval must be a whole number of minutes", 400)
    if interval < 0:
        return _error("interval must be 0 or more", 400)

    def action():
        station, readings, summary = get_station_history(station_id, hours or None, interval or None)
        return JsonResponse({
            "success": True,
            "station": {"id": station["id"], "name": station["name"]},
            "hours": hours or None,
            "intervalMinutes": interval or None,
            "count": len(readings),
            "summary": summary,
            "readings": readings,
        })

    return _handle(station_id, action)


@api_view(["GET"])
@require_auth
def station_history_csv(request, station_id):
    def action():
        station, filename, body = open_master_log(station_id)
        response = StreamingHttpResponse(
            body.iter_chunks(chunk_size=64 * 1024),
            content_type="text/csv; charset=utf-8",
        )
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        response["Cache-Control"] = "no-store"
        return response

    return _handle(station_id, action)