"""Run an isolated Docker integration test without provider login or real data."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


REMOVE_TEST_DATA = (
    "from pathlib import Path;import shutil;"
    "data=Path('/cleanup/data');"
    "shutil.rmtree(data) if data.exists() else None"
)


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


def main(image, single_path=False, passwordless=False):
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
            if passwordless:
                environment.update({
                    "ALLINONE_DISABLE_WEB_AUTH": "1",
                    "SYNC_WEB_AUTH_USER": "smoke-reader",
                    "SYNC_WEB_AUTH_ORIGIN": "http://sync.test:8082",
                    "SYNC_REGISTRATION_DISABLED": "0",
                })
                environment.pop("HELPER_ADMIN_PASSWORD_FILE")
                environment.pop("HELPER_VNC_PASSWORD_FILE")
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
            protected = ["http://127.0.0.1:8081/api/status"]
            if not passwordless:
                protected.append("http://127.0.0.1:8080/")
            docker("exec", name, "python", "-c",
                   "import urllib.request,urllib.error\n"
                   f"for url in {protected!r}:\n"
                   " try: urllib.request.urlopen(url)\n"
                   " except urllib.error.HTTPError as e: assert e.code==401\n"
                   " else: raise AssertionError('Unauthenticated service access')")
            docker("exec", name, "python", "-c",
                   "import socket\n"
                   "with socket.create_connection(('127.0.0.1',5900)) as s:\n"
                   " s.settimeout(3)\n"
                   " def read(n):\n"
                   "  data=b''\n"
                   "  while len(data)<n:\n"
                   "   part=s.recv(n-len(data))\n"
                   "   assert part, 'VNC handshake closed'\n"
                   "   data+=part\n"
                   "  return data\n"
                   " assert read(12).startswith(b'RFB ')\n"
                   " s.sendall(b'RFB 003.008\\n')\n"
                   " types=read(read(1)[0])\n"
                   f" assert (1 in types)=={passwordless!r}, types\n")
            if passwordless:
                docker("exec", name, "python", "-c",
                       "import json,urllib.request,urllib.error,hashlib\n"
                       "assert urllib.request.urlopen('http://127.0.0.1:8080/').status==200\n"
                       "base='http://127.0.0.1:8082'\n"
                       "body=json.dumps({'username':'smoke-reader','password':hashlib.md5(b'synthetic-password').hexdigest()}).encode()\n"
                       "r=urllib.request.urlopen(urllib.request.Request(base+'/users/create',data=body,headers={'Content-Type':'application/json'}))\n"
                       "assert r.status==201\n"
                       "headers={'x-crosspoint-web':'1','Host':'sync.test:8082'}\n"
                       "r=urllib.request.urlopen(urllib.request.Request(base+'/auth/web-access',headers=headers))\n"
                       "assert json.load(r)=={'enabled':True,'username':'smoke-reader'}\n"
                       "assert urllib.request.urlopen(urllib.request.Request(base+'/api/v1/connectors',headers=headers)).status==200\n"
                       "for path,extra,expected in [('/users/auth',{},401),('/api/v1/connectors',{},401),"
                       "('/api/v1/connectors',dict(headers,Origin='http://evil.test'),403)]:\n"
                       " try: urllib.request.urlopen(urllib.request.Request(base+path,headers=extra))\n"
                       " except urllib.error.HTTPError as e: assert e.code==expected\n"
                       " else: raise AssertionError('Access boundary bypassed')\n")
                docker("exec", name, "python", "-c",
                       "from selenium import webdriver\n"
                       "from selenium.webdriver.chrome.service import Service\n"
                       "from selenium.webdriver.common.by import By\n"
                       "from selenium.webdriver.support.ui import WebDriverWait\n"
                       "options=webdriver.ChromeOptions()\n"
                       "for arg in ['--headless=new','--no-sandbox','--disable-dev-shm-usage',"
                       "'--no-proxy-server','--host-resolver-rules=MAP sync.test 127.0.0.1']:\n"
                       " options.add_argument(arg)\n"
                       "options.binary_location='/usr/bin/chromium'\n"
                       "driver=webdriver.Chrome(service=Service('/usr/bin/chromedriver'),options=options)\n"
                       "try:\n"
                       " driver.get('http://sync.test:8082/app/')\n"
                       " WebDriverWait(driver,30).until(lambda d: 'Web login is disabled' in d.find_element(By.TAG_NAME,'body').text)\n"
                       " assert not driver.find_elements(By.XPATH,\"//h2[text()='Sign in']\")\n"
                       " assert driver.execute_script('return window.isSecureContext') is False\n"
                       "finally: driver.quit()\n")
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
                  "Sync web app, VNC auth policy, graceful stop, restart and persistent data."
                  + (" Passwordless web access and API isolation verified." if passwordless else ""))
        finally:
            if created:
                docker("rm", "-f", name, capture=True)
            if single_path:
                # Remove private UID-65534 directories as their owner before
                # the Linux runner cleans up its own TemporaryDirectory.
                docker("run", "--rm", "--pull=never", "--network=none",
                       "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                       "-v", root + ":/cleanup", "--entrypoint", "python",
                       image, "-c", REMOVE_TEST_DATA)
            else:
                docker("volume", "rm", volume, capture=True, check=False)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "crosspoint-tolino-bridge:dev",
         single_path="--single-path" in sys.argv[2:],
         passwordless="--passwordless" in sys.argv[2:])
