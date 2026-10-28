from django.urls import path

from . import auth, views

urlpatterns = [
    path("auth/login/", auth.login_view),
    path("auth/session/", auth.session_view),
    path("auth/options/", auth.options_view),
    path("auth/recover/", auth.recover_password_view),
    path("auth/change-password/", auth.change_password_view),
    path("auth/forgot-password/", auth.forgot_password_view),
    path("auth/reset-password/check/", auth.reset_check_view),
    path("auth/reset-password/", auth.reset_password_view),
    path("arg/stations/", views.station_list),
    path("arg/latest/", views.latest_arg_data),
    path("arg/<str:station_id>/latest/", views.station_latest),
    path("arg/<str:station_id>/history/", views.station_history),
    path("arg/<str:station_id>/history.csv", views.station_history_csv),
]