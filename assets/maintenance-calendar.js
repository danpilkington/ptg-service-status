(function(root){
    "use strict";
    const escapeText=value=>String(value||"").replace(/\\/g,"\\\\").replace(/\r?\n/g,"\\n").replace(/;/g,"\\;").replace(/,/g,"\\,");
    const stamp=value=>new Date(value).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
    function calendar(items,now=new Date()){
        const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//PTG//Service Maintenance//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH","X-WR-CALNAME:PTG planned maintenance"];
        for(const item of items){if(!Number.isFinite(Date.parse(item.start))||!Number.isFinite(Date.parse(item.end))||Date.parse(item.end)<=Date.parse(item.start))continue;
            lines.push("BEGIN:VEVENT","UID:"+escapeText(item.id)+"@status.progressive.technology","DTSTAMP:"+stamp(now),"DTSTART:"+stamp(item.start),"DTEND:"+stamp(item.end),"SUMMARY:"+escapeText(item.title),"DESCRIPTION:"+escapeText((item.service||item.serviceId||"")+"\n"+(item.message||"")),"END:VEVENT");
        }
        lines.push("END:VCALENDAR");
        // Fold by UTF-8 bytes so long titles remain compatible with Outlook.
        return lines.map(line=>{let out="",size=0;for(const ch of line){const bytes=new TextEncoder().encode(ch).length;if(size+bytes>73){out+="\r\n ";size=1;}out+=ch;size+=bytes;}return out;}).join("\r\n")+"\r\n";
    }
    if(typeof module!=="undefined")module.exports={calendar,escapeText};
    if(!root.document)return;
    let month=new Date();month.setDate(1);let current=[];
    const host=document.getElementById("maintenance-calendar");if(!host)return;const panel=host.closest("details");if(panel)panel.hidden=false;
    const controls=document.createElement("div");controls.className="calendar-controls";
    const previous=document.createElement("button"),next=document.createElement("button"),title=document.createElement("strong"),download=document.createElement("a");
    previous.textContent="Previous month";next.textContent="Next month";previous.type=next.type="button";download.textContent="Add upcoming work to Outlook";download.href="/api/maintenance/calendar.ics";download.className="calendar-download";
    controls.append(previous,title,next,download);const grid=document.createElement("div");grid.className="maintenance-month";host.append(controls,grid);
    function render(items){current=items||[];title.textContent=month.toLocaleDateString("en-GB",{month:"long",year:"numeric"});grid.replaceChildren();
        for(const name of ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]){const label=document.createElement("strong");label.textContent=name;grid.append(label);}
        const first=(month.getDay()+6)%7,days=new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
        for(let i=0;i<first;i++){const blank=document.createElement("div");blank.className="calendar-empty";grid.append(blank);}
        for(let day=1;day<=days;day++){
            const start=new Date(month.getFullYear(),month.getMonth(),day),end=new Date(month.getFullYear(),month.getMonth(),day+1),cell=document.createElement("div");cell.className="calendar-day";
            const number=document.createElement("strong");number.textContent=String(day);cell.append(number);
            const events=current.filter(i=>Date.parse(i.start)<end.getTime()&&Date.parse(i.end)>start.getTime());
            if(events.length)cell.classList.add("has-maintenance");
            for(const item of events){const event=document.createElement("a");event.textContent=item.title;event.title=(item.service||item.serviceId||"")+": "+new Date(item.start).toLocaleString("en-GB");event.href="/api/maintenance/calendar.ics?id="+encodeURIComponent(item.id);cell.append(event);}
            grid.append(cell);
        }
    }
    previous.onclick=()=>{month.setMonth(month.getMonth()-1);render(current);};next.onclick=()=>{month.setMonth(month.getMonth()+1);render(current);};root.PTGCalendar={render};render([]);
    if(document.body.classList.contains("maintenance-page")){
        const feedback=document.getElementById("calendar-feedback"),retry=document.getElementById("calendar-retry");
        async function load(){
            retry.hidden=true;feedback.textContent="Loading published maintenance…";
            try{
                const response=await fetch("/api/status",{cache:"no-store"});
                if(!response.ok)throw new Error("Unable to load maintenance");
                const data=await response.json();render(data.maintenance||[]);
                feedback.textContent=current.length?"Dates use your local time. Select a maintenance item to download it for Outlook.":"No published maintenance is currently scheduled. Dates use your local time.";
            }catch(error){feedback.textContent="Maintenance could not be loaded. Please try again.";retry.hidden=false;}
        }
        retry.onclick=load;load();
    }
})(typeof window!=="undefined"?window:globalThis);
