FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-driver xvfb xauth x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && chown -R 65534:65534 /usr/local/lib/python3.12/site-packages/seleniumbase/drivers \
    && mkdir /data && chown 65534:65534 /data && chmod 700 /data
COPY probe.py login_server.py test_login_server.py browser_smoke.py thalia_client.py companion.py test_companion.py dashboard.html dashboard.css dashboard.js display.js fixture_server.py session_store.py test_session_store.py setup_storage.py /app/
ENV DISPLAY=:99 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp/pytolino \
    XDG_CONFIG_HOME=/tmp/pytolino/config \
    XDG_DATA_HOME=/tmp/pytolino/data \
    XDG_CACHE_HOME=/tmp/pytolino/cache
USER 65534:65534
EXPOSE 8080 8081 6080
ENTRYPOINT ["python", "/app/login_server.py"]
