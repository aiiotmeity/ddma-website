from django.urls import path

from . import auth, views

urlpatterns = [
    path("auth/login/", auth.login_view),
    path("auth/session/", auth.session_view),
    path("arg/stations/", views.station_list),
    path("arg/latest/", views.latest_arg_data),
    path("arg/<str:station_id>/latest/", views.station_latest),
    path("arg/<str:station_id>/history/", views.station_history),
    path("arg/<str:station_id>/history.csv", views.station_history_csv),
]