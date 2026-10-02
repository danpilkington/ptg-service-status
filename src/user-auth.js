"use strict";
const {randomBytes,timingSafeEqual}=require("node:crypto");
module.exports=function attachGroups(app,options){
    if(options.allowLocalUsers===true)return require("./legacy-user-auth")(app,options);
    const {storage,key}=options,graph=require("./microsoft-admin").forStorage(storage),sessions=new Map();
    const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
    const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
    app.use("/api/admin",(req,res,next)=>{res.set("Cache-Control","no-store");if(req.method!=="GET"&&req.get("Origin")){try{if(new URL(req.get("Origin")).host!==req.get("Host"))return res.sendStatus(403);}catch{return res.sendStatus(403);}}next();});
    app.use(["/api/admin/users","/api/admin/login","/api/admin/password"],(req,res)=>res.status(410).json({error:"Local accounts have been removed. Use Microsoft group sign-in."}));
    function issueSession(user,claims){for(const [token,s]of sessions)if(s.expires<=Date.now())sessions.delete(token);if(sessions.size>=10000)throw Error("Sign-in is busy.");const token=randomBytes(32).toString("hex");sessions.set(token,{claims,expires:Date.now()+8*3600000});return {token,user};}
    require("./azure-sso")(app,{read:async()=>[],issueSession,wrap,resolveUser:graph.resolve});
    app.use("/api/admin",wrap(async(req,res,next)=>{const token=(req.get("Authorization")||"").replace(/^Bearer /,"");if(key&&key.length>=24&&equal(token,key)){req.adminUser={id:"bootstrap",role:"admin",firstName:"Administrator"};return next();}
        const session=sessions.get(token);if(session&&session.expires>Date.now()){let user;try{user=await graph.resolve([],session.claims,process.env.AZURE_TENANT_ID?.toLowerCase());}catch{return res.status(503).json({error:"Microsoft group access could not be verified. Please retry."});}if(user){req.adminUser=user;req.sessionToken=token;return next();}}
        sessions.delete(token);res.status(401).json({error:"Please sign in with Microsoft. Your group access or session is no longer valid."});
    }));
    app.get("/api/admin/me",(req,res)=>res.json({user:req.adminUser}));app.post("/api/admin/logout",(req,res)=>{sessions.delete(req.sessionToken);res.json({ok:true});});
};
