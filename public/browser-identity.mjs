// Runtime-only peer discovery: disk-cloned LocalStorage/IndexedDB is never used
// as proof that two live pages belong to the same browser.
export async function createBrowserIdentity() {
  const key='supermarket.browser-session',bus='supermarket.browser-peers';
  const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
  const valid=value=>typeof value==='string'&&/^[-_A-Za-z0-9]{32,256}$/.test(value);
  let saved;try{saved=sessionStorage.getItem(key);}catch{}
  const candidate=valid(saved)?saved:random(),page=random();
  let token=null,probe=null,peers=[],channel;
  const send=message=>{
    const value={...message,page};
    if(channel)channel.postMessage(value);
    else try{localStorage.setItem(bus,JSON.stringify({...value,event:random()}));localStorage.removeItem(bus);}catch{}
  };
  const receive=value=>{
    if(!value||value.page===page)return;
    if(value.type==='probe')send({type:'reply',request:value.request,token:token||candidate,ready:!!token});
    if(value.type==='reply'&&value.request===probe&&valid(value.token))peers.push(value);
  };
  const onStorage=event=>{if(event.key===bus&&event.newValue)try{receive(JSON.parse(event.newValue));}catch{}};
  if(typeof BroadcastChannel==='function'){channel=new BroadcastChannel(bus);channel.onmessage=event=>receive(event.data);}
  else window.addEventListener('storage',onStorage);
  const discover=async()=>{
    probe=random();peers=[];send({type:'probe',request:probe});
    await new Promise(resolve=>setTimeout(resolve,220));
    const ready=peers.filter(peer=>peer.ready).map(peer=>peer.token);
    token=(ready.length?ready:[candidate,...peers.map(peer=>peer.token)]).sort()[0];probe=null;
    try{sessionStorage.setItem(key,token);}catch{}
  };
  // Chrome 99 supports Web Locks on HTTPS. The peer election also works on
  // HTTP and browsers without locks; storage events cover absent channels.
  try{if(navigator.locks?.request)await navigator.locks.request(bus,discover);else await discover();}
  catch{await discover();}
  return {token,close(){channel?.close();window.removeEventListener('storage',onStorage);}};
}
