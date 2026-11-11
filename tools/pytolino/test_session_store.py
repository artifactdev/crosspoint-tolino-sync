import base64
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

from cryptography.fernet import Fernet

from companion import APIError, Companion
from login_server import LoginState, create_server
from session_store import SessionStore
from thalia_client import ThaliaClient


def session_client():
    client = ThaliaClient("synthetic-login")
    client.update_token({"access_token": "synthetic-access", "refresh_token": "synthetic-refresh",
                         "expires_in": 3600, "refresh_expires_in": 7200})
    client._hardware_id = "synthetic-device"
    client._partner_id = "3"
    client._user_agent = "synthetic-agent"
    return client


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.key = self.root / "key"
        self.key.write_bytes(Fernet.generate_key())
        self.store = SessionStore(self.root / "data", self.key)

    def state(self):
        state = LoginState(self.store)
        state.client = session_client()
        state.companion = Companion(state, on_token_update=state.persist, on_expired=state.expired)
        return state

    def test_encrypted_roundtrip_and_private_atomic_file(self):
        self.assertEqual(self.store.load(), {"session": None, "credentials": None})
        session = session_client().export_session()
        credentials = {"username": "synthetic@example.invalid", "password": "synthetic-password"}
        self.store.save(session, credentials)
        for secret in ("synthetic-access", "synthetic-refresh", "synthetic-password", "synthetic@example.invalid"):
            self.assertNotIn(secret.encode(), self.store.path.read_bytes())
        self.assertEqual(self.store.load(), {"session": session, "credentials": credentials})
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.store.directory.glob(".session-*")))
        self.store.clear()
        self.assertEqual(self.store.load(), {"session": None, "credentials": None})

    def test_wrong_key_and_corruption_are_explicit_and_never_overwrite_data(self):
        self.store.save(session_client().export_session(), None)
        original = self.store.path.read_bytes()
        self.key.write_bytes(Fernet.generate_key())
        wrong_key_store = SessionStore(self.store.directory, self.key)
        with self.assertRaisesRegex(ValueError, "cannot be decrypted"):
            wrong_key_store.load()
        self.assertEqual(self.store.path.read_bytes(), original)
        self.store.path.write_bytes(b"invalid")
        with self.assertRaises(ValueError):
            self.store.load()

    def test_restore_session_without_browser_and_inventory_validation(self):
        previous = self.state()
        previous.persist(previous.client)
        restored = LoginState(self.store)
        restored.companion = Companion(restored, on_token_update=restored.persist, on_expired=restored.expired)
        inventory = {"PublicationInventory": {"ebook": [{"epubMetaData": {"title": "Synthetic book"}}], "edata": []}}
        with patch.object(restored.companion, "remote", return_value=inventory), \
                patch.object(ThaliaClient, "login") as browser:
            restored.restore()
            deadline = time.monotonic() + 5
            while restored.snapshot()["busy"] and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(restored.snapshot()["busy"])
            self.assertTrue(restored.snapshot()["connected"])
            self.assertEqual(restored.snapshot()["books"], ["Synthetic book"])
            browser.assert_not_called()
        self.assertFalse(restored.snapshot()["credentialsSaved"])
        self.assertEqual(restored.client.hardware_id, "synthetic-device")

    def test_saved_session_can_be_decrypted_and_restored_in_a_new_process(self):
        state = self.state()
        state.persist(state.client)
        code = ("import sys; from session_store import SessionStore; from thalia_client import ThaliaClient; "
                "value=SessionStore(sys.argv[1],sys.argv[2]).load(); client=ThaliaClient.from_session(value['session']); "
                "assert client.access_token=='synthetic-access'; assert client.hardware_id=='synthetic-device'; "
                "assert value['credentials'] is None; print('restored')")
        result = subprocess.run([sys.executable, "-c", code, str(self.store.directory), str(self.key)],
                                check=True, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.stdout.strip(), "restored")

    def test_refresh_rotates_and_persists_before_success_and_retains_omitted_refresh_token(self):
        state = self.state()
        response = Mock(status_code=200)
        response.json.return_value = {"access_token": "rotated-access", "refresh_token": "rotated-refresh", "expires_in": 1200}
        with patch("companion.requests.post", return_value=response):
            state.companion.refresh(state.client)
        self.assertEqual(self.store.load()["session"]["refresh_token"], "rotated-refresh")
        self.assertEqual(state.client.access_token, "rotated-access")
        response.json.return_value = {"access_token": "next-access", "expires_in": 1200}
        with patch("companion.requests.post", return_value=response):
            state.companion.refresh(state.client)
        self.assertEqual(self.store.load()["session"]["refresh_token"], "rotated-refresh")

    def test_failed_persistence_is_not_success_after_rotation(self):
        state = self.state()
        response = Mock(status_code=200)
        response.json.return_value = {"access_token": "rotated-access", "refresh_token": "rotated-refresh", "expires_in": 1200}
        with patch("companion.requests.post", return_value=response), \
                patch.object(self.store, "save", side_effect=OSError("synthetic disk error")):
            with self.assertRaises(APIError) as error:
                state.companion.refresh(state.client)
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(state.client.refresh_token, "rotated-refresh")
        self.assertIsNotNone(state.persistence_error)

    def test_revocation_without_credentials_disconnects_and_does_not_log_in(self):
        state = self.state()
        with patch("companion.requests.post", return_value=Mock(status_code=400)), \
                patch.object(ThaliaClient, "login") as browser:
            with self.assertRaises(APIError):
                state.companion.refresh(state.client)
            state.expired()
            browser.assert_not_called()
        self.assertFalse(state.snapshot()["connected"])
        self.assertIn("kein Passwort", state.snapshot()["message"])

    def test_reauthentication_is_bounded_and_only_uses_opted_in_credentials(self):
        state = self.state()
        state.credentials = {"username": "synthetic@example.invalid", "password": "synthetic-password"}
        with patch("login_server.threading.Thread") as thread:
            state.expired()
            state.expired()
            self.assertEqual(thread.call_count, 1)
            self.assertTrue(state.relogin_attempted)
        snapshot = state.snapshot()
        self.assertNotIn("synthetic-password", str(snapshot))
        self.assertNotIn("synthetic-refresh", str(snapshot))

    def test_password_is_saved_only_after_successful_explicit_opt_in(self):
        state = self.state()
        client = state.client
        client.login = Mock()
        client.get_inventory = Mock(return_value=[])
        for remember in (False, True):
            with patch("login_server.threading.Thread"):
                state.begin("synthetic@example.invalid", "synthetic-password", remember)
            with patch("thalia_client.ThaliaClient", return_value=client):
                state.run("synthetic@example.invalid", "synthetic-password")
            stored = self.store.load()
            self.assertEqual(stored["credentials"] is not None, remember)
            self.assertTrue(state.snapshot()["sessionSaved"])
            if remember:
                self.assertEqual(stored["credentials"]["password"], "synthetic-password")
            self.assertNotIn("synthetic-password", str(state.snapshot()))

    def test_failed_automatic_password_login_is_not_repeated(self):
        state = self.state()
        state.credentials = {"username": "synthetic@example.invalid", "password": "synthetic-password"}
        state.persist(state.client)
        client = Mock()
        client.login.side_effect = RuntimeError("sensitive provider body")
        with patch("login_server.threading.Thread") as thread, \
                patch("thalia_client.ThaliaClient", return_value=client):
            state.expired()
            thread.call_args.kwargs["target"]()
            state.expired()
            self.assertEqual(thread.call_count, 1)
        self.assertFalse(state.snapshot()["connected"])
        client.login.assert_called_once_with("synthetic-password")
        self.assertNotIn("sensitive provider", state.snapshot()["message"])

    def test_forget_cancels_a_queued_automatic_login(self):
        state = self.state()
        state.credentials = {"username": "synthetic@example.invalid", "password": "synthetic-password"}
        with patch("login_server.threading.Thread") as thread, patch.object(state, "run") as run:
            state.expired()
            queued_login = thread.call_args.kwargs["target"]
            state.forget()
            queued_login()
            run.assert_not_called()

    def test_temporary_inventory_outage_keeps_restored_tokens_for_retry(self):
        state = self.state()
        previous = state.client
        with patch.object(state.companion, "remote", side_effect=APIError(502, "Provider temporarily unavailable.")):
            state.run(None, None)
        self.assertIs(state.client, previous)
        self.assertIn("temporarily unavailable", state.snapshot()["message"])
        self.assertFalse(state.snapshot()["busy"])

    def test_failed_new_account_cannot_restore_previous_account_or_password(self):
        state = self.state()
        state.credentials = {"username": "old@example.invalid", "password": "old-password"}
        state.persist(state.client)
        with patch("login_server.threading.Thread"):
            self.assertTrue(state.begin("new@example.invalid", "new-password", False))
        self.assertEqual(self.store.load(), {"session": None, "credentials": None})
        self.assertIsNone(state.credentials)
        self.assertFalse(state.saved)

    def test_account_switch_waits_for_inflight_token_persistence(self):
        state = self.state()
        state.credentials = {"username": "old@example.invalid", "password": "old-password"}
        started = threading.Event()
        finished = threading.Event()

        def switch_account():
            started.set()
            state.begin("new@example.invalid", "new-password", True)
            finished.set()

        with patch.object(state, "run"):
            with state.companion.lock:
                worker = threading.Thread(target=switch_account)
                worker.start()
                self.assertTrue(started.wait(1))
                self.assertFalse(finished.wait(0.05))
                state.persist(state.client)
                self.assertEqual(self.store.load()["credentials"]["username"], "old@example.invalid")
            worker.join(timeout=2)
            self.assertTrue(finished.is_set())
        self.assertEqual(self.store.load(), {"session": None, "credentials": None})

    def test_forget_clears_session_and_saved_credentials(self):
        state = self.state()
        state.credentials = {"username": "synthetic@example.invalid", "password": "synthetic-password"}
        state.persist(state.client)
        state.forget()
        self.assertFalse(state.snapshot()["connected"])
        self.assertFalse(state.snapshot()["credentialsSaved"])
        self.assertEqual(self.store.load(), {"session": None, "credentials": None})

    def test_expiring_token_is_refreshed_in_maintenance(self):
        state = self.state()
        state.client._access_expiration_time = time.time() + 90
        stop = Mock()
        stop.wait.side_effect = [False, True]
        with patch.object(state.companion, "refresh") as refresh:
            state.maintain(stop)
        refresh.assert_called_once_with(state.client)

    def test_lan_admin_requires_basic_auth_and_exact_host_origin(self):
        admin_secret = self.root / "admin-password"
        admin_secret.write_text("synthetic-admin-password-012345")
        environment = {"HELPER_ADMIN_ORIGIN": "http://unraid.test:8080",
                       "HELPER_BROWSER_ORIGIN": "http://unraid.test:6080",
                       "HELPER_ADMIN_PASSWORD_FILE": str(admin_secret),
                       "HELPER_VNC_PASSWORD_FILE": str(self.root / "vnc-password")}
        with patch.dict(os.environ, environment), create_server(0) as server:
            worker = threading.Thread(target=server.serve_forever)
            worker.start()
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
            try:
                headers = {"Host": "unraid.test:8080"}
                connection.request("GET", "/", headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 401)
                self.assertIn("Basic", response.getheader("WWW-Authenticate"))
                response.read()
                headers["Authorization"] = "Basic " + base64.b64encode(b"admin:synthetic-admin-password-012345").decode()
                connection.request("GET", "/", headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                headers["Cookie"] = response.getheader("Set-Cookie").split(";")[0]
                response.read()
                connection.request("GET", "/connection", headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertTrue(json.loads(response.read())["browserUrl"].startswith("http://unraid.test:6080/"))
                headers.update({"Origin": "http://evil.test", "Content-Type": "application/json"})
                connection.request("POST", "/forget", "{}", headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                headers["Origin"] = "http://unraid.test:8080"
                connection.request("POST", "/forget", "{}", headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
            finally:
                connection.close()
                server.shutdown()
                worker.join()
        with patch.dict(os.environ, {"HELPER_ADMIN_ORIGIN": "http://unraid.test:8080"}):
            with self.assertRaises(ValueError):
                create_server(0)

    def test_explicit_passwordless_admin_keeps_host_and_origin_checks(self):
        environment = {"ALLINONE_DISABLE_WEB_AUTH": "1",
                       "HELPER_ADMIN_ORIGIN": "http://unraid.test:8080",
                       "HELPER_BROWSER_ORIGIN": "http://unraid.test:6080",
                       "HELPER_ADMIN_PASSWORD_FILE": "/nonexistent-password",
                       "HELPER_VNC_PASSWORD_FILE": "/nonexistent-vnc-password"}
        with patch.dict(os.environ, environment), create_server(0) as server:
            worker = threading.Thread(target=server.serve_forever)
            worker.start()
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
            try:
                headers = {"Host": "unraid.test:8080"}
                connection.request("GET", "/", headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                headers["Cookie"] = response.getheader("Set-Cookie").split(";")[0]
                response.read()
                connection.request("GET", "/", headers={"Host": "evil.test"})
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                headers.update({"Origin": "http://evil.test", "Content-Type": "application/json"})
                connection.request("POST", "/forget", "{}", headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                headers["Origin"] = "http://unraid.test:8080"
                connection.request("POST", "/forget", "{}", headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
            finally:
                connection.close()
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    unittest.main()
