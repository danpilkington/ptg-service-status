"use strict";
function applyMaintenance(services, notices, now = Date.now()) {
 return services.map(service => {
 const active = notices.some(n => n.autoStatus === true && n.serviceId === service.id && Date.parse(n.start) <= now && now < Date.parse(n.end));
 return active && !["outage","degraded","advisory"].includes(service.status) ? {...service, status:"maintenance", statusText:"Scheduled maintenance"} : {...service};
 });
}
function activeAnnouncement(a, now = Date.now()) { return a && (!a.expiresAt || Date.parse(a.expiresAt) > now) ? a : null; }
module.exports={applyMaintenance,activeAnnouncement};
