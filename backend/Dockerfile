# backend/Dockerfile
# TODO: pin to digest before production (see security audit M6)
FROM python:3.12.4-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN adduser --disabled-password --gecos "" appuser \
    && chown -R appuser:appuser /app
USER appuser

# Base image runs without proxy trust — proxy-aware flags belong in
# docker-compose.prod.yml (or your production orchestration) only.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
