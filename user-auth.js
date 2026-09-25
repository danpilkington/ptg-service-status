"use strict";
const { createFileStorage, revision } = require("./storage");
const path = require("node:path");
const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const derive = require("node:util").promisify(scrypt);
const publicUser = ({ id, username, firstName, lastName, jobTitle, role, active }) => ({ id, username, firstName, lastName, jobTitle, role, active });
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
    return salt + ":" + (await derive(password, salt, 64)).toString("hex");
}
module.exports = function attachUsers(app, { statusFile, key, usersFile = process.env.USERS_FILE || path.join(path.dirname(statusFile), "users.json"), storage = createFileStorage(statusFile, usersFile) }) {
    const sessions = new Map(), attempts = new Map();
    let writing = false;
    async function read() { return JSON.parse(await storage.read("users") || "[]"); }
    const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    app.use("/api/admin", (req, res, next) => {
        res.set("Cache-Control", "no-store");
        if (req.method !== "GET" && req.get("Origin")) {
            try { if (new URL(req.get("Origin")).host !== req.get("Host")) return res.status(403).json({ error: "Cross-origin publishing is not allowed." }); }
            catch { return res.status(403).json({ error: "Invalid origin." }); }
        }
        next();
    });
    app.post("/api/admin/login", wrap(async (req, res) => {
        const now = Date.now();
        for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
        for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token);
        const ip = req.ip;
        const attempt = attempts.get(ip) || { count: 0, until: now + 15 * 60000 };
        if (attempt.count >= 10 || attempts.size >= 10000) return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
        attempt.count++; attempts.set(ip, attempt);
        const { username, password } = req.body || {};
        if (typeof username !== "string" || username.length > 100 || typeof password !== "string" || password.length > 256) return res.status(401).json({ error: "Username or password is incorrect." });
        const users = await read();
        const user = users.find(u => u.username === username.trim().toLowerCase() && u.active);
        const salt = user?.passwordHash.split(":")[0] || "00000000000000000000000000000000";
        const candidate = await hashPassword(password, salt);
        if (!user || !equal(candidate, user.passwordHash)) return res.status(401).json({ error: "Username or password is incorrect." });
        if (sessions.size >= 10000) return res.status(503).json({ error: "Sign-in is busy. Try again later." });
        const token = randomBytes(32).toString("hex");
        sessions.set(token, { userId: user.id, expires: now + 8 * 3600000 });
        res.json({ token, user: publicUser(user) });
    }));
    app.use("/api/admin", wrap(async (req, res, next) => {
        const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
        if (key && key.length >= 24 && equal(token, key)) {
            req.adminUser = { id: "bootstrap", role: "admin", firstName: "Administrator" };
            return next();
        }
        if ((!key || key.length < 24) && !(await read()).some(u => u.active)) return res.status(503).json({ error: "Publishing is disabled. Configure ADMIN_API_KEY with at least 24 characters on the server to create the first administrator." });
        const session = sessions.get(token);
        if (session && session.expires > Date.now()) {
            const user = (await read()).find(u => u.id === session.userId && u.active);
            if (user) { req.adminUser = publicUser(user); req.sessionToken = token; return next(); }
        }
        sessions.delete(token);
        return res.status(401).json({ error: "Please sign in again. Your session is invalid or has expired." });
    }));
    app.get("/api/admin/me", (req, res) => res.json({ user: req.adminUser }));
    app.post("/api/admin/logout", (req, res) => { sessions.delete(req.sessionToken); res.json({ ok: true }); });
    app.use("/api/admin/users", (req, res, next) => {
        if (req.adminUser.role !== "admin") return res.status(403).json({ error: "Only administrators can manage users." });
        next();
    });
    app.get("/api/admin/users", wrap(async (req, res) => res.json({ users: (await read()).map(publicUser) })));
    async function save(req, res) {
        if (writing) return res.status(409).json({ error: "Another account is being saved. Please retry." });
        writing = true;
        try {
            const rawUsers = await storage.read("users");
            const users = JSON.parse(rawUsers || "[]"), input = req.body || {};
            const current = req.params.id ? users.find(u => u.id === req.params.id) : null;
            if (req.params.id && !current) return res.status(404).json({ error: "User not found." });
            const limits = { username: 100, firstName: 100, lastName: 100, jobTitle: 160 };
            if (Object.entries(limits).some(([field, max]) => typeof input[field] !== "string" || !input[field].trim() || input[field].length > max) ||
                !/^[a-zA-Z0-9@._-]+$/.test(input.username.trim()) || !["admin", "editor"].includes(input.role) || typeof input.active !== "boolean")
                return res.status(400).json({ error: "Enter a username, first name, last name, job title, and valid role. Usernames may contain letters, numbers, @, dots, underscores and hyphens." });
            const username = input.username.trim().toLowerCase();
            if (users.some(u => u.username === username && u.id !== current?.id)) return res.status(409).json({ error: "That username already exists." });
            const password = input.password;
            if ((!current || password !== undefined && password !== "") && (typeof password !== "string" || password.length < 12 || password.length > 256))
                return res.status(400).json({ error: "Passwords must contain between 12 and 256 characters." });
            if (current?.id === req.adminUser.id && (!input.active || input.role !== "admin")) return res.status(400).json({ error: "You cannot disable your own account or remove your administrator role." });
            if (current?.role === "admin" && current.active && (!input.active || input.role !== "admin") && !users.some(u => u.id !== current.id && u.role === "admin" && u.active))
                return res.status(400).json({ error: "Keep at least one active administrator." });
            const user = { id: current?.id || randomUUID(), username, firstName: input.firstName.trim(), lastName: input.lastName.trim(), jobTitle: input.jobTitle.trim(), role: input.role, active: input.active,
                passwordHash: password ? await hashPassword(password) : current.passwordHash };
            const output = current ? users.map(u => u.id === current.id ? user : u) : [...users, user];
            await storage.write("users", JSON.stringify(output, null, 2) + "\n", revision(rawUsers));
            if (current && (password || !user.active || user.role !== current.role)) {
                for (const [token, session] of sessions) if (session.userId === current.id) sessions.delete(token);
            }
            res.status(current ? 200 : 201).json({ user: publicUser(user) });
        } finally { writing = false; }
    }
    app.post("/api/admin/users", wrap(save));
    app.put("/api/admin/users/:id", wrap(save));
};

