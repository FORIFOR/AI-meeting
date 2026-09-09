"""Process-tree RSS observations; no claim of heap leak absence from a short run."""
import subprocess,time,json,datetime,pathlib
folder=pathlib.Path(__file__).resolve().parent
samples=[];root=None
while True:
    lines=subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,command='],text=True).splitlines()
    rows=[]
    for line in lines:
        parts=line.strip().split(None,3)
        if len(parts)==4:rows.append((int(parts[0]),int(parts[1]),int(parts[2]),parts[3]))
    if root is None:
        roots=[r[0] for r in rows if r[3].split()[0].endswith('node') and 'apps/web/scripts/soak-browser.mjs --engine google --minutes 30 --base http://127.0.0.1:5180' in r[3]]
        if len(roots)!=1:raise SystemExit('Expected one test runner; found '+str(len(roots)))
        root=roots[0]
    if not any(r[0]==root for r in rows):break
    descendants={root}
    while True:
        found={r[0] for r in rows if r[1] in descendants}
        if found<=descendants:break
        descendants|=found
    sample={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'processes':len(descendants),'rssKiB':sum(r[2] for r in rows if r[0] in descendants)}
    samples.append(sample)
    (folder/'process-memory.json').write_text(json.dumps({'scope':'Runner and browser process-tree RSS, sampling started after session start; summed RSS may double-count shared pages; not a heap-leak certification','samples':samples},indent=2)+'\n')
    time.sleep(30)
