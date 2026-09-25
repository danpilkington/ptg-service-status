"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const revision = value => value === null ? null : createHash("sha256").update(value).digest("hex");
const locks = new Map();
function conflict() {
    const error = new Error("Data has changed since you opened it. Reload and reapply your changes.");
    error.status = 409;
    return error;
}
function createFileStorage(statusFile, usersFile = process.env.USERS_FILE || path.join(path.dirname(statusFile), "users.json")) {
    const files = { status: statusFile, users: usersFile };
    function fileFor(name) {
        if (!Object.hasOwn(files, name)) throw new Error("Unknown storage document.");
        return files[name];
    }
    async function read(name) {
        try { return await fs.readFile(fileFor(name), "utf8"); }
        catch (error) { if (name === "users" && error.code === "ENOENT") return null; throw error; }
    }
    return {
        kind: "file", read,
        async write(name, content, expectedRevision) {
            JSON.parse(content);
            const file = fileFor(name);
            const previous = locks.get(file) || Promise.resolve();
            const operation = previous.catch(() => {}).then(async () => {
                if (revision(await read(name)) !== expectedRevision) throw conflict();
                const temp = file + "." + randomUUID() + ".tmp";
                try {
                    await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
                    await fs.rename(temp, file);
                } finally { await fs.unlink(temp).catch(() => {}); }
            });
            locks.set(file, operation);
            try { await operation; }
            finally { if (locks.get(file) === operation) locks.delete(file); }
        },
        async close() {}
    };
}
function sqlConfig(env = process.env) {
    const server = env.SQL_SERVER, database = env.SQL_DATABASE;
    if (!server || !database) throw new Error("Set SQL_SERVER and SQL_DATABASE before enabling SQL storage.");
    const quoted = value => "{" + String(value).replace(/}/g, "}}") + "}";
    const trust = env.SQL_TRUST_SERVER_CERTIFICATE === "true";
    const connectionString = [
        "Driver=" + quoted(env.SQL_ODBC_DRIVER || "SQL Server Native Client 11.0"),
        "Server=" + quoted(server), "Database=" + quoted(database),
        "Trusted_Connection=Yes", "Encrypt=Yes", "TrustServerCertificate=" + (trust ? "Yes" : "No"),
        "APP=PTG Service Status"
    ].join(";") + ";";
    return { server, database, connectionString, connectionTimeout: 10000, requestTimeout: 15000,
        pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }, options: { trustedConnection: true, encrypt: true, trustServerCertificate: trust } };
}
function createSqlStorage(env = process.env) {
    const config = sqlConfig(env);
    const sql = require("mssql/msnodesqlv8");
    let connecting;
    async function pool() {
        if (!connecting) {
            const connection = new sql.ConnectionPool(config);
            connection.on("error", () => console.error("SQL Server connection error. Check database availability."));
            connecting = connection.connect().catch(async error => {
                connecting = null; await connection.close().catch(() => {}); throw error;
            });
        }
        return connecting;
    }
    function validName(name) {
        if (!["status", "users"].includes(name)) throw new Error("Unknown storage document.");
        return name;
    }
    return {
        kind: "sql", pool, sql,
        async read(name) {
            const result = await (await pool()).request().input("name", sql.NVarChar(20), validName(name))
                .query("SELECT Content FROM ptg_status.Documents WHERE Name = @name;");
            if (!result.recordset.length) throw new Error("SQL storage has not been initialised. Run node database-setup.js migrate before starting the website.");
            return result.recordset[0].Content;
        },
        async write(name, content, expectedRevision) {
            JSON.parse(content);
            const result = await (await pool()).request()
                .input("name", sql.NVarChar(20), validName(name))
                .input("content", sql.NVarChar(sql.MAX), content)
                .input("revision", sql.VarChar(64), revision(content))
                .input("expected", sql.VarChar(64), expectedRevision)
                .query("UPDATE ptg_status.Documents SET Content = @content, Revision = @revision, UpdatedAt = SYSUTCDATETIME() WHERE Name = @name AND Revision = @expected;");
            if (result.rowsAffected[0] !== 1) throw conflict();
        },
        async close() { if (connecting) { const connection = await connecting; connecting = null; await connection.close(); } }
    };
}
function createStorage({ statusFile, usersFile, env = process.env }) {
    const driver = env.STORAGE_DRIVER || "file";
    if (driver === "sql") return createSqlStorage(env);
    if (driver !== "file") throw new Error("STORAGE_DRIVER must be file or sql.");
    return createFileStorage(statusFile, usersFile);
}
module.exports = { createFileStorage, createSqlStorage, createStorage, sqlConfig, revision };
