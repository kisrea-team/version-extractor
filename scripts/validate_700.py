#!/usr/bin/env python3
import hashlib,json
from pathlib import Path
root=Path('/root/version-extractor'); D=root/'data/annotation-batches'; total_p=0; total_a=0; errs=[]; labels={k:0 for k in ['current_product','historical_product','non_product','ambiguous']}
for b in sorted(D.glob('batch-*')):
 s=b/'manifests/sources.json'; a=b/'manifests/annotations.json'
 if not s.exists(): continue
 rows=json.loads(s.read_text()); anns=json.loads(a.read_text()) if a.exists() else []
 for x in rows:
  if x.get('status')!=200: continue
  total_p+=1
  hf=b/'html'/(x['pageId']+'.html')
  if not hf.exists(): errs.append(f'{b.name}:{x["pageId"]} missing html')
  else:
   got=hashlib.sha256(hf.read_bytes()).hexdigest()
   if got!=x.get('snapshotSha256'): errs.append(f'{b.name}:{x["pageId"]} sha mismatch')
  if x.get('renderedHtmlFile'):
   rf=root/x['renderedHtmlFile']
   if not rf.exists(): errs.append(f'{b.name}:{x["pageId"]} missing rendered')
 for x in anns:
  total_a+=1
  if x['label'] in labels: labels[x['label']]+=1
  for k in ['pageId','name','url','pageStatus','label','noiseType','temporalStatus','subject','evidenceTypes','evidenceQuote','confidence','note','annotator','reviewStatus','fetchedAt','htmlFile','snapshotSha256']:
   if k not in x: errs.append(f'{b.name}:{x["pageId"]} missing {k}')
  q=x.get('evidenceQuote','')
  if len(q)<8: errs.append(f'{b.name}:{x["pageId"]} evidence too short')
print(f'pages {total_p} annotations {total_a} errors {len(errs)}')
print('labels',labels)
for e in errs[:20]: print('ERR',e)
