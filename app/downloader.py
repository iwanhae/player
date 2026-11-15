"""Sequential download queue: one yt-dlp subprocess at a time, plus ffmpeg MP3 extraction.

Jobs are FIFO via an asyncio.Queue and processed by a single worker task started
from the FastAPI lifespan. Progress is parsed from yt-dlp stdout using a
--progress-template so fields are machine-readable.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import library

log = logging.getLogger("player.downloader")

# Prefer H.264/AAC MP4 at the highest resolution available (YouTube avc1 tops at
# ~1080p60), merging to mp4; progressively looser fallbacks after that.
VIDEO_FORMAT = (
    "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/"
    "bestvideo[vcodec^=avc1]+bestaudio/"
    "best[ext=mp4]/"
    "bestvideo+bestaudio/"
    "b"
)

# Machine-readable progress line: downloaded / total / total_estimate (bytes,
# "NA" when unknown), speed (bytes/s), eta (seconds). Emitted once per update
# thanks to --newline.
PROGRESS_TEMPLATE = (
    "download:PG %(progress.downloaded_bytes)s %(progress.total_bytes)s "
    "%(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s"
)

ACTIVE_STATES = {"queued", "downloading", "extracting"}


def _find_binary(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    fallback = Path.home() / ".local" / "bin" / name
    if fallback.is_file():
        return str(fallback)
    return name


YTDLP_BIN = _find_binary("yt-dlp")
FFMPEG_BIN = _find_binary("ffmpeg")


class DownloadError(Exception):
    """Pipeline failure; str(exc) becomes the job's error message."""


@dataclass
class Job:
    id: str
    url: str
    video_id: str
    state: str = "queued"
    title: str | None = None
    progress: float | None = None
    speed: str | None = None
    eta: str | None = None
    error: str | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "url": self.url,
            "video_id": self.video_id,
            "title": self.title,
            "progress": self.progress,
            "speed": self.speed,
            "eta": self.eta,
            "error": self.error,
        }


def _last_line(text: bytes) -> str:
    line = ""
    for raw in text.decode("utf-8", "replace").splitlines():
        raw = raw.strip()
        if raw:
            line = raw
    return line


def _human_size(n: float) -> str:
    n = float(n)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024 or unit == "TiB":
            if unit == "B":
                return f"{int(n)}B"
            return f"{n:.2f}{unit}"
        n /= 1024
    return f"{n:.2f}TiB"


