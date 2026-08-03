# Batch 001 annotation report

- Batch: `batch-001`
- Pages selected: 20
- Pages with raw HTML snapshots: 20
- Pages with rendered HTML snapshots: 6
- Candidate annotations: 38
- Raw snapshot directory: `data/annotation-batches/batch-001/html/`
- Rendered snapshot directory: `data/annotation-batches/batch-001/rendered/`
- Manifest: `data/annotation-batches/batch-001/manifests/sources.json`
- Annotations: `data/annotation-batches/batch-001/manifests/annotations.json`
- Review annotator: `hermes-agent-review-01`

## Labels

| label | count |
|---|---:|
| `current_product` | 20 |
| `historical_product` | 10 |
| `non_product` | 8 |
| `ambiguous` | 0 |

## Noise types

- `os`: 3
- `sdk`: 1
- `build`: 1
- `dependency`: 1
- `svg`: 1
- `asset`: 1

## Source/page types

- Download/product pages: Sublime Text, Total Commander, HeidiSQL, Alfred, GitKraken, Sketch, iTerm2
- Release/changelog pages: Typora, Wireshark, Snipaste, Bandizip, VLC, CleanShot X, Flomo, Insomnia, SQLite
- Structured update feed: Rectangle Pro
- Release directory: BetterTouchTool
- Vendor source page: OpenSSL, Eagle

## Review decisions

- `OrbStack` was fetched and rendered but excluded from accepted annotations because the current homepage did not expose a product version. The PG18 snapshot value was not used as a label.
- The original Apache Kafka URL returned a redirect shell without product evidence, so it was not accepted and was replaced with SQLite.
- `BetterTouchTool` shows a newer current release (`6.692`) than the PG18 snapshot (`6.284`); both current and historical evidence were preserved.
- `GitKraken` rendered page shows `Latest Release: 12.2.1`; the PG18 snapshot (`11.10.0`) was rejected as stale.
- `Sketch` contains current releases, historical releases, minimum macOS versions, and SVG metadata; these were labeled separately.
- `Eagle` separates product version `4.0` from `Build 20`.
- `Alfred` separates product version `5.7.3` from macOS minimum version `10.14`.
- `Insomnia` separates product release `12.4.0` from analytics SDK version `4.16.1`.
- `SQLite` page explicitly marks `3.52.0` as withdrawn; it remains a historical product version, not noise.

## Validation

`python scripts/validate_batch_annotations.py` result:

```text
source_pages 20 annotated_pages 20 annotations 38
errors 0
```
