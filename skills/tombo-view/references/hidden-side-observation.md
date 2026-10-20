# Hidden-Side Observation

Hidden-Side is an optional ranking comparison alongside TOMBO's standard evidence workflow. It compares similarity, orthogonal-residual, reflected-view and deterministic random-baseline rankings over caller-supplied candidates and vectors. It does not create or verify claims, evidence or resolutions. A low rank is not a discovery.

Keep all vectors from the same embedding model and version. Results are retrieval observations with source locators and `unverified` status; interpretations remain `null`. Only independently checked source material can become ordinary TOMBO evidence. The module accepts vectors and does not generate embeddings or provide a search service.

The fixed `hidden-side-demo` uses a local character n-gram vectoriser and synthetic candidates. A separate live embedding run on 2026-10-16 used one synthetic 28-candidate corpus with no human relevance ratings. In that single run the projection norm was 0.437 and reflected cosine about -0.62. These measurements do not establish semantic usefulness, discovery, generalisation or effectiveness. Do not use the fixed n-gram fixture as evidence about live semantic retrieval.

TOMBO's orthogonal-residual cosine is not CrossRAG's blended Orthogonal score; do not compare or transfer the scores. TOMBO's Wedge method remains unimplemented because its candidates are single phrases rather than ordered pairs.

For the full repository design and experiment record, resolve `docs/hidden-side-observation.md` through `repositoryRoot` from `references/runtime.json` or `TOMBO_ROOT` when that repository is available. This summary is self-contained for an installed skill copy.

## 日本語の要約

Hidden-Sideは標準の証拠確認に添える任意の順位比較であり、claim・evidence・resolutionを作成・検証しない。候補ベクトルは同一embeddingモデル・versionから受け取り、結果はsource locator付きの `unverified` 観測、解釈は `null` のままにする。順位が低いことは発見や根拠ではない。

固定 `hidden-side-demo` はローカル文字n-gramと合成候補を使う。2026-10-16の別の実Embedding実行は、合成28候補・1回・人手関連性評価なしで、射影ノルム0.437、反射cosine約-0.62だった。意味的有用性、発見、一般化、有効性は示さない。固定n-gram例を実Embeddingの証拠として扱わない。

TOMBOのOrthogonalは射影残差のcosineで、CrossRAGの混合Orthogonalスコアとは異なるため比較・移植しない。候補は単一句なのでTOMBOのWedgeは未実装である。詳細な設計・実験記録は、リポジトリが利用できるとき `references/runtime.json` の `repositoryRoot` または `TOMBO_ROOT` から `docs/hidden-side-observation.md` を参照する。