def _human_eta(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


class Downloader:
    """FIFO job queue with a single worker (strictly sequential downloads)."""

    KEEP_JOBS = 100   # in-memory history cap (well above the API's 20)
    LIST_LIMIT = 20

    def __init__(self) -> None:
        self._queue: asyncio.Queue[Job] = asyncio.Queue()
        self._jobs: list[Job] = []
        self._worker_task: asyncio.Task | None = None
        self._proc: asyncio.subprocess.Process | None = None

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._worker(), name="downloader-worker")

    async def stop(self) -> None:
        task = self._worker_task
        self._worker_task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._kill_current()

    def _kill_current(self) -> None:
        proc = self._proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, OSError):
                proc.kill()

    # -- public API --------------------------------------------------------

    def is_active(self, video_id: str) -> bool:
        return any(
            j.video_id == video_id and j.state in ACTIVE_STATES
            for j in self._jobs
        )

    def submit(self, url: str, video_id: str) -> Job | None:
        """Enqueue a job. Returns None if this video is already queued/active."""
        if self.is_active(video_id):
            return None
        job = Job(id=f"j-{secrets.token_hex(4)}", url=url, video_id=video_id)
        self._jobs.append(job)
        if len(self._jobs) > self.KEEP_JOBS:
            self._jobs = self._jobs[-self.KEEP_JOBS:]
        self._queue.put_nowait(job)
        log.info("job %s queued for %s (%s)", job.id, video_id, url)
        return job

    def list_jobs(self) -> list[dict]:
        return [j.public() for j in reversed(self._jobs)][: self.LIST_LIMIT]

    # -- worker ------------------------------------------------------------

    async def _worker(self) -> None:
        while True:
            job = await self._queue.get()
            try:
                await self._process(job)
            except Exception as exc:  # defensive: _process handles its own errors
                job.state, job.error = "error", f"internal error: {exc}"
                job.progress = job.speed = job.eta = None
                log.exception("job %s crashed", job.id)
            finally:
                self._queue.task_done()

    async def _process(self, job: Job) -> None:
        out_dir = library.media_dir(job.video_id)
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            job.state, job.progress = "downloading", 0.0
            info = await self._probe(job.url)
            title = (info.get("title") or "").strip()
            if title:
                job.title = title

            await self._download(job, out_dir)

            video = library.find_video_file(job.video_id)
            if video is None:
                raise DownloadError("yt-dlp did not produce a video file")

            job.state, job.progress = "extracting", None
            job.speed = job.eta = None
            audio = out_dir / "audio.mp3"
            has_audio = await self._extract_mp3(video, audio)

            self._normalize_thumbnail(out_dir)

            library.write_meta(job.video_id, {
                "id": job.video_id,
                "title": title,
                "uploader": (info.get("uploader") or info.get("channel") or "").strip(),
                "duration": int(info.get("duration") or 0),
                "downloaded_at": datetime.now(timezone.utc).isoformat(),
                "video_ext": video.suffix.lower().lstrip("."),
                "size_video": video.stat().st_size,
                "size_audio": audio.stat().st_size if has_audio else None,
            })
            job.state, job.progress = "done", 100.0
            log.info("job %s done: %s", job.id, title or job.video_id)
        except asyncio.CancelledError:
            shutil.rmtree(out_dir, ignore_errors=True)
            job.state, job.error = "error", "cancelled"
            job.progress = job.speed = job.eta = None
        except DownloadError as exc:
            shutil.rmtree(out_dir, ignore_errors=True)
            job.state, job.error = "error", str(exc) or "download failed"
            job.progress = job.speed = job.eta = None
            log.warning("job %s failed: %s", job.id, job.error)
        except Exception as exc:
            shutil.rmtree(out_dir, ignore_errors=True)
            job.state, job.error = "error", f"internal error: {exc}"
            job.progress = job.speed = job.eta = None
            log.exception("job %s crashed", job.id)

    # -- pipeline steps ----------------------------------------------------

    async def _probe(self, url: str) -> dict:
        """Quick metadata fetch (--dump-single-json)."""
        proc = await asyncio.create_subprocess_exec(
            YTDLP_BIN, "--no-playlist", "--dump-single-json", url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._proc = proc
        try:
            stdout, stderr = await proc.communicate()
        except asyncio.CancelledError:
            self._kill_current()
            raise
        finally:
            self._proc = None
        if proc.returncode != 0:
            raise DownloadError(_last_line(stderr) or "yt-dlp failed to fetch metadata")
        try:
            return json.loads(stdout)
        except ValueError:
            raise DownloadError("yt-dlp returned unreadable metadata") from None

    async def _download(self, job: Job, out_dir: Path) -> None:
        out_template = str(out_dir / "video.%(ext)s")
        cmd = [
            YTDLP_BIN,
            "-f", VIDEO_FORMAT,
            "--merge-output-format", "mp4",
            "--no-playlist",
            "--write-thumbnail",
            "--convert-thumbnails", "jpg",
            "--newline",
            "--progress-template", PROGRESS_TEMPLATE,
            "-o", out_template,
            job.url,
        ]
        log.info("job %s: running %s", job.id, " ".join(cmd))
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._proc = proc
        stderr_task = asyncio.create_task(self._drain_last_stderr(proc.stderr))
        try:
            assert proc.stdout is not None
            async for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("PG "):
                    self._update_progress(job, line)
            returncode = await proc.wait()
        except asyncio.CancelledError:
            self._kill_current()
            stderr_task.cancel()
            with contextlib.suppress(Exception):
                await stderr_task
            raise
        finally:
            self._proc = None
        stderr_last = await stderr_task
        if returncode != 0:
            raise DownloadError(stderr_last or f"yt-dlp exited with code {returncode}")

    async def _drain_last_stderr(self, stream: asyncio.StreamReader | None) -> str:
        last = ""
        if stream is None:
            return last
        while True:
            try:
                raw = await stream.readline()
            except Exception:
                break
            if not raw:
                break
            text = raw.decode("utf-8", "replace").strip()
            if text:
                last = text
        return last

    async def _extract_mp3(self, video: Path, audio: Path) -> bool:
        """ffmpeg 320k CBR MP3 extraction. Failure is non-fatal."""
        proc = await asyncio.create_subprocess_exec(
            FFMPEG_BIN, "-y", "-i", str(video),
            "-vn", "-c:a", "libmp3lame", "-b:a", "320k", str(audio),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        self._proc = proc
        try:
            _, stderr = await proc.communicate()
        except asyncio.CancelledError:
            self._kill_current()
            raise
        finally:
            self._proc = None
        if proc.returncode != 0 or not audio.is_file():
            log.warning("mp3 extraction failed for %s: %s", video.name, _last_line(stderr))
            with contextlib.suppress(OSError):
                audio.unlink()
            return False
        return True

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _update_progress(job: Job, line: str) -> None:
        # "PG <downloaded> <total> <total_estimate> <speed> <eta>" with "NA" holes.
        values: list[float | None] = []
        for token in line[3:].split():
            try:
                values.append(float(token))
            except ValueError:
                values.append(None)
        downloaded = values[0] if len(values) > 0 else None
        total = (values[1] if len(values) > 1 and values[1] is not None
                 else (values[2] if len(values) > 2 else None))
        speed = values[3] if len(values) > 3 else None
        eta = values[4] if len(values) > 4 else None
        if downloaded is not None and total:
            job.progress = round(min(100.0, downloaded / total * 100.0), 1)
        if speed is not None:
            job.speed = f"{_human_size(speed)}/s"
        if eta is not None:
            job.eta = _human_eta(eta)

    @staticmethod
    def _normalize_thumbnail(out_dir: Path) -> None:
        """Rename yt-dlp's thumbnail (video.jpg/webp/...) to thumb.<ext>, jpg preferred."""
        images = sorted(
            p for p in out_dir.iterdir()
            if p.is_file() and p.suffix.lower() in library.THUMB_EXTS
        )
        chosen: Path | None = None
        for ext in (".jpg", ".jpeg", ".webp", ".png"):
            chosen = next((p for p in images if p.suffix.lower() == ext), None)
            if chosen is not None:
                break
        if chosen is None:
            return
        target = out_dir / f"thumb{chosen.suffix.lower()}"
        if chosen != target:
            chosen.replace(target)
        for p in images:
            if p not in (chosen, target):
                with contextlib.suppress(OSError):
                    p.unlink()
