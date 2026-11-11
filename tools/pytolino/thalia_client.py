"""Compatibility adjustments for Thalia's current contextual webshop login."""

import base64
import json
import math
import re
import time
from urllib.parse import urlencode, urlsplit

from pytolino import tolino_cloud
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import NoSuchElementException, StaleElementReferenceException
from selenium.webdriver.common.keys import Keys
from seleniumbase import SB


LOGIN_STAGES = {
    "browser": "Browser-Anmeldung",
    "authorization": "OAuth-Code aus der Weiterleitung",
    "token": "OAuth-Tokenaustausch",
    "hardware": "Tolino-Geraeteliste",
    "inventory": "Cloud-Bibliothek",
}


def session_text(value):
    return (isinstance(value, str) and 0 < len(value) <= 32768
            and not any(ord(char) <= 32 or ord(char) == 127 for char in value))


class WebreaderSession:
    token_url = "https://www.thalia.de/auth/oauth2/token"
    bosh_origin = "https://bosh.pageplace.de"
    api_origin = "https://api.pageplace.de"

    def __init__(self):
        self.requests = {}
        self.token_requests = set()
        self.authenticated = {}
        self.token = None

    def observe(self, driver):
        for entry in driver.get_log("performance"):
            message = json.loads(entry["message"])["message"]
            method, params = message["method"], message.get("params", {})
            request_id = params.get("requestId")
            if method == "Network.requestWillBeSent":
                request = params["request"]
                url = urlsplit(request["url"])
                if (f"{url.scheme}://{url.netloc}" == self.bosh_origin
                        and url.path in ("/bosh/rest/v2/registerhw", "/bosh/rest/registerhw",
                                         "/bosh/rest/inventory/delta")):
                    self.requests[request_id] = {
                        key.lower(): value for key, value in request.get("headers", {}).items()
                    }
                elif f"{url.scheme}://{url.netloc}" == self.api_origin:
                    device = re.fullmatch(
                        r"/v1/devices/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/userid",
                        url.path,
                    )
                    if device:
                        headers = {
                            key.lower(): value for key, value in request.get("headers", {}).items()
                        }
                        headers["hardware_id"] = device.group(1)
                        self.requests[request_id] = headers
            elif method == "Network.responseReceived":
                response = params["response"]
                if response["url"] == self.token_url:
                    if not 200 <= response["status"] < 300:
                        raise RuntimeError("The webreader token exchange was rejected.")
                    self.token_requests.add(request_id)
                elif request_id in self.requests:
                    headers = self.requests.pop(request_id)
                    if (200 <= response["status"] < 300
                            and all(session_text(headers.get(key)) for key in
                                    ("t_auth_token", "hardware_id", "reseller_id"))):
                        self.authenticated[headers["t_auth_token"]] = headers
            elif method == "Network.loadingFinished" and request_id in self.token_requests:
                body = driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": request_id})
                raw = base64.b64decode(body["body"]) if body.get("base64Encoded") else body["body"]
                token = json.loads(raw)
                if not all(session_text(token.get(key)) for key in ("access_token", "refresh_token")):
                    raise ValueError("The webreader did not return valid session tokens.")
                self.token = token
                self.token_requests.remove(request_id)
            elif method == "Network.loadingFailed":
                self.requests.pop(request_id, None)
                if request_id in self.token_requests:
                    raise RuntimeError("The webreader token response could not be loaded.")
        if self.token is not None:
            return self.authenticated.get(self.token["access_token"])
        return None


