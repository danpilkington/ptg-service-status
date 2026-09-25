"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const attach = require("../admin-api");
test("individual users persist, enforce permissions and revoke sessions", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ptg-users-"));
    const statusFile = path.join(dir, "status.json");
    await fs.writeFile(statusFile, JSON.stringify({ services: [], incidents: [], maintenance: [] }));
    const key = "bootstrap-test-key-at-least-24-characters";
    const app = express(); app.use(express.json()); attach(app, { statusFile, key });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        for (const file of ["status.json", "users.json"]) await fs.unlink(path.join(dir, file));
        await fs.rmdir(dir);
    });
    const base = "http://127.0.0.1:" + server.address().port + "/api/admin/";
    const send = (route, method = "GET", body, token = key, headers = {}) => fetch(base + route, {
        method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const account = { username: "dan", password: "a-long-test-password", firstName: "Dan", lastName: "Test", jobTitle: "IT manager", role: "admin", active: true };
    assert.equal((await send("users", "GET", null, "")).status, 401);
    assert.equal((await send("users", "POST", account, key, { Origin: "https://attacker.example" })).status, 403);
    assert.equal((await send("users", "POST", { ...account, password: "short" })).status, 400);
    const created = await send("users", "POST", account); assert.equal(created.status, 201);
    const admin = (await created.json()).user;
    assert.equal(admin.passwordHash, undefined);
    assert.equal((await send("users", "POST", { ...account, username: "DAN" })).status, 409);
    const disk = await fs.readFile(path.join(dir, "users.json"), "utf8");
    assert.ok(!disk.includes(account.password)); assert.ok(JSON.parse(disk)[0].passwordHash);
    assert.equal((await send("login", "POST", { username: "dan", password: "wrong" }, "")).status, 401);
    const login = async (username, password) => {
        const response = await send("login", "POST", { username, password }, "");
        assert.equal(response.status, 200); return (await response.json()).token;
    };
    const adminToken = await login("DAN", account.password);
    assert.equal((await send("status", "GET", null, adminToken)).status, 200);
    assert.equal((await send("users/" + admin.id, "PUT", { ...account, active: false }, adminToken)).status, 400);
    assert.equal((await send("users/" + admin.id, "PUT", { ...account, role: "editor" })).status, 400);
    const editorBody = { ...account, username: "editor", role: "editor" };
    const editorResponse = await send("users", "POST", editorBody, adminToken);
    assert.equal(editorResponse.status, 201); const editor = (await editorResponse.json()).user;
    let editorToken = await login("editor", account.password);
    assert.equal((await send("status", "GET", null, editorToken)).status, 200);
    assert.equal((await send("users", "GET", null, editorToken)).status, 403);
    assert.equal((await send("users", "POST", account, editorToken)).status, 403);
    assert.equal((await send("users/" + editor.id, "PUT", { ...editorBody, password: "", firstName: "Updated" }, adminToken)).status, 200);
    assert.equal((await send("me", "GET", null, editorToken)).status, 200);
    const newPassword = "different-long-password";
    assert.equal((await send("users/" + editor.id, "PUT", { ...editorBody, password: newPassword }, adminToken)).status, 200);
    assert.equal((await send("status", "GET", null, editorToken)).status, 401);
    assert.equal((await send("login", "POST", { username: "editor", password: account.password }, "")).status, 401);
    editorToken = await login("editor", newPassword);
    assert.equal((await send("users/" + editor.id, "PUT", { ...editorBody, password: "", active: false }, adminToken)).status, 200);
    assert.equal((await send("me", "GET", null, editorToken)).status, 401);
    assert.equal((await send("login", "POST", { username: "editor", password: newPassword }, "")).status, 401);
    assert.equal((await send("logout", "POST", {}, adminToken)).status, 200);
    assert.equal((await send("me", "GET", null, adminToken)).status, 401);
    const restarted = express(); restarted.use(express.json()); attach(restarted, { statusFile, key: "" });
    const second = restarted.listen(0, "127.0.0.1");
    await new Promise(resolve => second.once("listening", resolve));
    try {
        const response = await fetch("http://127.0.0.1:" + second.address().port + "/api/admin/login", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "dan", password: account.password })
        });
        assert.equal(response.status, 200);
    } finally { await new Promise(resolve => second.close(resolve)); }
    for (let i = 0; i < 11; i++) {
        const response = await send("login", "POST", { username: "unknown", password: "wrong" }, "");
        if (i === 10) assert.equal(response.status, 429);
    }
});
