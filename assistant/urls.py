from django.urls import path

from . import views

urlpatterns = [
    path("", views.board, name="board"),
    path("api/health", views.api_health, name="api_health"),
    path("api/transcribe", views.api_transcribe, name="api_transcribe"),
    path("api/command", views.api_command, name="api_command"),
    path("api/tts", views.api_tts, name="api_tts"),
    path("api/image", views.api_image, name="api_image"),
]
