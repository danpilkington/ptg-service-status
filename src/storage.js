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
const names = ["status", "users", "audit", "approvals", "availability", "subscriptions", "reviews"];
function createFileStorage(statusFile, usersFile = process.env.USERS_FILE || path.join(path.dirname(statusFile), "users.json")) {
    const files = { status: statusFile, users: usersFile };
    for (const name of names.slice(2)) files[name] = path.join(path.dirname(statusFile), name + ".json");
    const journal = statusFile + ".transaction";
    async function unlockedRead(name) {
        if (!Object.hasOwn(files, name)) throw new Error("Unknown storage document.");
        try { return await fs.readFile(files[name], "utf8"); }
        catch (error) { if (name !== "status" && error.code === "ENOENT") return null; throw error; }
    }
    async function replace(file, content) {
        const temp = file + "." + randomUUID() + ".tmp";
        try { await fs.writeFile(temp, content, {flag:"wx",mode:0o600}); await fs.rename(temp,file); }
        finally { await fs.unlink(temp).catch(()=>{}); }
    }
    async function recover() {
        let records;
        try { records = JSON.parse(await fs.readFile(journal,"utf8")); }
        catch(error) { if(error.code === "ENOENT") return; throw error; }
        for(const record of records) {
            if(!Object.hasOwn(files,record.name)) throw new Error("Invalid storage journal.");
            JSON.parse(record.content); await replace(files[record.name],record.content);
        }
        await fs.unlink(journal);
    }
    async function locked(action) {
        const prior=locks.get(statusFile)||Promise.resolve();
        const operation=prior.catch(()=>{}).then(async()=>{await recover();return action();});
        locks.set(statusFile,operation);
        try{return await operation;}finally{if(locks.get(statusFile)===operation)locks.delete(statusFile);}
    }
    const store = {
        kind:"file", read:name=>locked(()=>unlockedRead(name)),
        write:(name,content,expectedRevision)=>store.writeMany([{name,content,expectedRevision}]),
        writeMany:updates=>locked(async()=>{
            for(const u of updates) { JSON.parse(u.content); if(revision(await unlockedRead(u.name))!==u.expectedRevision)throw conflict(); }
            if(updates.length===1) return replace(files[updates[0].name],updates[0].content);
            await replace(journal,JSON.stringify(updates.map(({name,content})=>({name,content}))));
            await recover();
        }),
        async upgrade(){await locked(async()=>{});}, async close(){}
    };
    return store;
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
        if (!names.includes(name)) throw new Error("Unknown storage document.");
        return name;
    }
    return {
        kind: "sql", pool, sql,
        async read(name) {
            const result = await (await pool()).request().input("name", sql.NVarChar(20), validName(name))
                .query("SELECT Content FROM ptg_status.Documents WHERE Name = @name;");
            if (!result.recordset.length && names.slice(2).includes(name)) return null;
            if (!result.recordset.length) throw new Error("SQL storage has not been initialised. Run node database-setup.js migrate before starting the website.");
            return result.recordset[0].Content;
        },
        async write(name, content, expectedRevision) { return this.writeMany([{name,content,expectedRevision}]); },
        async writeMany(updates) {
            const transaction = new sql.Transaction(await pool());
            await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
            try {
                for (const u of [...updates].sort((a,b)=>a.name.localeCompare(b.name))) {
                    JSON.parse(u.content); validName(u.name);
                    const request=new sql.Request(transaction).input("name",sql.NVarChar(20),u.name)
                        .input("content",sql.NVarChar(sql.MAX),u.content).input("revision",sql.VarChar(64),revision(u.content))
                        .input("expected",sql.VarChar(64),u.expectedRevision);
                    const result=await request.query(u.expectedRevision===null
                        ? "INSERT INTO ptg_status.Documents (Name,Content,Revision) SELECT @name,@content,@revision WHERE NOT EXISTS (SELECT 1 FROM ptg_status.Documents WITH (UPDLOCK,HOLDLOCK) WHERE Name=@name);"
                        : "UPDATE ptg_status.Documents SET Content=@content,Revision=@revision,UpdatedAt=SYSUTCDATETIME() WHERE Name=@name AND Revision=@expected;");
                    if(result.rowsAffected[0]!==1)throw conflict();
                }
                await transaction.commit();
            } catch(error) {await transaction.rollback().catch(()=>{});throw error;}
        },
        async upgrade() {
            await (await pool()).request().batch(await fs.readFile(path.join(require("node:path").resolve(__dirname, ".."),"database/features.sql"),"utf8"));
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
