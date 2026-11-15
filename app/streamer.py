"""HTTP range-request file streaming (200 / 206 / 416) via chunked StreamingResponse."""

from __future__ import annotations

import json
import re
from pathlib import Path

from starlette.responses import Response, StreamingResponse

CHUNK_SIZE = 64 * 1024

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$", re.IGNORECASE)


class RangeNotSatisfiable(Exception):
    """Raised for malformed or unsatisfiable Range headers."""


def parse_range(header: str | None, total: int) -> tuple[int, int] | None:
    """Parse a Range header against a file of `total` bytes.

    Returns (start, end) inclusive for a single range, or None when there is
    no Range header (full body). Raises RangeNotSatisfiable for anything
    malformed or out of bounds (per contract: -> 416).
    """
    if header is None:
        return None
    match = _RANGE_RE.match(header.strip())
    if not match:
        raise RangeNotSatisfiable("malformed Range header")
    start_s, end_s = match.group(1), match.group(2)
    if not start_s and not end_s:
        raise RangeNotSatisfiable("empty range")
    if not start_s:
        # Suffix range: "bytes=-N" -> last N bytes.
        suffix = int(end_s)
        if suffix == 0:
            raise RangeNotSatisfiable("zero-length suffix range")
        start = max(0, total - suffix)
        end = total - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else total - 1
    if start >= total:
        raise RangeNotSatisfiable("start beyond end of file")
    end = min(end, total - 1)
    if start > end:
        raise RangeNotSatisfiable("start greater than end")
    return start, end


def _chunks(handle, start: int, length: int):
    try:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            chunk = handle.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
    finally:
        handle.close()


def file_response(path: Path, media_type: str, range_header: str | None) -> Response:
    """Build a (possibly partial) streaming response for `path`."""
    total = path.stat().st_size
    try:
        bounds = parse_range(range_header, total)
    except RangeNotSatisfiable:
        return Response(
            json.dumps({"error": "range not satisfiable"}),
            status_code=416,
            media_type="application/json",
            headers={"Content-Range": f"bytes */{total}", "Accept-Ranges": "bytes"},
        )
    if bounds is None:
        start, length, status = 0, total, 200
    else:
        start, end = bounds
        length = end - start + 1
        status = 206
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    if bounds is not None:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return StreamingResponse(
        _chunks(path.open("rb"), start, length),
        status_code=status,
        media_type=media_type,
        headers=headers,
    )
