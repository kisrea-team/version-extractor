# Batch 003 annotation report

- Pages selected: 20
- Raw HTML snapshots: 20
- Rendered HTML snapshots: 9
- Candidate annotations: 32
- Validation: passed with 0 errors

## Labels

| label | count |
|---|---:|
| `current_product` | 14 |
| `historical_product` | 10 |
| `non_product` | 2 |
| `ambiguous` | 6 |

## Key evidence decisions

- Audio Hijack current `4.5.9`, historical `4.5.6`.
- LightPDF current `2.0.0`, historical `1.6.0`.
- TablePlus current `26.8.6` with internal build `752` labeled `non_product/build`.
- IntelliJ IDEA current `2026.2`, historical `2025.3`; PG18 `2025.3` snapshot is stale.
- Ableton Live current `12.4.3`, historical `12.3.6`.
- Zeplin current `10.1.0`, historical `4.10.2`.
- Zotero current `9.0.6`, historical `9.0.5`; PG18 `8.0.4` snapshot is stale.
- Kdenlive current `25.12.3`.
- Krita current `5.3.3` and `6.0.3` (separate lines), historical `5.3.2.1`.
- Draw Things current `1.20260330.0`.
- Sublime Merge bundled Git `2.50.1` labeled `non_product/dependency`.
- Fork current `2.69`, historical `2.68`.
- Augment Code current `0.29.0` (Auggie CLI).
- VMware Workstation: `17.0` kept as historical selector value; `25H2U1` held ambiguous.
- MongoDB Compass current `1.49.12`, historical `1.48.2`.
- MacWhisper, Shutter Encoder, Beautiful.ai, 钉钉 DingTalk, Scrivener held ambiguous; no verified product version in saved or rendered pages.
- Cinema 4D official support page was HTTP 403; the failed fetch was recorded and the page was replaced with MongoDB Compass.

## Validation output

```text
source_pages 20 annotated_pages 20 annotations 32 errors 0
labels {'current_product': 14, 'ambiguous': 6, 'non_product': 2, 'historical_product': 10}
```
