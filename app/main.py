"""player backend: FastAPI app with routes, auth, media streaming and static files."""

from __future__ import annotations

import hmac
import logging
import os
import re
import urllib.parse
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import library, streamer
from .downloader import Downloader

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("player")

ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "").strip()
STATIC_DIR = Path(__file__).resolve().parent / "static"
AUTH_EXEMPT_PATHS = {"/api/auth-status", "/api/login"}

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
VIDEO_ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")

downloader = Downloader()


@asynccontextmanager
async def lifespan(_: FastAPI):
    library.ensure_dirs()
    log.info("startup scan: %d library item(s)", len(library.scan()))
    await downloader.start()
    try:
        yield
    finally:
        await downloader.stop()


class HEADAwareAPIRoute(APIRoute):
    """FastAPI's APIRoute (unlike plain Starlette Route) does not answer HEAD
    for GET endpoints. Restore the Starlette behavior so media/API GET routes
    also serve HEAD (needed for streaming clients)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.methods and "GET" in self.methods:
            self.methods.add("HEAD")


app = FastAPI(title="player", lifespan=lifespan)
app.router.route_class = HEADAwareAPIRoute


def error_response(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def _token_ok(supplied: str) -> bool:
    return hmac.compare_digest(supplied.encode("utf-8", "ignore"), ACCESS_TOKEN.encode("utf-8"))


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if ACCESS_TOKEN:
        path = request.url.path
        needs_auth = (
            (path.startswith("/api/") and path not in AUTH_EXEMPT_PATHS)
            or path.startswith("/media/")
        )
        if needs_auth and not _token_ok(request.cookies.get("token", "")):
            return error_response(401, "unauthorized")
    return await call_next(request)


def extract_video_id(url: str) -> str | None:
    """Validate a YouTube URL and extract its 11-char video id, else None."""
    try:
        parts = urllib.parse.urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower()
    if host not in YOUTUBE_HOSTS:
        return None
    candidate = ""
    if host == "youtu.be":
        segments = [s for s in parts.path.split("/") if s]
        if segments:
            candidate = segments[0]
    else:
        query = urllib.parse.parse_qs(parts.query)
        candidate = (query.get("v") or [""])[0]
        if not candidate:
            segments = [s for s in parts.path.split("/") if s]
            if len(segments) >= 2 and segments[0] == "shorts":
                candidate = segments[1]
    match = VIDEO_ID_RE.fullmatch(candidate)
    return match.group(0) if match else None


# ---------------------------------------------------------------- api ----


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/auth-status")
async def auth_status():
    return {"auth_required": bool(ACCESS_TOKEN)}


class LoginBody(BaseModel):
    token: str | None = None


@app.post("/api/login")
async def login(body: LoginBody):
    supplied = body.token or ""
    if ACCESS_TOKEN and not _token_ok(supplied):
        return error_response(401, "invalid token")
    response = JSONResponse({"ok": True})
    response.set_cookie("token", supplied, httponly=True, samesite="lax")
    return response


class DownloadBody(BaseModel):
    url: str | None = None


@app.post("/api/download")
async def download(body: DownloadBody):
    url = (body.url or "").strip()
    video_id = extract_video_id(url)
    if not video_id:
        return error_response(400, "invalid YouTube URL")
    if library.exists_in_library(video_id):
        return error_response(409, "video already in library")
    job = downloader.submit(url, video_id)
    if job is None:
        return error_response(409, "video already queued or downloading")
    return JSONResponse({"job_id": job.id}, status_code=202)


@app.get("/api/jobs")
async def jobs():
    return {"jobs": downloader.list_jobs()}


@app.get("/api/library")
def library_items():
    return {"items": library.scan()}


@app.delete("/api/library/{video_id}")
def library_delete(video_id: str):
    if downloader.is_active(video_id):
        return error_response(409, "video is queued or downloading")
    if not library.exists_in_library(video_id):
        return error_response(404, "not found")
    library.delete(video_id)
    return {"ok": True}


# -------------------------------------------------------------- media ----


@app.get("/media/{video_id}/video")
def media_video(video_id: str, request: Request):
    path = library.find_video_file(video_id)
    if path is None:
        return error_response(404, "not found")
    return streamer.file_response(
        path,
        library.VIDEO_MIMES.get(path.suffix.lower(), "video/mp4"),
        request.headers.get("range"),
    )


@app.get("/media/{video_id}/audio")
def media_audio(video_id: str, request: Request):
    path = library.find_audio_file(video_id)
    if path is None:
        return error_response(404, "not found")
    return streamer.file_response(path, "audio/mpeg", request.headers.get("range"))


@app.get("/media/{video_id}/thumb")
def media_thumb(video_id: str, request: Request):
    found = library.find_thumb_file(video_id)
    if found is None:
        return error_response(404, "not found")
    path, mime = found
    return streamer.file_response(path, mime, request.headers.get("range"))


# ------------------------------------------------------------- static ----

app.mount(
    "/",
    StaticFiles(directory=str(STATIC_DIR), html=True, check_dir=False),
    name="static",
)
