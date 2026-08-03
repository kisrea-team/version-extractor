#!/usr/bin/env python3
import json,hashlib
from pathlib import Path
root=Path('/root/version-extractor'); D=root/'data/annotation-batches'
all_pages=[]; all_anns=[]; seen=set()
for b in sorted(D.glob('batch-*')):
 s=b/'manifests/sources.json'; a=b/'manifests/annotations.json'
 if not s.exists(): continue
 rows=json.loads(s.read_text())
 anns=json.loads(a.read_text()) if a.exists() else []
 for x in rows:
  if x['url'] in seen: continue
  seen.add(x['url']); x['htmlFile']=str((b/'html'/(x['pageId']+'.html')).relative_to(root)) if (b/'html'/(x['pageId']+'.html')).exists() else None
  all_pages.append({k:x.get(k) for k in ['pageId','name','url','status','bytes','htmlFile','snapshotSha256','expected','fetchedAt']})
 for x in anns: all_anns.append(x)
out={'pages':all_pages,'annotations':all_anns}
(root/'data/dataset-annotated-700.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
print('pages',len(all_pages),'annotations',len(all_anns))
