(() => {
    let token=new URLSearchParams(location.hash.slice(1)).get("token");
    history.replaceState(null,"",location.pathname);
    const form=document.getElementById("password-complete"),feedback=document.getElementById("password-feedback");
    if(!token){form.hidden=true;feedback.textContent="Open the password link from your email, or request a new link from the sign-in page.";return;}
    form.addEventListener("submit",async event=>{
        event.preventDefault();
        const password=document.getElementById("new-password").value;
        if(password!==document.getElementById("confirm-password").value){feedback.textContent="The passwords do not match.";return;}
        const button=form.querySelector("button");button.disabled=true;
        try{
            const response=await fetch("/api/admin/password/complete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token,password})});
            const result=await response.json();if(!response.ok)throw new Error(result.error||"Unable to save password.");
            token=null;form.reset();form.hidden=true;feedback.textContent=result.message;
        }catch(error){feedback.textContent=error.message;}finally{button.disabled=false;}
    });
})();
