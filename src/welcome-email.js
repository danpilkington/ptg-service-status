"use strict";
const { ClientSecretCredential } = require("@azure/identity");
const validEmail = value => typeof value === "string" && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) && !/[\r\n]/.test(value);
function createWelcomeMailer(env = process.env, dependencies = {}) {
    let credential;
    function configuration() {
        if (env.WELCOME_EMAIL_ENABLED !== "true") return { ready: false, message: "Welcome emails are not enabled on the server." };
        if (!validEmail(env.WELCOME_EMAIL_FROM)) return { ready: false, message: "The welcome email sender is not configured." };
        try {
            const url = new URL(env.ADMIN_SIGN_IN_URL);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
        } catch { return { ready: false, message: "The admin sign-in URL is not configured." }; }
        if (!["AZURE_TENANT_ID","AZURE_CLIENT_ID","AZURE_CLIENT_SECRET"].every(key => env[key]))
            return { ready: false, message: "Microsoft 365 email credentials are not configured." };
        return { ready: true, message: "New enabled accounts receive their username and a secure password setup link by email." };
    }
    return {
        configuration,
        async send(user, link, event = "created") {
            if (!["created", "reset", "deactivated", "deleted"].includes(event)) throw new Error("Unknown account email event.");
            const label = event === "created" ? "welcome email" : "account " + event + " email";
            const config = configuration();
            if (!config.ready) return { status: "not_configured", message: config.message };
            if (!validEmail(user.email)) return { status: "failed", message: "A valid recipient email address is required." };
            try {
                credential ||= dependencies.credential || new ClientSecretCredential(env.AZURE_TENANT_ID, env.AZURE_CLIENT_ID, env.AZURE_CLIENT_SECRET);
                const token = await credential.getToken("https://graph.microsoft.com/.default", { abortSignal: AbortSignal.timeout(15000) });
                if (!token?.token) throw new Error("No token");
                const response = await (dependencies.fetch || fetch)("https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(env.WELCOME_EMAIL_FROM) + "/sendMail", {
                    method: "POST",
                    headers: { Authorization: "Bearer " + token.token, "Content-Type": "application/json" },
                    signal: AbortSignal.timeout(15000),
                    body: JSON.stringify({
                        message: {
                            subject: event === "reset" ? "Reset your PTG Status password" : event === "created" ? "Your PTG Status administration account" : "Your PTG Status account has been " + event,
                            from: { emailAddress: { address: env.WELCOME_EMAIL_FROM } },
                            body: { contentType: "Text", content: !["created","reset"].includes(event) ? [
                                "Hello " + user.firstName + ",", "",
                                "Your PTG Status administration account (" + user.username + ") has been " + event + ".",
                                "You can no longer sign in to this account.", "",
                                "If you believe this is a mistake, please contact the IT Team.", "",
                                "PTG Service Status"
                            ].join("\n") : [
                                "Hello " + user.firstName + ",", "",
                                event === "created" ? "Your PTG Status administration account has been created." : "A password reset was requested for your PTG Status account.", "",
                                "Username: " + user.username,
                                "Choose your password: " + link,
                                "This one-use link expires in " + (event === "created" ? "24 hours." : "1 hour."),
                                "Sign in: " + env.ADMIN_SIGN_IN_URL, "",
                                "If you did not request this, contact the IT Team. Your existing password stays unchanged until the link is used.",
                                "If you need help, contact the IT Team.", "",
                                "PTG Service Status"
                            ].join("\n") },
                            toRecipients: [{ emailAddress: { address: user.email } }]
                        },
                        saveToSentItems: false
                    })
                });
                if (response.status === 202) return { status: "accepted", message: "Microsoft 365 accepted the " + label + " for delivery." };
                return { status: "failed", message: response.status === 403 || response.status === 401
                    ? "Microsoft 365 refused email access. Check Mail.Send permission and the sender mailbox."
                    : "Microsoft 365 did not accept the " + label + " (HTTP " + response.status + ")." };
            } catch {
                // Never log the request, plaintext password, token or provider response body.
                return { status: "unknown", message: "Email delivery could not be confirmed. Check the recipient's inbox before taking further action." };
            }
        }
    };
}
module.exports = { createWelcomeMailer, validEmail };
