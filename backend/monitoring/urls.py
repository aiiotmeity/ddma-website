from django.urls import path

from . import views

urlpatterns = [
    path("arg/stations/", views.station_list),
    path("arg/latest/", views.latest_arg_data),
    path("arg/<str:station_id>/latest/", views.station_latest),
]