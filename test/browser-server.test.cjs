"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./browser-server.cjs");

test("local sign-in simulator exchanges one-time fixture codes without contacting Thalia", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const origin = "http://127.0.0.1:" + server.address().port;
  const state = "123e4567-e89b-42d3-a456-426614174000";

  const invalidState = await fetch(origin + "/fixture/authorize?state=bad", { redirect: "manual" });
  assert.equal(invalidState.status, 400);

  const authorization = await fetch(origin + "/fixture/authorize?state=" + state, { redirect: "manual" });
  assert.equal(authorization.status, 302);
  const loginUrl = new URL(authorization.headers.get("location"), origin);
  assert.equal(loginUrl.pathname, "/fixture/login");
  assert.equal(loginUrl.searchParams.get("state"), state);

  const loginPage = await fetch(loginUrl);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /never requests or sends Thalia credentials/);

  const code = loginUrl.searchParams.get("code");
  const exchanged = await fetch(origin + "/fixture/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state })
  });
  assert.deepEqual(await exchanged.json(), {
    hardwareId: "fixture-hardware",
    refreshToken: "fixture-refresh"
  });

  const replay = await fetch(origin + "/fixture/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state })
  });
  assert.equal(replay.status, 400);
});
