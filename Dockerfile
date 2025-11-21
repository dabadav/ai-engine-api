FROM python:3.12-slim

WORKDIR /app

# System deps (optional)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

# Install Poetry
RUN pip install poetry

# Copy and install Python deps
COPY pyproject.toml poetry.lock* ./

# Install dependencies and copy the source code
RUN poetry install --no-root --only main
COPY . .

# Expose & run API (adapt to your actual app)
EXPOSE 8000
CMD ["poetry", "run", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8000"]
