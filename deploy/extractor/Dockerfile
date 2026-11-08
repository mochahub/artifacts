FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
COPY extract.py /opt/extract.py
USER 65534:65534
ENTRYPOINT ["python3", "-I", "/opt/extract.py"]
