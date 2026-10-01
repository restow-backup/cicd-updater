# The FastNotes image. Migrations run at container start (alembic upgrade head), so
# the updater's probe sees them through the alembic_version table.
FROM python:3.13-slim
ARG VERSION=0.0.0-dev
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_VERSION=${VERSION}
WORKDIR /app
COPY app/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app/alembic.ini ./
COPY app/migrations migrations
COPY app/fastnotes fastnotes
# A fixed gid: updater.yaml gives this group read access to the shared token.
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid 10001 app
USER app
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn fastnotes.main:app --host 0.0.0.0 --port 8000"]
