"""Summarize only executed observations; missing trials remain missing."""
import datetime,hashlib,json,pathlib,re
p=pathlib.Path(__file__).resolve().parent
build=(p/'build-id.txt').read_text().strip()
measurements={}
def add(metric,value,samples,artifact,reviewer):
    measurements[metric]={'value':value,'samples':samples,'artifact':str(artifact.relative_to(p)),'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),'measuredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reviewer':reviewer}
for prefix,metric in [('lifecycle','socketDisconnect'),('network10','network10Seconds'),('rateLimit','rateLimit'),('timeout','timeout')]:
    files=sorted(p.glob(prefix+'-[123].json'))
    rows=[dict(file=f.name,**json.loads(f.read_text())) for f in files]
    series={'buildId':build,'injectedFault':prefix,'scope':'Real Gemini sockets; injected token-fetch faults. Recovery means ready with an actual resumption handle. No physical audio/device result.','runs':rows}
    artifact=p/(prefix+'-series.json');artifact.write_text(json.dumps(series,indent=2)+'\n')
    if len(rows)==3:
        add('failure.'+metric+'.recoveryRate',sum(r['status']=='PASS' for r in rows)/3,3,artifact,'Codex, real socket lifecycle with controlled fault injection; connection recovery only')
        if prefix=='lifecycle':
            ok=sum(any(x['check']=='no events after leaving' and x['status']=='PASS' for x in r['rows']) for r in rows)
            add('failure.leave.recoveryRate',ok/3,3,artifact,'Codex, provider disconnect and no subsequent events; not physical speaker measurement')
soaks=sorted((p/'soak').glob('*.json'))
if soaks:
    f=soaks[-1];r=json.loads(f.read_text());s=r.get('summary') or {};lat=s.get('turnLatency') or {}
    for quantile in ['p50','p95']:
        if isinstance(lat.get(quantile),(int,float)):
            add('voice.firstAudio'+quantile.upper()[0]+quantile[1:]+'Ms',lat[quantile],lat.get('n',0),f,'Codex, public web, real Vertex Gemini, synthetic microphone, browser HUD; no physical audio measurement')
(p/'evidence.json').write_text(json.dumps({'schemaVersion':1,'buildId':build,'measurements':measurements},indent=2)+'\n')
print('Recorded',len(measurements),'measured metrics; no missing human or platform results filled.')
