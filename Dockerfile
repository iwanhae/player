FROM python:3.12-slim

# ffmpeg for media extraction; ca-certificates for HTTPS to YouTube
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ /app/app/

# Non-root user with uid/gid 1000 (matches typical Linux user, so the
# mounted ./data volume ends up owned by the right user)
RUN groupadd -g 1000 player \
    && useradd -u 1000 -g 1000 -s /usr/sbin/nologin player \
    && mkdir -p /data \
    && chown -R player:player /data /app

USER player

ENV DATA_DIR=/data

EXPOSE 8000
VOLUME /data

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
