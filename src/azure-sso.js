"use strict";
const { randomBytes, createHash } = require("node:crypto");
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function configuration(env = process.env) {
    const tenant = env.AZURE_TENANT_ID, client = env.AZURE_CLIENT_ID, secret = env.AZURE_CLIENT_SECRET;
    let redirect;
    try { redirect = new URL(env.ADMIN_SSO_REDIRECT_URI); } catch { return null; }
    if (env.ADMIN_SSO_ENABLED !== "true" || !guid.test(tenant || "") || !guid.test(client || "") || !secret || redirect.protocol !== "https:" || redirect.pathname !== "/api/admin/sso/callback" || redirect.search || redirect.hash) return null;
    return { tenant: tenant.toLowerCase(), client, secret, redirect: redirect.href };
}
function authorisedUser(users, claims, tenant) {
    if (claims.tid !== tenant || !guid.test(claims.oid || "")) return null;
    const matches = users.filter(u => u.active && ["admin", "editor"].includes(u.role) && u.entraObjectId?.toLowerCase() === claims.oid.toLowerCase());
    return matches.length === 1 ? matches[0] : null;
}
module.exports = function attachSso(app, { read, issueSession, wrap, config = configuration(), verifyIdentity, resolveUser }) {
    const pending = new Map(), handoffs = new Map();
    const random = () => randomBytes(32).toString("base64url");
    const cookie = (req, name) => (req.get("Cookie") || "").split(";").map(v => v.trim()).find(v => v.startsWith(name + "="))?.slice(name.length + 1);
    const options = { httpOnly: true, secure: true, sameSite: "lax", path: "/api/admin/sso", maxAge: 5 * 60000 };
    const clearOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/api/admin/sso" };
    const prune = map => { for (const [id, item] of map) if (item.expires <= Date.now()) map.delete(id); };
    let keys;
    const diagnostics={enabled:!!config,tokenValidatorReady:false,recentFailures:[],lastSuccessAt:null};
    const reasons={state:"The sign-in session was lost or the browser did not return its secure cookie. Use the configured HTTPS hostname and retry; check server restarts or multiple workers.",expired:"The sign-in took longer than five minutes. Start again.",provider:"Microsoft refused or cancelled the sign-in. Check the app registration and tenant sign-in logs.",exchange:"Microsoft refused the authorisation-code exchange. Check the client secret and registered Web redirect URI.",validation:"The Microsoft identity token could not be validated. Check connectivity to Microsoft signing keys, server time and the token validator dependency.",storage:"The authorised user list could not be read. Check database access.",capacity:"The sign-in handoff queue is full. Retry shortly."};
    function fail(res,reason,providerCodes=[]){
        diagnostics.recentFailures.unshift({at:new Date().toISOString(),reason,message:reasons[reason],providerCodes:providerCodes.filter(n=>Number.isInteger(n)&&n>=0&&n<10000000).slice(0,4)});
        diagnostics.recentFailures=diagnostics.recentFailures.slice(0,30);
        console.error("Microsoft SSO failed at "+reason+".");
        return res.redirect("/admin/?sso=failed");
    }
    app.locals.ssoDiagnostics=()=>({...diagnostics,recentFailures:diagnostics.recentFailures.map(f=>({...f})),redirectUri:config?.redirect||null});
    import("jose").then(()=>{diagnostics.tokenValidatorReady=true;}).catch(()=>{});
    async function verify(token, nonce) {
        if (verifyIdentity) return verifyIdentity(token, nonce);
        const { createRemoteJWKSet, jwtVerify } = await import("jose");
        keys ||= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenant}/discovery/v2.0/keys`));
        const { payload } = await jwtVerify(token, keys, { issuer: `https://login.microsoftonline.com/${config.tenant}/v2.0`, audience: config.client, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "nonce", "tid", "oid"] });
        if (payload.nonce !== nonce) throw new Error("Invalid nonce");
        return payload;
    }
    app.get("/api/admin/sso/config", (req, res) => res.json({ enabled: !!config }));
    app.get("/api/admin/sso/start", (req, res) => {
        if (!config) return res.status(404).json({ error: "Microsoft sign-in is not configured." });
        prune(pending);
        if (pending.size >= 10000) return res.status(503).json({ error: "Sign-in is busy. Try again later." });
        const state = random(), nonce = random(), verifier = random();
        pending.set(state, { nonce, verifier, expires: Date.now() + 5 * 60000 });
        res.cookie("ptg_sso_state", state, options);
        const url = new URL(`https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/authorize`);
        url.search = new URLSearchParams({ client_id: config.client, redirect_uri: config.redirect, response_type: "code", response_mode: "query", scope: "openid profile", state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
        res.redirect(url.href);
    });
    app.get("/api/admin/sso/callback", wrap(async (req, res) => {
        res.set("Referrer-Policy", "no-referrer");
        if (!config) return res.sendStatus(404);
        const state = req.query.state, stored = typeof state === "string" && pending.get(state);
        // Do not consume another browser's pending sign-in.
        if (!stored || cookie(req, "ptg_sso_state") !== state) return fail(res,"state");
        pending.delete(state); res.clearCookie("ptg_sso_state", clearOptions);
        if(stored.expires<=Date.now())return fail(res,"expired");
        if(typeof req.query.code!=="string"||req.query.error)return fail(res,"provider");
        let stage="exchange";
        try {
            const response = await fetch(`https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/token`, { method: "POST", signal: AbortSignal.timeout(15000), body: new URLSearchParams({ client_id: config.client, client_secret: config.secret, redirect_uri: config.redirect, grant_type: "authorization_code", code: req.query.code, code_verifier: stored.verifier, scope: "openid profile" }) });
            if(!response.ok){const body=await response.json().catch(()=>({}));return fail(res,"exchange",Array.isArray(body.error_codes)?body.error_codes:[]);}
            const result=await response.json();stage="validation";
            const claims=await verify(result.id_token,stored.nonce);stage="storage";
            const user = resolveUser ? await resolveUser(await read(), claims, config.tenant) : authorisedUser(await read(), claims, config.tenant);
            if (!user) return res.redirect("/admin/?sso=denied");
            stage="capacity";prune(handoffs);
            if (handoffs.size >= 10000) throw new Error("Sign-in busy");
            const id = random();
            handoffs.set(id, { claims:{tid:claims.tid,oid:claims.oid,name:claims.name},userId: user.id, objectId: claims.oid.toLowerCase(), expires: Date.now() + 60000 });
            res.cookie("ptg_sso_handoff", id, { ...options, maxAge: 60000 });
            diagnostics.lastSuccessAt=new Date().toISOString();
            res.redirect("/admin/?sso=complete");
        } catch { fail(res,stage); }
    }));
    app.post("/api/admin/sso/complete", wrap(async (req, res) => {
        const id = cookie(req, "ptg_sso_handoff"), item = handoffs.get(id);
        handoffs.delete(id); res.clearCookie("ptg_sso_handoff", clearOptions);
        if (!item || item.expires <= Date.now()) return res.status(401).json({ error: "Microsoft sign-in expired. Please try again." });
        let user;
        try {user = resolveUser ? await resolveUser(await read(),item.claims,config.tenant) : (await read()).find(u => u.id === item.userId && u.active && ["admin", "editor"].includes(u.role) && u.entraObjectId?.toLowerCase() === item.objectId);} catch {return res.status(503).json({error:"Group access could not be verified. Please try again."});}
        if (!user) return res.status(403).json({ error: "Your account is not authorised for this admin page." });
        res.json(issueSession(user,resolveUser?item.claims:undefined));
    }));
};
module.exports.configuration = configuration;
module.exports.authorisedUser = authorisedUser;
module.exports.guid = guid;
