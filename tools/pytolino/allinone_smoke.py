"""Run an isolated Docker integration test without provider login or real data."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def docker(*args, capture=False, check=True):
    return subprocess.run(["docker", *args], check=check, text=True,
                          stdout=subprocess.PIPE if capture else None)


def wait_healthy(name):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        state = json.loads(docker("inspect", name, capture=True).stdout)[0]["State"]
        if not state["Running"]:
            docker("logs", name)
            raise RuntimeError("Combined container exited before becoming healthy.")
        if state.get("Health", {}).get("Status") == "healthy":
            return
        time.sleep(2)
    docker("logs", name)
    raise TimeoutError("Combined container did not become healthy.")


def main(image, single_path=False):
    name = "tolino-allinone-smoke-" + uuid.uuid4().hex[:12]
    volume = name + "-data"
    created = False
    with tempfile.TemporaryDirectory(prefix="tolino-allinone-smoke-") as root:
        directory = root
        if single_path:
            os.chmod(root, 0o777)
            directory = str(Path(root) / "secrets")
            Path(directory).mkdir()
        # Disposable fixture secrets only; the image's unprivileged user creates them.
        os.chmod(directory, 0o777)
        try:
            docker("run", "--rm", "--pull=never", "-v", directory + ":/secrets",
                   "--entrypoint", "python", image, "/app/setup_storage.py")
            docker("run", "--rm", "--pull=never", "-v", directory + ":/secrets",
                   "--entrypoint", "python", image, "-c",
                   "import os,secrets;fd=os.open('/secrets/sync-storage-key',"
                   "os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);"
                   "os.write(fd,secrets.token_hex(32).encode());os.close(fd)")
            if not single_path:
                docker("volume", "create", volume)
            command = [
                "run", "-d", "--pull=never", "--name", name, "--init", "--cap-drop=ALL",
                "--security-opt=no-new-privileges:true",
                "--tmpfs", "/tmp:rw,nosuid,size=1g", "--shm-size=512m",
            ]
            if single_path:
                command.extend(["-v", root + ":/config"])
            else:
                command.extend(["-v", directory + ":/run/secrets:ro", "-v", volume + ":/data"])
            secret_path = "/config/secrets" if single_path else "/run/secrets"
            data_path = "/config/data" if single_path else "/data"
            environment = {
                "HELPER_ADMIN_ORIGIN": "http://127.0.0.1:8080",
                "HELPER_BROWSER_ORIGIN": "http://127.0.0.1:6080",
                "HELPER_PUBLIC_URL": "http://127.0.0.1:8081",
                "HELPER_API_KEY_FILE": secret_path + "/helper-api-key",
                "HELPER_STORAGE_KEY_FILE": secret_path + "/storage-key",
                "HELPER_ADMIN_PASSWORD_FILE": secret_path + "/admin-password",
                "HELPER_VNC_PASSWORD_FILE": secret_path + "/vnc-password",
                "SYNC_STORAGE_KEY_FILE": secret_path + "/sync-storage-key",
                "SYNC_REGISTRATION_DISABLED": "1",
                "ALLINONE_DATA_DIR": data_path,
            }
            for key, value in environment.items():
                command.extend(["-e", key + "=" + value])
            docker(*command, image, capture=True)
            created = True
            wait_healthy(name)
            docker("exec", name, "python", "-c",
                   "import urllib.request,urllib.error,pathlib;"
                   "r=urllib.request.urlopen('http://127.0.0.1:8082/app/');"
                   "assert r.status==200 and b'<html' in r.read();"
                   f"assert pathlib.Path('{data_path}/sync/crosspoint.db').is_file();"
                   f"pathlib.Path('{data_path}/bridge/smoke-marker').write_text('preserved')")
            docker("exec", name, "python", "-c",
                   "import urllib.request,urllib.error\n"
                   "for url in ['http://127.0.0.1:8080/','http://127.0.0.1:8081/api/status']:\n"
                   " try: urllib.request.urlopen(url)\n"
                   " except urllib.error.HTTPError as e: assert e.code==401\n"
                   " else: raise AssertionError('Unauthenticated service access')")
            docker("stop", "--time", "25", name, capture=True)
            exit_code = docker("inspect", "--format", "{{.State.ExitCode}}", name, capture=True).stdout.strip()
            if exit_code != "0":
                raise RuntimeError("Container did not stop gracefully: " + exit_code)
            docker("start", name, capture=True)
            wait_healthy(name)
            docker("exec", name, "python", "-c",
                   "from pathlib import Path;"
                   f"assert Path('{data_path}/bridge/smoke-marker').read_text()=='preserved';"
                   f"assert Path('{data_path}/sync/crosspoint.db').is_file()")
            print("PASS: combined bridge/browser/Sync health, authenticated endpoints, "
                  "Sync web app, graceful stop, restart and persistent data.")
        finally:
            if created:
                docker("rm", "-f", name, capture=True)
            if not single_path:
                docker("volume", "rm", volume, capture=True, check=False)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "crosspoint-tolino-bridge:dev",
         single_path="--single-path" in sys.argv[2:])
