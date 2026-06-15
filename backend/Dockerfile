FROM python:3.12-slim

WORKDIR /app

COPY requirements-prod.txt .
RUN pip install --no-cache-dir -r requirements-prod.txt
ENV no_proxy=10.145.8.23,10.145.2.248,127.0.0.1,::1,10.0.0.0/8,192.168.0.0/16
COPY . .

EXPOSE 8706

CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "8706", \
     "--workers", "1", \
     "--loop", "uvloop", \
     "--http", "httptools"]