"use strict";
if (require.main === module) require("dotenv").config({ path: require("node:path").join(__dirname, ".env") });
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createFileStorage, createSqlStorage, revision } = require("./storage");

async function migrate(store, source) {
    const status = await source.read("status"), users = await source.read("users") || "[]\n";
    const parsedStatus = JSON.parse(status), parsedUsers = JSON.parse(users);
    if (!parsedStatus || !Array.isArray(parsedStatus.services) || !Array.isArray(parsedStatus.incidents) ||
        !Array.isArray(parsedStatus.maintenance) || !Array.isArray(parsedUsers))
        throw new Error("Source files do not contain valid status and user records.");
    if (parsedUsers.some(u => !u.id || !u.username || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(u.passwordHash)))
        throw new Error("A source user has invalid identity or password data. Migration stopped.");
    const pool = await store.pool(), sql = store.sql;
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
        const existing = await new sql.Request(transaction).query("SELECT Name, Revision FROM ptg_status.Documents WITH (UPDLOCK, HOLDLOCK);");
        const docs = { status, users };
        if (existing.recordset.some(row => !Object.hasOwn(docs, row.Name) || row.Revision !== revision(docs[row.Name])))
            throw new Error("SQL already contains different data. Nothing was overwritten. Check the existing database before switching storage.");
        for (const [name, content] of Object.entries(docs)) {
            if (existing.recordset.some(row => row.Name === name)) continue;
            await new sql.Request(transaction).input("name", sql.NVarChar(20), name)
                .input("content", sql.NVarChar(sql.MAX), content).input("revision", sql.VarChar(64), revision(content))
                .query("INSERT INTO ptg_status.Documents (Name, Content, Revision) VALUES (@name, @content, @revision);");
        }
        if (await source.read("status") !== status || (await source.read("users") || "[]\n") !== users)
            throw new Error("Source files changed during migration. Stop the website and retry.");
        await transaction.commit();
    } catch (error) { await transaction.rollback().catch(() => {}); throw error; }
    if (await store.read("status") !== status || await store.read("users") !== users)
        throw new Error("Post-migration verification failed. SQL storage has not been enabled.");
    return { services: parsedStatus.services.length, users: parsedUsers.length };
}
async function activate(envFile) {
    const original = await fs.readFile(envFile, "utf8");
    const lines = original.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?STORAGE_DRIVER\s*=/.test(line));
    const updated = lines.join("\n").trimEnd() + "\nSTORAGE_DRIVER=sql\n";
    const temp = envFile + "." + randomUUID() + ".tmp";
    try { await fs.writeFile(temp, updated, { flag: "wx", mode: 0o600 }); await fs.rename(temp, envFile); }
    finally { await fs.unlink(temp).catch(() => {}); }
}
async function main(args = process.argv.slice(2)) {
    const command = args[0] || "check";
    if (!["check", "migrate"].includes(command)) throw new Error("Use check or migrate --site-stopped [--activate].");
    if (command === "migrate" && !args.includes("--site-stopped"))
        throw new Error("Stop the website first, then run: node database-setup.js migrate --site-stopped --activate");
    const store = createSqlStorage();
    try {
        const pool = await store.pool();
        const info = (await pool.request().query("SELECT DB_NAME() AS DatabaseName, SUSER_SNAME() AS WindowsAccount, compatibility_level AS CompatibilityLevel FROM sys.databases WHERE name = DB_NAME();")).recordset[0];
        console.log("Connected to " + info.DatabaseName + " as " + info.WindowsAccount + ".");
        if (Number(info.CompatibilityLevel) < 130) throw new Error("SQL Server 2016+ with database compatibility level 130+ is required. Ask your database administrator to review compatibility.");
        if (command === "check") {
            const schema = (await pool.request().query("SELECT OBJECT_ID(N'ptg_status.Documents', N'U') AS TableId;")).recordset[0];
            console.log(schema.TableId ? "Storage table exists." : "Connection works. The storage tables still need to be created by migration.");
            return;
        }
        await pool.request().batch(await fs.readFile(path.join(__dirname, "database/setup.sql"), "utf8"));
        const source = createFileStorage(process.env.STATUS_FILE || path.join(__dirname, "status.json"));
        const counts = await migrate(store, source);
        console.log("Verified SQL data: " + counts.services + " services and " + counts.users + " users. Source JSON files retained.");
        if (args.includes("--activate")) {
            await activate(path.join(__dirname, ".env"));
            console.log("SQL storage enabled in .env. Start the website as the same Windows account. Remove any service-level STORAGE_DRIVER=file override.");
        } else console.log("Migration complete. SQL storage is not yet enabled. Repeat with --activate while the website remains stopped.");
    } finally { await store.close().catch(() => {}); }
}
if (require.main === module) main().catch(error => { console.error("SQL setup failed: " + error.message); process.exitCode = 1; });
module.exports = { migrate, activate };
