FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp/pytolino \
    XDG_CONFIG_HOME=/tmp/pytolino/config \
    XDG_DATA_HOME=/tmp/pytolino/data \
    XDG_CACHE_HOME=/tmp/pytolino/cache

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY probe.py test_probe.py ./
USER 65534:65534
ENTRYPOINT ["python", "/app/probe.py"]
