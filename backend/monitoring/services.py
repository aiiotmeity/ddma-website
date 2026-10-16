import json
import os
from functools import lru_cache

import boto3
from dotenv import load_dotenv

load_dotenv()

REGION = os.getenv("AWS_REGION", "us-east-1")
DEFAULT_BUCKET = os.getenv("AWS_S3_BUCKET")
DEFAULT_STATION_ID = "ARGS1"

STATIONS = [
    {
        "id": "ARGS1",
        "name": "Illithode",
        "bucket": os.getenv("ARGS1_S3_BUCKET", DEFAULT_BUCKET),
        "key": os.getenv("ARGS1_S3_KEY", os.getenv("AWS_S3_KEY")),
    },
    {
        "id": "ARGS2",
        "name": "Kuttampuzha",
        "bucket": os.getenv("ARGS2_S3_BUCKET", DEFAULT_BUCKET),
        "key": os.getenv("ARGS2_S3_KEY"),
    },
]


class StationNotFound(Exception):
    pass


class StationNotConfigured(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _s3_client():
    return boto3.client("s3", region_name=REGION)


def _is_configured(station):
    return bool(station.get("bucket") and station.get("key"))


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