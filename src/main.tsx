import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Asset, Job, Message, Project, RemovalPlan, Target, Version } from '../server/types.ts';
import './styles.css';

type PublicJob = Omit<Job,'plan'> & { plan?: Omit<RemovalPlan,'targets'> & {targets: Omit<Target,'maskPngBase64'>[]} };
type Snapshot = {project:Project;assets:Omit<Asset,'key'>[];versions:Version[];jobs:PublicJob[];messages:Message[]};
type Settings = {providerMode:string;plannerConfigured:boolean;editorConfigured:boolean;rawSupported:boolean};
const done = (job:PublicJob) => ['ready','failed','cancelled'].includes(job.status);
async function api<T>(path:string, init?:RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`,init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data as T;
}
const post = (value:unknown):RequestInit => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
function Icon({name,size=18}:{name:string;size?:number}) {
  const paths:Record<string,React.ReactNode> = {
    plus:<path d="M12 5v14M5 12h14"/>, arrow:<path d="m5 12 7-7 7 7M12 5v14"/>,
    image:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>,
    download:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></>,
    settings:<><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
    close:<path d="m6 6 12 12M6 18 18 6"/>, check:<path d="m5 12 4 4L19 6"/>,
    fit:<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
    spark:<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>,
    history:<><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"/></>,
    chevron:<path d="m8 10 4 4 4-4"/>, info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.image}</svg>;
}

function App() {
  const [projects,setProjects] = useState<Project[]>([]), [snapshot,setSnapshot] = useState<Snapshot|null>(null);
  const [settings,setSettings] = useState<Settings|null>(null), [modal,setModal] = useState<'settings'|'export'|null>(null);
  const [error,setError] = useState(''), [busy,setBusy] = useState(''), [prompt,setPrompt] = useState('');
  const [before,setBefore] = useState(false), [zoom,setZoom] = useState(1), [viewport,setViewport] = useState({width:800,height:600});
  const [format,setFormat] = useState('png'), [quality,setQuality] = useState(92), [check,setCheck] = useState('');
  const [mobileTab,setMobileTab] = useState<'canvas'|'chat'|'assets'>('canvas');
  const sourceInput = useRef<HTMLInputElement>(null), referenceInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null), chatRef = useRef<HTMLDivElement>(null);
  const selectedId = useRef<string|null>(null), uploadBusy = useRef(false);
  const drag = useRef<{x:number;y:number;left:number;top:number}|null>(null);
  const request = useRef<{prompt:string;baseVersionId:string;key:string}|null>(null);
  const project = snapshot?.project, version = snapshot?.versions.find(v=>v.id===project?.activeVersionId);
  const pending = snapshot?.jobs.find(j=>!done(j));
  const pendingId = pending?.id, pendingStatus = pending?.status;
  const hasSnapshot = snapshot !== null;
  const latest = snapshot?.jobs.at(-1);
  const root = snapshot?.versions.find(v=>!v.parentId);
  const shownVersion = before ? root : version;
  const fit = project ? Math.min((viewport.width-64)/project.width,(viewport.height-64)/project.height,1) : 1;
  const scale = Math.max(0.01,fit) * zoom;
  const isMock = settings?.providerMode === 'mock';
  const assetUrl = (id:string) => `/api/projects/${project!.id}/assets/${id}`;

  async function loadProjects() { setProjects(await api<Project[]>('/projects')); }
  const open = useCallback(async (id:string) => {
    selectedId.current = id; setError(''); setBefore(false); setZoom(1);
    try { const data = await api<Snapshot>(`/projects/${id}`); if (selectedId.current===id) {setSnapshot(data); localStorage.setItem('stillroom-project',id);} } catch (e) { fail(e); }
  }, []);
  function fail(e:unknown) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
  async function refresh(id = selectedId.current) {
    if (!id) return;
    const data = await api<Snapshot>(`/projects/${id}`);
    if (selectedId.current===id) setSnapshot(data);
  }
  useEffect(()=>{ void (async()=>{try { await loadProjects(); setSettings(await api<Settings>('/settings')); const last=localStorage.getItem('stillroom-project'); if(last) await open(last); } catch(e){fail(e);} })(); },[open]);
  useEffect(()=>{
    if (!project?.id || !pendingId || pendingStatus==='clarification') return;
    let disposed=false, timer:ReturnType<typeof setTimeout>;
    const id=project.id;
    async function poll() {try {const data=await api<Snapshot>(`/projects/${id}`);if(!disposed && selectedId.current===id)setSnapshot(data);}catch(e){if(!disposed)fail(e);}if(!disposed)timer=setTimeout(()=>{void poll();},1200);}
    timer=setTimeout(()=>{void poll();},700);
    return ()=>{disposed=true;clearTimeout(timer);};
  },[project?.id,pendingId,pendingStatus]);
  useLayoutEffect(()=>{ const node=canvasRef.current;if(!node)return;const observer=new ResizeObserver(([entry])=>setViewport({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(node);return()=>observer.disconnect(); },[hasSnapshot]);
  useEffect(()=>{chatRef.current?.scrollTo({top:chatRef.current.scrollHeight,behavior:'smooth'});},[snapshot?.messages.length,pending?.status]);

  async function upload(file:File,reference=false) {
    if (uploadBusy.current) return;
    if (!/\.(png|jpe?g)$/i.test(file.name)) {setError('This first milestone accepts JPEG and PNG. CR3 needs camera-specific validation.');return;}
    if (file.size>100_000_000) {setError('Upload a file smaller than 100 MB (up to 30 million pixels).');return;}
    uploadBusy.current=true;setBusy(reference?'Saving reference…':'Uploading & decoding…');setError('');
    try {
      const id=selectedId.current;
      const result=await api<Snapshot>(reference?`/projects/${id}/references`:'/projects',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file});
      if (!reference || selectedId.current===id) {selectedId.current=result.project.id;setSnapshot(result);localStorage.setItem('stillroom-project',result.project.id);setZoom(1);setBefore(false);}
      await loadProjects();
    } catch(e){fail(e);} finally {uploadBusy.current=false;setBusy('');}
  }
  async function sendPrompt(e:React.SubmitEvent) {
    e.preventDefault();if(!project || !version || !prompt.trim() || pending || busy)return;
    const id=project.id,baseVersionId=version.id,value=prompt.trim();
    if (request.current?.prompt!==value || request.current.baseVersionId!==baseVersionId) request.current={prompt:value,baseVersionId,key:crypto.randomUUID()};
    setBusy('Sending…');setError('');setBefore(false);
    try {await api(`/projects/${id}/jobs`,post({baseVersionId,prompt:value,idempotencyKey:request.current.key}));setPrompt('');request.current=null;await refresh(id);setMobileTab('chat');}
    catch(e){fail(e);}finally{setBusy('');}
  }
  async function choose(targetId:string) { if(!project || !pending)return;setBusy('Selecting…');setError('');try{await api(`/projects/${project.id}/jobs/${pending.id}/clarify`,post({targetId}));await refresh(project.id);}catch(e){fail(e);}finally{setBusy('');} }
  async function cancel() {if(!project || !pending)return;try{await api(`/projects/${project.id}/jobs/${pending.id}/cancel`,{method:'POST'});await refresh(project.id);}catch(e){fail(e);} }
  async function select(id:string) {if(!project)return;setError('');try{const data=await api<Snapshot>(`/projects/${project.id}/versions/${id}/select`,{method:'POST'});if(selectedId.current===project.id){setSnapshot(data);setBefore(false);}await loadProjects();}catch(e){fail(e);} }
  async function exportImage() {if(!project || !version)return;setBusy('Preparing full-resolution export…');setError('');try {const result=await api<{url:string}>(`/projects/${project.id}/exports`,post({versionId:version.id,format,quality}));const link=document.createElement('a');link.href=result.url;link.download='';document.body.appendChild(link);link.click();link.remove();setModal(null);}catch(e){fail(e);}finally{setBusy('');} }

  const fileInputs=<><input ref={sourceInput} className="sr-only" type="file" accept="image/jpeg,image/png" aria-label="Upload source photo" onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value='';}}/><input ref={referenceInput} className="sr-only" type="file" accept="image/jpeg,image/png" aria-label="Upload reference image" onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file,true);e.target.value='';}}/></>;
  return <div className="app">
    {fileInputs}
    <header className="topbar">
      <a className="brand" href="/" aria-label="Stillroom home"><span className="brand-symbol"><Icon name="spark" size={22}/></span>stillroom<span className="alpha">ALPHA</span></a>
      <div className="project-title">{project ? <><span className="tiny-dot"/>{project.name}<span className="saved">Saved locally</span></> : <span className="saved">A little space to reimagine.</span>}</div>
      <div className="header-actions"><button className="connection" onClick={()=>setModal('settings')}><span className={`tiny-dot ${isMock?'amber':''}`}/>{isMock?'Demo provider':settings?.editorConfigured?'HTTP provider':'Connect provider'}</button><button className="icon-button" aria-label="Settings" onClick={()=>setModal('settings')}><Icon name="settings"/></button>{project && <button className="primary small" onClick={()=>setModal('export')} disabled={!!busy}><Icon name="download"/>Export <Icon name="chevron" size={14}/></button>}</div>
    </header>
    {error && <div className="error-banner" role="alert"><Icon name="info"/>{error}<button className="icon-button" aria-label="Dismiss error" onClick={()=>setError('')}><Icon name="close" size={16}/></button></div>}
    {!snapshot ? <main className="welcome">
      <div className="welcome-copy"><div className="eyebrow">YOUR PHOTO. A NEW POSSIBILITY.</div><h1>A different picture,<br/><em>in a few words.</em></h1><p>Give your photograph a place to begin.<br/>Describe a change, compare versions, and keep every original.</p></div>
      <button className="upload-card" disabled={!!busy} onClick={()=>sourceInput.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const file=e.dataTransfer.files[0];if(file)void upload(file);}}><span className="upload-art"><Icon name="image" size={42}/><span className="art-plus">+</span></span><strong>{busy || 'Bring a photo into the room'}</strong><span>Drop your image here, or browse files</span><span className="file-spec">JPEG & PNG · UP TO 30 MP / 100 MB</span></button>
      <p className="demo-note"><span className="tiny-dot amber"/>{isMock?'Demo mode: a synthetic patch lets you try the workflow. No AI is connected.':'Connect a planner and image editor in Settings to start editing.'}</p>
      {projects.length>0 && <section className="recent"><div className="section-label">PICK UP WHERE YOU LEFT OFF</div><div className="recent-list">{projects.map(p=><button key={p.id} onClick={()=>void open(p.id)}><Icon name="image"/><span>{p.name}<small>{p.width.toLocaleString()} × {p.height.toLocaleString()}</small></span><span className="recent-arrow">↗</span></button>)}</div></section>}
      <footer className="welcome-footer"><Icon name="check" size={14}/>Originals kept untouched<span>·</span>Full-resolution exports<span>·</span>Saved on this device</footer>
    </main> : <>
      <nav className="mobile-tabs" aria-label="Workspace"><button className={mobileTab==='canvas'?'active':''} onClick={()=>setMobileTab('canvas')}>Photo</button><button className={mobileTab==='chat'?'active':''} onClick={()=>setMobileTab('chat')}>Conversation {pending && <span className="tiny-dot amber"/>}</button><button className={mobileTab==='assets'?'active':''} onClick={()=>setMobileTab('assets')}>Files & versions</button></nav>
      <main className={`workspace mobile-${mobileTab}`}>
        <aside className="assets-panel">
          <div className="panel-heading">Workspace<button className="icon-button" aria-label="New project" title="New photo" disabled={!!busy} onClick={()=>sourceInput.current?.click()}><Icon name="plus" size={17}/></button></div>
          <div className="section-label">PROJECT</div><select className="project-select" aria-label="Open project" value={project!.id} onChange={e=>void open(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <div className="source-card"><img src={assetUrl(root!.previewId)} alt="Original source"/><div><strong>Original photo</strong><span>{project!.width.toLocaleString()} × {project!.height.toLocaleString()}</span><small><Icon name="check" size={11}/> Original preserved</small></div></div>
          <div className="section-title"><span className="section-label">REFERENCES</span><button className="icon-button" aria-label="Add reference" disabled={!!busy} onClick={()=>referenceInput.current?.click()}><Icon name="plus" size={15}/></button></div>
          <div className="references">{snapshot.assets.filter(a=>a.kind==='reference').map(a=><div className="reference" key={a.id}><img src={assetUrl(snapshot.assets.find(thumb=>thumb.kind==='preview' && thumb.provenance.referenceId===a.id)?.id || a.id)} alt={a.name}/><span>{a.name}<small>{a.width} × {a.height}</small></span></div>)}<button className="add-reference" disabled={!!busy} onClick={()=>referenceInput.current?.click()}><Icon name="plus" size={16}/>Add reference</button><p className="muted-note">Stored with your project.<br/>Placement arrives in the next milestone.</p></div>
          <div className="section-title"><span className="section-label">VERSION HISTORY</span><Icon name="history" size={14}/></div>
          <div className="versions">{snapshot.versions.map((v,i)=><button className={`version ${v.id===version?.id?'selected':''}`} key={v.id} onClick={()=>void select(v.id)}><span className="version-dot">{v.id===version?.id && <span/>}</span><span><strong>{i===0?'Original':v.operation.type==='demo_patch'?`Demo edit ${i}`:`Edit ${i}`}</strong><small>{i===0?'Your starting point':String(v.operation.prompt || 'Object removal')}</small></span>{v.id===version?.id && <Icon name="check" size={13}/>}</button>)}</div>
          <div className="storage-note"><span className="tiny-dot"/>All changes saved locally.<br/><span>Your original is always here.</span></div>
        </aside>
        <section className="canvas-panel" aria-label="Photo workspace">
          <div className="canvas-toolbar"><span className="canvas-label"><Icon name="image" size={15}/>{before?'Original':version?.parentId?'Edited photo':'Original photo'}</span><div className="compare-control" aria-label="Compare image"><button className={before?'active':''} onClick={()=>setBefore(true)}>Before</button><button className={!before?'active':''} onClick={()=>setBefore(false)}>After</button></div></div>
          <div className="canvas-scroll" ref={canvasRef} onPointerDown={e=>{if((e.target as HTMLElement).closest('button'))return;const node=canvasRef.current!;drag.current={x:e.clientX,y:e.clientY,left:node.scrollLeft,top:node.scrollTop};node.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(!drag.current)return;const node=canvasRef.current!;node.scrollLeft=drag.current.left-(e.clientX-drag.current.x);node.scrollTop=drag.current.top-(e.clientY-drag.current.y);}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
            <div className="canvas-centering"><div className="image-stage" style={{width:project!.width*scale,height:project!.height*scale}}><img draggable={false} src={assetUrl(scale>=0.95?shownVersion!.imageId:shownVersion!.previewId)} alt={before?'Original photo before editing':'Current selected version'} onError={()=>setError('The photo could not be loaded. Reopen the project or check the local asset storage.')}/>{!before && pending?.status==='clarification' && pending.baseVersionId===version?.id && pending.plan?.targets.map((t,i)=><button key={t.id} className="target-overlay" aria-label={`Choose target ${i+1}: ${t.label}`} disabled={!!busy} style={{left:`${t.box.x/pending.plan!.coordinateSpace.width*100}%`,top:`${t.box.y/pending.plan!.coordinateSpace.height*100}%`,width:`${t.box.width/pending.plan!.coordinateSpace.width*100}%`,height:`${t.box.height/pending.plan!.coordinateSpace.height*100}%`}} onClick={()=>void choose(t.id)}><span>{i+1}</span></button>)}</div></div>
          </div>
          <div className="canvas-bottom"><span>{project!.width.toLocaleString()} × {project!.height.toLocaleString()}<span className="separator">/</span>sRGB<span className="preview-label">{scale>=0.95?'Full resolution':'Preview'}</span></span><div className="zoom-controls"><button className="icon-button" aria-label="Zoom out" onClick={()=>setZoom(z=>Math.max(0.25,z/1.25))}>−</button><span>{Math.round(scale*100)}%</span><button className="icon-button" aria-label="Zoom in" onClick={()=>setZoom(z=>Math.min(16/fit,z*1.25))}>+</button><button className="zoom-text" onClick={()=>setZoom(1/Math.max(fit,0.01))}>100%</button><button className="icon-button" aria-label="Fit photo to screen" onClick={()=>setZoom(1)}><Icon name="fit" size={16}/></button></div></div>
          {busy && <div className="busy-pill" role="status"><span className="spinner"/>{busy}</div>}
        </section>
        <aside className="conversation-panel">
          <div className="panel-heading">A conversation with your photo<Icon name="spark" size={16}/></div>
          <div className="provider-notice"><span className={`tiny-dot ${isMock?'amber':''}`}/>{isMock?'Demo mode · synthetic edits':'Connected editing workflow'}<button className="text-button" onClick={()=>setModal('settings')}>Details ↗</button></div>
          <div className="chat-scroll" ref={chatRef} aria-live="polite">
            <div className="chat-date">YOUR EDITING SESSION</div>
            {snapshot.messages.map(m=><div className={`message ${m.role}`} key={m.id}>{m.role==='assistant' && <span className="assistant-avatar"><Icon name="spark" size={15}/></span>}<div>{m.role==='assistant' && <span className="speaker">Stillroom</span>}<p>{m.text}</p></div></div>)}
            {pending && <div className="job-card"><div className="job-state">{pending.status==='clarification'?<Icon name="info" size={15}/>:<span className="spinner"/>}{({queued:'Waiting to start',planning:'Finding the target',clarification:'A quick clarification',editing:isMock?'Creating a demo patch':'Editing your photo',compositing:'Placing the result',validating:'Checking the full-resolution image'} as Record<string,string>)[pending.status]}</div>{pending.status==='clarification' && <><p>{pending.plan?.question || 'Which object do you mean?'}</p>{pending.plan?.targets.map((t,i)=><button className="target-choice" key={t.id} disabled={!!busy} onClick={()=>void choose(t.id)}><span>{i+1}</span>{t.label}<span>→</span></button>)}</>}<button className="text-button cancel-button" onClick={()=>void cancel()}>Cancel edit</button></div>}
            {latest?.status==='ready' && latest.warnings.length>0 && <details className="quality-note"><summary>About this result</summary>{latest.warnings.map((w,i)=><p key={i}>{w}</p>)}</details>}
            {!snapshot.jobs.length && <div className="suggestions"><span>START WITH A SMALL CHANGE</span><button onClick={()=>setPrompt('Remove the distracting object in the background')}>Remove something distracting <span>↗</span></button>{isMock && <small>This demo uses a fixed test region for any prompt.</small>}</div>}
          </div>
          <form className="composer" onSubmit={e=>void sendPrompt(e)}><label className="sr-only" htmlFor="prompt">Describe your edit</label><textarea id="prompt" placeholder={isMock?'Try the demo editing workflow…':'What would you like to change?'} value={prompt} maxLength={4000} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter' && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}} disabled={!!pending}/><div className="composer-bottom"><span><Icon name="image" size={13}/>{isMock?'Demo provider':'Object removal'}<span className="composer-hint"> · Shift + Enter for a new line</span></span><button className="send-button" type="submit" disabled={!prompt.trim() || !!pending || !!busy} aria-label="Send edit prompt"><Icon name="arrow" size={17}/></button></div></form>
          <div className="chat-footnote">{isMock?'No AI connected. Your photo stays on this device.':'Your provider receives only the image context needed.'}</div>
        </aside>
      </main>
    </>}
    {modal && <div className="modal-scrim" onClick={e=>{if(e.target===e.currentTarget && !busy)setModal(null);}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onKeyDown={e=>{if(e.key==='Escape' && !busy)setModal(null);}}><div className="modal-heading"><h2 id="modal-title">{modal==='settings'?'Your connection':'Take your photo with you'}</h2><button className="icon-button" aria-label="Close dialog" onClick={()=>setModal(null)} disabled={!!busy} autoFocus><Icon name="close"/></button></div>
      {modal==='settings'?<><div className="setting-status"><span className={`tiny-dot ${isMock?'amber':''}`}/>{isMock?'Mock provider is active':'HTTP provider mode'}<span className="tag">{isMock?'DEMO':'CONFIGURED'}</span></div><p>{isMock?'The demo uses a fixed, clearly marked test region and a synthetic blurred/tinted patch. It does not interpret prompts, detect objects, or perform AI removal.':'The planner must localize and segment targets. The editor must support masked PNG edits and return the requested crop dimensions.'}</p><div className="settings-row"><span>Planner</span><strong>{isMock?'Demo localization':settings?.plannerConfigured?'Configured':'Not configured'}</strong></div><div className="settings-row"><span>Image editor</span><strong>{isMock?'Synthetic patch':settings?.editorConfigured?'Configured':'Not configured'}</strong></div><div className="settings-help"><strong>Connect a real provider later</strong><p>Set <code>PROVIDER_MODE=http</code>, <code>PLANNER_URL</code>, <code>EDITOR_URL</code> and their API keys in the backend environment, then restart. The service must implement <code>docs/provider-contract.md</code>. Keys are never stored in the browser.</p></div><button className="secondary full" disabled={!!busy} onClick={async()=>{setBusy('Checking connection…');try{setCheck(JSON.stringify(await api('/settings/check',{method:'POST'}),null,2));}catch(e){fail(e);}finally{setBusy('');}}}>{busy || 'Check connection contract'}</button>{check && <pre className="connection-result">{check}</pre>}<p className="muted-note">JPEG/PNG import up to 30 MP. CR3 camera validation, real-provider quality, perspective insertion, and resumable uploads remain pending.</p></>:<><p>Export the selected version at its original canvas size, directly from the full-resolution image.</p><div className="export-dimensions"><span>CANVAS</span><strong>{project!.width.toLocaleString()} × {project!.height.toLocaleString()} px</strong><small>sRGB · Original dimensions</small></div><label className="field-label" htmlFor="format">File format</label><select id="format" value={format} onChange={e=>setFormat(e.target.value)}><option value="png">PNG · lossless · 16-bit RGBA</option><option value="tiff">TIFF · lossless · 16-bit RGBA</option><option value="jpeg">JPEG · smaller file · 8-bit RGB</option></select>{format==='jpeg' && <><label className="field-label" htmlFor="quality">JPEG quality: {quality}</label><input id="quality" type="range" min="1" max="100" value={quality} onChange={e=>setQuality(Number(e.target.value))}/><p className="muted-note">JPEG is lossy. Transparent areas are flattened on white.</p></>}<p className="export-disclaimer">{version?.operation.type==='demo_patch'?'This version contains a synthetic demo patch. ':''}16-bit export preserves working precision; it cannot add detail or precision to a generated patch.</p><button className="primary full" onClick={()=>void exportImage()} disabled={!!busy}>{busy?<span className="spinner"/>:<Icon name="download"/>}{busy || 'Download photo'}</button></>}
    </section></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