class ThaliaClient(tolino_cloud.Client):
    login_origin = "https://www.thalia.de"
    webreader_url = "https://webreader.mytolino.com/library/index.html"

    def _retrieve_last_token(self):
        # The helper owns encrypted persistence, never pytolino's legacy token files.
        return None

    def __init__(self, username):
        super().__init__(username=username, server_name="thalia")
        self.login_stage = "browser"
        self.browser_context = None
        self.browser_step = "Browser starten"
        self.on_browser_notice = lambda message: None
        parameters = {
            "client_id": tolino_cloud.client_id,
            "response_type": "code",
            "scope": tolino_cloud.scope,
            "redirect_uri": tolino_cloud.redirect_uri,
        }
        parameters.update(tolino_cloud.additional_request_parameters)
        # Direct login.do now yields an error page without authorization context.
        self._login_url = self._auth_url + "?" + urlencode(parameters)
        self._username_field_id = "username"
        self._password_field_id = "password"

    def export_session(self):
        return {key: getattr(self, "_" + key) for key in
                ("access_token", "refresh_token", "access_expiration_time", "refresh_expiration_time",
                 "hardware_id", "partner_id", "user_agent")}

    @classmethod
    def from_session(cls, value):
        if not isinstance(value, dict):
            raise ValueError("Invalid saved session.")
        for key in ("access_token", "refresh_token", "hardware_id", "partner_id"):
            if not session_text(value.get(key)):
                raise ValueError("Invalid saved session identity.")
        for key in ("access_expiration_time", "refresh_expiration_time"):
            number = value.get(key)
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) or number < 0:
                raise ValueError("Invalid saved session lifetime.")
        if value.get("user_agent") is not None and not isinstance(value["user_agent"], str):
            raise ValueError("Invalid saved user agent.")
        client = cls("restored-helper-session")
        for key in ("access_token", "refresh_token", "access_expiration_time", "refresh_expiration_time",
                    "hardware_id", "partner_id", "user_agent"):
            setattr(client, "_" + key, value.get(key))
        return client

    def update_token(self, data):
        if not isinstance(data, dict) or not session_text(data.get("access_token")):
            raise ValueError("Invalid access token.")
        refresh = data.get("refresh_token", self.refresh_token)
        if not session_text(refresh):
            raise ValueError("Invalid refresh token.")
        for key in ("expires_in", "refresh_expires_in"):
            value = data.get(key, 0)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError("Invalid token lifetime.")
        self._access_token = data["access_token"]
        self._refresh_token = refresh
        self._access_expiration_time = time.time() + data.get("expires_in", 0)
        self._refresh_expiration_time = time.time() + data["refresh_expires_in"] if data.get("refresh_expires_in") else 0

    @staticmethod
    def select_provider(driver):
        if not ThaliaClient.is_webreader_return(driver.current_url):
            return False
        selectors = (
            "//button[normalize-space(.)='Deutschland']",
            "//*[@data-test-id='ftu-resellerLogo-3']/ancestor::button[1]",
        )
        for selector in selectors:
            for element in driver.find_elements(By.XPATH, selector):
                if element.is_displayed() and element.is_enabled():
                    element.click()
                    return True
        return False

    def login(self, password, allow_GUI_autologin=True):
        if not allow_GUI_autologin:
            raise RuntimeError("This harness requires an interactive browser login.")
        self._get_login_cookies(password)

    def _get_login_cookies(self, password):
        self.login_stage = "browser"
        self.browser_context = SB(uc=True, headed=True, log_cdp_events=True)
        try:
            browser = self.browser_context.__enter__()
            driver = browser.driver
            driver.set_page_load_timeout(45)
            driver.execute_cdp_cmd("Network.enable", {})
            observed = WebreaderSession()
            self.browser_step = "Login-Seite laden"
            driver.get(self.webreader_url)
            wait = WebDriverWait(driver, 180, poll_frequency=0.2)
            self.browser_step = "Webreader-Sitzung und authentifizierte Geraete-ID abwarten"
            self.on_browser_notice(
                "Deutschland und Thalia.de werden automatisch ausgewaehlt. "
                "Bei Cookies oder Sicherheitsabfragen bitte im Browser bestaetigen."
            )
            stable_since = None
            reloaded = False
            submitted = False

            def completed(current):
                nonlocal stable_since, reloaded, submitted
                matched = observed.observe(current)
                if matched:
                    return matched
                try:
                    if self.select_provider(current):
                        stable_since = None
                        return False
                    if not submitted and self.is_webreader_return(current.current_url):
                        for button in current.find_elements(By.CSS_SELECTOR, '[data-test-id="library-drawer-buttonLogin"]'):
                            if button.is_displayed() and button.is_enabled():
                                button.click()
                                return False
                    location = urlsplit(current.current_url)
                    if (not submitted and f"{location.scheme}://{location.netloc}" == self.login_origin):
                        usernames = current.find_elements(By.NAME, "username")
                        passwords = current.find_elements(By.NAME, "password")
                        if usernames and passwords and usernames[0].is_displayed() and passwords[0].is_displayed():
                            usernames[0].clear()
                            usernames[0].send_keys(self._username)
                            passwords[0].send_keys(password)
                            passwords[0].send_keys(Keys.RETURN)
                            submitted = True
                except (NoSuchElementException, StaleElementReferenceException):
                    return False
                if self.is_webreader_return(current.current_url):
                    if stable_since is None:
                        stable_since = time.monotonic()
                    elif not reloaded and time.monotonic() - stable_since >= 10:
                        self.on_browser_notice(
                            "Webreader angemeldet. Sitzung wird durch einmaliges Neuladen uebernommen."
                        )
                        reloaded = True
                        current.refresh()
                else:
                    stable_since = None
                return False

            headers = wait.until(completed)
            token = observed.token
            self.update_token(token)
            self._hardware_id = headers["hardware_id"]
            self._partner_id = headers["reseller_id"]
            self._user_agent = driver.execute_script("return navigator.userAgent")
        except Exception:
            self.on_browser_notice("Browser bleibt zur Diagnose geoeffnet.")
            raise
        else:
            self.close_browser()

    def close_browser(self):
        context = self.browser_context
        self.browser_context = None
        if context is not None:
            context.__exit__(None, None, None)

    @staticmethod
    def is_webreader_return(url):
        parsed = urlsplit(url)
        return (parsed.scheme == "https"
                and parsed.hostname == "webreader.mytolino.com"
                and parsed.path in ("/library", "/library/", "/library/index.html"))

    def _get_auth_code(self):
        self.login_stage = "authorization"
        return super()._get_auth_code()

    def _get_token(self, auth_code):
        self.login_stage = "token"
        return super()._get_token(auth_code)

    def _get_hardware_id(self):
        self.login_stage = "hardware"
        return super()._get_hardware_id()

    def get_inventory(self):
        self.login_stage = "inventory"
        return super().get_inventory()
