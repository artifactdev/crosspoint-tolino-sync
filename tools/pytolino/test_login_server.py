import http.client
import json
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from login_server import LoginState, create_server, failure_message, titles
from companion import APIError


class LoginTests(unittest.TestCase):
    def test_password_login_automatically_loads_library(self):
        state = LoginState()
        client = Mock(access_token="synthetic-access")
        client.get_inventory.return_value = [{"epubMetaData": {"title": "Synthetic book"}}]
        with patch("thalia_client.ThaliaClient", return_value=client) as factory:
            state.run("synthetic@example.invalid", "synthetic-password")
        factory.assert_called_once_with(username="synthetic@example.invalid")
        client.login.assert_called_once_with("synthetic-password")
        client.import_token.assert_not_called()
        client.get_inventory.assert_called_once_with()
        snapshot = state.snapshot()
        self.assertTrue(snapshot["connected"])
        self.assertEqual(snapshot["books"], ["Synthetic book"])
        self.assertNotIn("synthetic-password", str(snapshot))
        self.assertNotIn("synthetic-access", str(snapshot))

    def test_failure_clears_previous_library_and_redacts_upstream_error(self):
        state = LoginState()
        state.books = ["Old account"]
        client = Mock()
        client.login.side_effect = RuntimeError("secret-password-provider-response")
        with patch("thalia_client.ThaliaClient", return_value=client):
            state.run("synthetic@example.invalid", "synthetic-password")
        snapshot = state.snapshot()
        self.assertFalse(snapshot["connected"])
        self.assertFalse(snapshot["busy"])
        self.assertEqual(snapshot["books"], [])
        self.assertIn("RuntimeError", snapshot["message"])
        self.assertNotIn("secret-password", snapshot["message"])
        client.get_inventory.assert_not_called()

    def test_invalid_inventory_is_not_success(self):
        for inventory in ({}, [None], [{"epubMetaData": {}}]):
            with self.assertRaises(ValueError):
                titles(inventory)

    def test_thalia_login_has_authorization_context_and_current_field_names(self):
        from thalia_client import ThaliaClient
        client = ThaliaClient("synthetic-login-config")
        url = urlsplit(client._login_url)
        self.assertEqual(url.hostname, "www.thalia.de")
        self.assertEqual(url.path, "/de.thalia.ecp.authservice.application/oauth2/authorize")
        params = parse_qs(url.query)
        self.assertEqual(params["client_id"], ["webreader"])
        self.assertEqual(params["response_type"], ["code"])
        self.assertEqual(params["redirect_uri"], ["https://webreader.mytolino.com/library/"])
        self.assertEqual(client._username_field_id, "username")
        self.assertEqual(client._password_field_id, "password")

    def test_browser_waits_for_matched_session_without_second_oauth_exchange(self):
        from thalia_client import ThaliaClient
        client = ThaliaClient("synthetic-login")
        client._session = Mock()
        client._session_cffi = Mock()
        driver = Mock(current_url="https://webreader.mytolino.com/library/")
        events = []
        wait = Mock()

        def until(predicate):
            events.append("wait")
            return predicate(driver)

        wait.until.side_effect = until
        with patch("thalia_client.SB") as browser, patch("thalia_client.WebDriverWait", return_value=wait), \
                patch("thalia_client.WebreaderSession") as observed:
            observed.return_value.token = {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}
            observed.return_value.observe.return_value = {"hardware_id": "synthetic-hardware", "reseller_id": "3"}
            browser.return_value.__enter__.return_value.driver = driver
            with patch.object(client, "_get_auth_code") as auth_code:
                client.login("synthetic-password")
            auth_code.assert_not_called()
        self.assertEqual(events, ["wait"])
        self.assertEqual(client.access_token, "synthetic-access")
        self.assertEqual(client.hardware_id, "synthetic-hardware")
        self.assertEqual(client._partner_id, "3")
        driver.execute_cdp_cmd.assert_called_once_with("Network.enable", {})

    def test_network_observer_requires_matching_successful_hardware_response(self):
        from thalia_client import WebreaderSession
        observer = WebreaderSession()
        driver = Mock()

        def event(method, **params):
            return {"message": json.dumps({"message": {"method": method, "params": params}})}

        driver.get_log.return_value = [
            event("Network.responseReceived", requestId="token", response={
                "url": observer.token_url, "status": 200}),
            event("Network.loadingFinished", requestId="token"),
            event("Network.requestWillBeSent", requestId="hardware", request={
                "url": observer.bosh_origin + "/bosh/rest/inventory/delta",
                "headers": {"t_auth_token": "different-access", "hardware_id": "synthetic-hardware", "reseller_id": "3"}}),
            event("Network.responseReceived", requestId="hardware", response={
                "url": observer.bosh_origin + "/bosh/rest/inventory/delta", "status": 200}),
        ]
        driver.execute_cdp_cmd.return_value = {"body": json.dumps({
            "access_token": "synthetic-access", "refresh_token": "synthetic-refresh",
        })}
        self.assertIsNone(observer.observe(driver))
        request = event("Network.requestWillBeSent", requestId="matched", request={
            "url": observer.bosh_origin + "/bosh/rest/inventory/delta",
            "headers": {"t_auth_token": "synthetic-access", "hardware_id": "matched-hardware", "reseller_id": "3"}})
        driver.get_log.return_value = [request, event("Network.responseReceived", requestId="matched",
            response={"url": observer.bosh_origin + "/bosh/rest/inventory/delta", "status": 403})]
        self.assertIsNone(observer.observe(driver))
        driver.get_log.return_value = [request, event("Network.responseReceived", requestId="matched",
            response={"url": observer.bosh_origin + "/bosh/rest/inventory/delta", "status": 200})]
        self.assertEqual(observer.observe(driver)["hardware_id"], "matched-hardware")

    def test_network_observer_rejects_bad_token_body(self):
        from thalia_client import WebreaderSession
        observer = WebreaderSession()
        driver = Mock()
        driver.get_log.return_value = [
            {"message": json.dumps({"message": {"method": "Network.responseReceived", "params": {
                "requestId": "token", "response": {"url": observer.token_url, "status": 200}}}})},
            {"message": json.dumps({"message": {"method": "Network.loadingFinished", "params": {"requestId": "token"}}})},
        ]
        driver.execute_cdp_cmd.return_value = {"body": '{"error":"synthetic"}'}
        with self.assertRaises(ValueError):
            observer.observe(driver)

    def test_modern_webreader_device_endpoint_requires_exact_origin_and_success(self):
        from thalia_client import WebreaderSession
        observer = WebreaderSession()
        observer.token = {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}
        hardware = "12345678-1234-1234-1234-123456789abc"
        driver = Mock()

        def events(origin, status, token="synthetic-access"):
            url = origin + "/v1/devices/" + hardware + "/userid"
            return [{"message": json.dumps({"message": {"method": method, "params": params}})}
                    for method, params in [
                        ("Network.requestWillBeSent", {"requestId": "modern", "request": {
                            "url": url, "headers": {"T_AUTH_TOKEN": token, "reseller_id": "3"}}}),
                        ("Network.responseReceived", {"requestId": "modern", "response": {
                            "url": url, "status": status}}),
                    ]]

        for origin, status, token in (
            ("https://api.pageplace.de.evil.invalid", 200, "synthetic-access"),
            ("http://api.pageplace.de", 200, "synthetic-access"),
            ("https://api.pageplace.de", 403, "synthetic-access"),
            ("https://api.pageplace.de", 200, "different-access"),
        ):
            driver.get_log.return_value = events(origin, status, token)
            self.assertIsNone(observer.observe(driver))
        driver.get_log.return_value = events("https://api.pageplace.de", 200)
        self.assertEqual(observer.observe(driver)["hardware_id"], hardware)
        self.assertEqual(observer.observe(driver)["reseller_id"], "3")

    def test_browser_is_retained_on_navigation_failure_and_can_be_closed(self):
        from thalia_client import ThaliaClient
        client = ThaliaClient("synthetic-browser-error")
        with patch("thalia_client.SB") as browser:
            context = browser.return_value
            context.__enter__.return_value.driver.get.side_effect = RuntimeError("synthetic failure")
            with self.assertRaises(RuntimeError):
                client._get_login_cookies("synthetic-password")
            context.__exit__.assert_not_called()
            client.close_browser()
            context.__exit__.assert_called_once_with(None, None, None)

    def test_signed_in_webreader_is_reloaded_only_once_until_session_matches(self):
        from thalia_client import ThaliaClient
        client = ThaliaClient("synthetic-one-reload")
        driver = Mock(current_url="https://webreader.mytolino.com/library/index.html")
        driver.find_elements.return_value = []
        wait = Mock()
        calls = 0

        def until(predicate):
            nonlocal calls
            calls += 1
            self.assertFalse(predicate(driver))
            self.assertFalse(predicate(driver))
            self.assertFalse(predicate(driver))
            return predicate(driver)

        wait.until.side_effect = until
        with patch("thalia_client.SB") as browser, patch("thalia_client.WebDriverWait", return_value=wait), \
                patch("thalia_client.time.monotonic", side_effect=[0, 11, 12]), \
                patch("thalia_client.WebreaderSession") as observed:
            observed.return_value.token = {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"}
            observed.return_value.observe.side_effect = [None, None, None, {
                "hardware_id": "synthetic-hardware", "reseller_id": "3"}]
            browser.return_value.__enter__.return_value.driver = driver
            client.login("synthetic-password")
        driver.refresh.assert_called_once_with()

    def test_provider_selection_is_exact_visible_and_official_origin_only(self):
        from thalia_client import ThaliaClient
        driver = Mock(current_url="https://webreader.mytolino.com/library/index.html")
        country = Mock()
        country.is_displayed.return_value = country.is_enabled.return_value = True
        driver.find_elements.side_effect = [[country]]
        self.assertTrue(ThaliaClient.select_provider(driver))
        country.click.assert_called_once_with()
        self.assertIn("Deutschland", driver.find_elements.call_args.args[1])
        driver.find_elements.side_effect = [[], [country]]
        self.assertTrue(ThaliaClient.select_provider(driver))
        self.assertIn("ftu-resellerLogo-3", driver.find_elements.call_args.args[1])
        driver.current_url = "https://webreader.mytolino.com.evil.invalid/library/"
        driver.find_elements.reset_mock()
        self.assertFalse(ThaliaClient.select_provider(driver))
        driver.find_elements.assert_not_called()

    def test_browser_never_accepts_foreign_or_unfinished_return(self):
        from thalia_client import ThaliaClient
        for url in (
            "https://www.thalia.de/login", "https://webreader.mytolino.com.evil.invalid/library/",
            "http://webreader.mytolino.com/library/", "https://webreader.mytolino.com/login/",
        ):
            self.assertFalse(ThaliaClient.is_webreader_return(url))
        self.assertTrue(ThaliaClient.is_webreader_return("https://webreader.mytolino.com/library/?code=synthetic"))
        self.assertTrue(ThaliaClient.is_webreader_return("https://webreader.mytolino.com/library/index.html#/library"))
        self.assertFalse(ThaliaClient.is_webreader_return("https://webreader.mytolino.com.evil.invalid/library/index.html"))

    def test_keyerror_reports_only_allowlisted_stage_not_missing_key(self):
        for stage, label in (("authorization", "OAuth-Code"), ("hardware", "Geraeteliste")):
            client = Mock(login_stage=stage)
            message = failure_message(KeyError("secret-provider-field"), client)
            self.assertIn(label, message)
            self.assertNotIn("secret-provider-field", message)

    def test_reload_does_not_repeat_password_login(self):
        state = LoginState()
        state.client = Mock(access_token="synthetic-access")
        state.client.get_inventory.return_value = []
        state.run(None, None)
        state.client.login.assert_not_called()
        self.assertTrue(state.snapshot()["connected"])

    def test_http_pairing_origin_and_host_protection(self):
        with create_server(0) as server:
            worker = threading.Thread(target=server.serve_forever)
            worker.start()
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
            try:
                connection.request("GET", "/")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                cookie = response.getheader("Set-Cookie").split(";")[0]
                response.read()
                connection.request("GET", "/status")
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                connection.request("GET", "/status", headers={"Cookie": cookie})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertFalse(json.loads(response.read())["connected"])
                body = json.dumps({"username": "test@example.invalid", "password": "synthetic"})
                headers = {"Cookie": cookie, "Content-Type": "application/json", "Origin": "https://evil.invalid"}
                connection.request("POST", "/login", body, headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                headers["Origin"] = f"http://127.0.0.1:{server.server_port}"
                with patch.object(server.companion, "reading_progress", return_value={"positions": {}, "fetchedAt": 1000}) as reading:
                    connection.request("POST", "/reading-progress", "{}", headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read()), {"positions": {}, "fetchedAt": 1000})
                    reading.assert_called_once_with()
                    connection.request("POST", "/reading-progress", '{"patches":[]}', headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 400)
                    response.read()
                    self.assertEqual(reading.call_count, 1)
                    connection.request("POST", "/reading-progress", "{}", {**headers, "Origin": "https://evil.invalid"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 403)
                    response.read()
                    self.assertEqual(reading.call_count, 1)
                with patch.object(server.companion, "reading_progress", side_effect=APIError(409, "Sign in first.")):
                    connection.request("POST", "/reading-progress", "{}", headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 409)
                    self.assertEqual(json.loads(response.read())["error"], "Sign in first.")
                with patch.object(server.state, "begin", return_value=True) as begin:
                    connection.request("POST", "/login", body, headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 202)
                    response.read()
                    begin.assert_called_once_with("test@example.invalid", "synthetic")
                connection.request("GET", "/", headers={"Host": "evil.invalid"})
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
            finally:
                connection.close()
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    unittest.main()
