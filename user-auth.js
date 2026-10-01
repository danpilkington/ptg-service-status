"use strict";
const { createFileStorage, revision } = require("./storage");
const path = require("node:path");
const { createWelcomeMailer, validEmail } = require("./welcome-email");
const { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } = require("node:crypto");
const {commit,update}=require("./governance");
const derive = require("node:util").promisify(scrypt);
const publicUser = ({ id, username, firstName, lastName, jobTitle, role, active, email = "", passwordSetupRequired = false }) => ({ id, username, firstName, lastName, jobTitle, role, active, email, passwordSetupRequired });
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
    return salt + ":" + (await derive(password, salt, 64)).toString("hex");
}
module.exports = function attachUsers(app, { statusFile, key, usersFile = process.env.USERS_FILE || path.join(path.dirname(statusFile), "users.json"), storage = createFileStorage(statusFile, usersFile), welcomeMailer = createWelcomeMailer() }) {
    const sessions = new Map(), attempts = new Map();
    let writing = false;
    async function read() { return JSON.parse(await storage.read("users") || "[]"); }
    const resetAttempts=new Map();
    const tokenHash=token=>createHash("sha256").update(token).digest("hex");
    function makeLink(user,kind){
        const token=randomBytes(32).toString("hex");
        user.passwordLink={hash:tokenHash(token),expires:Date.now()+(kind==="created"?24*3600000:3600000),issued:Date.now()};
        const url=new URL("./password.html",process.env.ADMIN_SIGN_IN_URL||"https://status.progressive.technology/admin/");
        url.hash="token="+encodeURIComponent(user.id+"."+token);return url.href;
    }
    function revoke(id){for(const [token,session] of sessions)if(session.userId===id)sessions.delete(token);}
    async function issueLink(id,by,publicRequest=false){
        if(writing)return {status:"failed",message:"Another account is saving. Retry shortly."};
        writing=true;
        try{
            const raw=await storage.read("users"),users=JSON.parse(raw||"[]"),user=users.find(u=>u.id===id&&u.active);
            if(!user||!validEmail(user.email))return {status:"failed",message:"This user needs an enabled account and a valid email address."};
            if(publicRequest&&user.passwordLink?.issued>Date.now()-120000)return {status:"skipped",message:"A link was recently issued."};
            const url=makeLink(user,"reset");
            await commit(storage,[update("users",raw,users)],by,"password.link_requested",user.username);
            return await welcomeMailer.send(user,url,"reset");
        }finally{writing=false;}
    }
    const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    app.use("/api/admin", (req, res, next) => {
        res.set("Cache-Control", "no-store");
        if (req.method !== "GET" && req.get("Origin")) {
            try { if (new URL(req.get("Origin")).host !== req.get("Host")) return res.status(403).json({ error: "Cross-origin publishing is not allowed." }); }
            catch { return res.status(403).json({ error: "Invalid origin." }); }
        }
        next();
    });
    function resetLimit(req,res){
        const now=Date.now();for(const [ip,a] of resetAttempts)if(a.until<now)resetAttempts.delete(ip);
        const a=resetAttempts.get(req.ip)||{count:0,until:now+15*60000};
        if(a.count>=10||resetAttempts.size>=10000){res.status(429).json({error:"Too many password requests. Try again in 15 minutes."});return true;}
        a.count++;resetAttempts.set(req.ip,a);return false;
    }
    app.post("/api/admin/password/request",wrap(async(req,res)=>{
        if(resetLimit(req,res))return;
        const username=typeof req.body?.username==="string"?req.body.username.trim().toLowerCase().slice(0,100):"";
        res.status(202).json({message:"If this username has an enabled account with an email address, a password link will be sent. Check your inbox and junk folder."});
        setImmediate(async()=>{try{const user=(await read()).find(u=>u.username===username&&u.active);if(user)await issueLink(user.id,null,true);}catch{console.error("Password link request could not be completed.");}});
    }));
    app.post("/api/admin/password/complete",wrap(async(req,res)=>{
        if(resetLimit(req,res))return;
        const {token,password}=req.body||{};
        if(typeof token!=="string"||token.length>200||typeof password!=="string"||password.length<12||password.length>256)return res.status(400).json({error:"Use a valid link and a password of 12–256 characters."});
        if(writing)return res.status(409).json({error:"Another account is saving. Retry shortly."});
        writing=true;
        try{
            const [id,secret,...extra]=token.split(".");
            const raw=await storage.read("users"),users=JSON.parse(raw||"[]"),user=users.find(u=>u.id===id&&u.active);
            if(extra.length||!secret||!user?.passwordLink||user.passwordLink.expires<=Date.now()||!equal(tokenHash(secret),user.passwordLink.hash))return res.status(400).json({error:"This link is invalid or expired. Request a new password link."});
            user.passwordHash=await hashPassword(password);user.passwordSetupRequired=false;delete user.passwordLink;
            await commit(storage,[update("users",raw,users)],user,"password.changed",user.username);revoke(user.id);
            res.json({message:"Password saved. You can now sign in."});
        }finally{writing=false;}
    }));
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
        if (!user || user.passwordSetupRequired || !equal(candidate, user.passwordHash)) return res.status(401).json({ error: "Username or password is incorrect." });
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
    app.get("/api/admin/users", wrap(async (req, res) => res.json({ users: (await read()).map(publicUser), welcomeEmail: welcomeMailer.configuration() })));
    app.post("/api/admin/users/:id/password-link",wrap(async(req,res)=>{
        const result=await issueLink(req.params.id,req.adminUser);res.json({accountEmail:result});
    }));
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
            const email = input.email === undefined ? current?.email || "" : typeof input.email === "string" ? input.email.trim() : null;
            if ((!current && !validEmail(email)) || (email !== "" && !validEmail(email)))
                return res.status(400).json({ error: "Enter a valid email address for the user." });
            const username = input.username.trim().toLowerCase();
            if (users.some(u => u.username === username && u.id !== current?.id)) return res.status(409).json({ error: "That username already exists." });
            const password = input.password;
            if ((password !== undefined && password !== "") && (typeof password !== "string" || password.length < 12 || password.length > 256))
                return res.status(400).json({ error: "Passwords must contain between 12 and 256 characters." });
            if (current?.id === req.adminUser.id && (!input.active || input.role !== "admin")) return res.status(400).json({ error: "You cannot disable your own account or remove your administrator role." });
            if (current?.role === "admin" && current.active && (!input.active || input.role !== "admin") && !users.some(u => u.id !== current.id && u.role === "admin" && u.active))
                return res.status(400).json({ error: "Keep at least one active administrator." });
            const user = { id: current?.id || randomUUID(), username, email, firstName: input.firstName.trim(), lastName: input.lastName.trim(), jobTitle: input.jobTitle.trim(), role: input.role, active: input.active,
                passwordHash: password ? await hashPassword(password) : current?.passwordHash || await hashPassword(randomBytes(32).toString("hex")),
                passwordSetupRequired: current?.passwordSetupRequired || (!current && !password), ...(current?.passwordLink?{passwordLink:current.passwordLink}:{}) };
            if(password){user.passwordSetupRequired=false;delete user.passwordLink;}
            if(!user.active)delete user.passwordLink;
            const setupLink=!current&&user.active?makeLink(user,"created"):null;
            const output = current ? users.map(u => u.id === current.id ? user : u) : [...users, user];
            await commit(storage,[update("users",rawUsers,output)],req.adminUser,!current?"user.created":current.active&&!user.active?"user.deactivated":!current.active&&user.active?"user.reactivated":password?"user.password_changed":"user.updated",user.username);
            if (current && (password || !user.active || user.role !== current.role)) {
                for (const [token, session] of sessions) if (session.userId === current.id) sessions.delete(token);
            }
            // Persist first: no email is sent for validation, conflict or storage failures.
            let welcomeEmail;
            if (!current) {
                welcomeEmail = user.active ? await welcomeMailer.send(user, setupLink)
                    : { status: "skipped", message: "No welcome email was sent because this account is disabled." };
            }
            const accountEmail = current?.active && !user.active
                ? await welcomeMailer.send(user, undefined, "deactivated") : undefined;
            res.status(current ? 200 : 201).json({ user: publicUser(user), ...(welcomeEmail ? { welcomeEmail } : {}), ...(accountEmail ? { accountEmail } : {}) });
        } finally { writing = false; }
    }
    app.delete("/api/admin/users/:id", wrap(async (req, res) => {
        if (writing) return res.status(409).json({ error: "Another account is being saved. Please retry." });
        writing = true;
        try {
            const raw = await storage.read("users"), users = JSON.parse(raw || "[]");
            const user = users.find(item => item.id === req.params.id);
            if (!user) return res.status(404).json({ error: "User not found." });
            if (user.id === req.adminUser.id) return res.status(400).json({ error: "You cannot delete your own account." });
            if (user.active && user.role === "admin" && !users.some(item => item.id !== user.id && item.active && item.role === "admin"))
                return res.status(400).json({ error: "Keep at least one active administrator." });
            await commit(storage,[update("users",raw,users.filter(item=>item.id!==user.id))],req.adminUser,"user.deleted",user.username);
            for (const [token, session] of sessions) if (session.userId === user.id) sessions.delete(token);
            const accountEmail = await welcomeMailer.send(user, undefined, "deleted");
            res.json({ deleted: true, accountEmail });
        } finally { writing = false; }
    }));
    app.post("/api/admin/users", wrap(save));
    app.put("/api/admin/users/:id", wrap(save));
};

