# Batch 002 annotation report

- Pages selected: 20
- Raw HTML snapshots: 20
- Rendered HTML snapshots: 10
- Candidate annotations: 33
- Validation: passed with 0 errors
- Manifest: `data/annotation-batches/batch-002/manifests/sources.json`
- Annotations: `data/annotation-batches/batch-002/manifests/annotations.json`

## Labels

| label | count |
|---|---:|
| `current_product` | 9 |
| `historical_product` | 9 |
| `non_product` | 5 |
| `ambiguous` | 10 |

## Noise types

- `svg`: 1
- `sdk`: 2
- `date`: 1
- `build`: 2

## Evidence highlights

- Charles current `5.2`, historical `5.0.3`; Java `25.0.3` labeled SDK noise.
- RunJS installer URL directly identifies `4.1.0`; SVG viewBox `122.88` labeled SVG noise.
- RescueTime current `3.2.12.3` and historical `3.2.12.2` were taken from the official release notes, not the PG18 snapshot.
- 坚果云 official JSON exposes platform-specific `stVer` and `exVer`; these were preserved as product versions with platform context.
- Lark internal `hera-project-version` was separated from visible update content.
- Mimestream current `1.10.6` and historical `1.10.5` were confirmed from release notes.
- Blender current major `5.2` and historical `5.1` were retained; exact patch was not inferred.
- KeePass current `2.61.1` and historical `2.60` were taken from the official homepage.
- Tasker current `v6.6` and historical `v6.5` were taken from the official changes page.
- FFmpeg current `8.1` and historical `8.0` were taken from the official release announcements.
- Trae, Runway, Fireflies.ai, Amie, Screen Studio, Webflow, Framer, Claude Desktop and Setapp include ambiguous records where page evidence was insufficient; PG18 values were not promoted to truth.
- Enpass was unreachable with the initial HTTP fetch and was replaced by FFmpeg; the failed fetch remains outside the accepted annotation set.

## Validation output

```text
source_pages 20 annotated_pages 20 annotations 33 errors 0
labels {'current_product': 9, 'ambiguous': 10, 'historical_product': 9, 'non_product': 5}
noise {'svg': 1, 'sdk': 2, 'date': 1, 'build': 2}
```
