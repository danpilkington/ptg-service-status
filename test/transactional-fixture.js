"use strict";
// Add audit documents to older in-memory test fixtures without changing their failure hooks.
module.exports=function transactionalFixture(storage,primary="users"){
 const read=storage.read.bind(storage),write=storage.write.bind(storage),extra={};
 storage.read=async name=>["audit","approvals","availability"].includes(name)?extra[name]||null:(await read(name))??null;
 storage.writeMany=async changes=>{
  for(const change of changes.filter(c=>!["audit","approvals","availability"].includes(c.name)))await write(change.name,change.content,change.expectedRevision);
  for(const change of changes.filter(c=>["audit","approvals","availability"].includes(c.name)))extra[change.name]=change.content;
 };
 return storage;
};
