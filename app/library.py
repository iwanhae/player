"""Stateless media library: everything is derived from DATA_DIR/media/*/meta.json on disk.

No database. A video "exists" in the library iff {DATA_DIR}/media/{id}/meta.json exists.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

VIDEO_MIMES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/matroska",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".flv": "video/x-flv",
    ".ts": "video/mp2t",
    ".3gp": "video/3gpp",
}

IMAGE_MIMES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".png": "image/png",
}

THUMB_EXTS = (".jpg", ".jpeg", ".webp", ".png")

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data")).resolve()
MEDIA_DIR = DATA_DIR / "media"


def valid_id(video_id: str) -> bool:
    return isinstance(video_id, str) and bool(VIDEO_ID_RE.match(video_id))


def ensure_dirs() -> None:
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)


def media_dir(video_id: str) -> Path:
    return MEDIA_DIR / video_id


def find_video_file(video_id: str) -> Path | None:
    """Locate the downloaded video file (video.<ext>, preferring mp4)."""
    if not valid_id(video_id):
        return None
    d = media_dir(video_id)
    if not d.is_dir():
        return None
    candidates = [
        p for p in d.glob("video.*")
        if p.is_file() and p.suffix.lower() in VIDEO_MIMES
    ]
    candidates.sort(key=lambda p: (p.suffix.lower() != ".mp4", p.name))
    return candidates[0] if candidates else None


def find_audio_file(video_id: str) -> Path | None:
    if not valid_id(video_id):
        return None
    p = media_dir(video_id) / "audio.mp3"
    return p if p.is_file() else None


def find_thumb_file(video_id: str) -> tuple[Path, str] | None:
    """Locate the thumbnail, preferring the normalized thumb.jpg."""
    if not valid_id(video_id):
        return None
    d = media_dir(video_id)
    if not d.is_dir():
        return None
    for name in ("thumb.jpg", "thumb.jpeg", "thumb.webp", "thumb.png"):
        p = d / name
        if p.is_file():
            return p, IMAGE_MIMES[p.suffix.lower()]
    # Fall back to un-normalized thumbnails left by yt-dlp (video.webp, video.png, ...).
    for p in sorted(d.glob("video.*")):
        if p.is_file() and p.suffix.lower() in IMAGE_MIMES:
            return p, IMAGE_MIMES[p.suffix.lower()]
    return None


def exists_in_library(video_id: str) -> bool:
    return valid_id(video_id) and (media_dir(video_id) / "meta.json").is_file()


def write_meta(video_id: str, meta: dict) -> None:
    (media_dir(video_id) / "meta.json").write_text(
        json.dumps(meta, indent=2), encoding="utf-8"
    )


def read_meta(video_id: str) -> dict | None:
    if not exists_in_library(video_id):
        return None
    try:
        return json.loads((media_dir(video_id) / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _build_item(meta: dict, video_id: str) -> dict:
    video = find_video_file(video_id)
    audio = find_audio_file(video_id)
    size_video = meta.get("size_video")
    if size_video is None and video is not None:
        size_video = video.stat().st_size
    size_audio = meta.get("size_audio")
    if size_audio is None and audio is not None:
        size_audio = audio.stat().st_size
    return {
        "id": video_id,
        "title": meta.get("title") or "",
        "uploader": meta.get("uploader") or "",
        "duration": int(meta.get("duration") or 0),
        "downloaded_at": meta.get("downloaded_at") or "",
        "has_video": video is not None,
        "has_audio": audio is not None,
        "thumb_url": f"/media/{video_id}/thumb",
        "video_url": f"/media/{video_id}/video",
        "audio_url": f"/media/{video_id}/audio",
        "size_video": size_video,
        "size_audio": size_audio,
    }


def read_item(video_id: str) -> dict | None:
    meta = read_meta(video_id)
    if meta is None:
        return None
    return _build_item(meta, video_id)


def scan() -> list[dict]:
    """Rescan media/*/meta.json; items sorted by downloaded_at descending."""
    items: list[dict] = []
    if MEDIA_DIR.is_dir():
        for entry in MEDIA_DIR.iterdir():
            if not entry.is_dir():
                continue
            item = read_item(entry.name)
            if item is not None:
                items.append(item)
    items.sort(key=lambda it: it["downloaded_at"], reverse=True)
    return items


def delete(video_id: str) -> bool:
    d = media_dir(video_id)
    if not valid_id(video_id) or not d.is_dir():
        return False
    shutil.rmtree(d, ignore_errors=True)
    return True
