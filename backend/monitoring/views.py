from datetime import datetime, timezone

from botocore.exceptions import BotoCoreError, ClientError
from django.http import JsonResponse
from rest_framework.decorators import api_view

from .services import (
    DEFAULT_STATION_ID,
    StationNotConfigured,
    StationNotFound,
    get_station_data,
    list_stations,
)


def _station_response(station_id):
    try:
        station, data = get_station_data(station_id)
        return JsonResponse({
            "success": True,
            "station": {"id": station["id"], "name": station["name"]},
            "data": data,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        })

    except StationNotFound:
        return JsonResponse({
            "success": False,
            "error": f"Unknown station: {station_id}",
        }, status=404)

    except StationNotConfigured:
        return JsonResponse({
            "success": False,
            "error": "This station is not commissioned yet",
        }, status=503)

    except (ClientError, BotoCoreError):
        return JsonResponse({
            "success": False,
            "error": "Unable to read station data from AWS S3",
        }, status=502)

    except (ValueError, UnicodeDecodeError):
        return JsonResponse({
            "success": False,
            "error": "Invalid JSON in the S3 object",
        }, status=502)


@api_view(["GET"])
def station_list(request):
    return JsonResponse({"success": True, "stations": list_stations()})


@api_view(["GET"])
def station_latest(request, station_id):
    return _station_response(station_id)


@api_view(["GET"])
def latest_arg_data(request):
    return _station_response(DEFAULT_STATION_ID)