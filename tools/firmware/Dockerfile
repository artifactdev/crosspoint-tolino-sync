FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential cmake ninja-build curl unzip zip \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "pioarduino==6.1.19" \
    "littlefs-python>=0.16.0" "fatfs-ng>=0.1.14" "pyyaml>=6.0.2" \
    "rich-click>=1.8.6" "zopfli>=0.2.2" "intelhex>=2.3.0" "rich>=14.0.0" \
    "urllib3<2" "cryptography>=45.0.3" "certifi>=2025.8.3" "ecdsa>=0.19.1" \
    "bitstring>=4.3.1" "reedsolo>=1.5.3,<1.8" "esp-idf-size>=2.0.0" "esp-coredump>=1.14.0"
WORKDIR /firmware
CMD ["pio", "run", "-e", "x4pro-gh_release", "-j", "2"]
