# Changelog

## 0.2.0 (fork)

Fork of [tastynoob/dsh-progress-summary](https://github.com/tastynoob/dsh-progress-summary) (MIT).
No downstream PRs; this fork is maintained standalone.

- **Inline mode**: the summary is merged into the Chat running status line
  (`深度求索中，<摘要>，用时 X 分 X 秒 ···`) instead of rendering a second row above the
  composer. The native label is hidden only while a summary is visible and is restored
  otherwise.
- **Width-aware length**: the summary is fitted to the running row's usable width, hard-capped
  at 20 CJK-character units. Narrow rows (under 420 px, e.g. phones) drop the
  `深度求索中，` prefix.
- **Display-only compaction**: filler openers (`目标是` / `正在` / `现在`…) are stripped and
  only the first clause is kept; the full line stays available as the hover title.
- **Native look preserved**: the trailing `···` and the elapsed time come from the native
  label, so the line keeps ticking without a second clock.
- Pure helpers (`compactSummary`, `displayUnits`, `fitSummary`, `parseLabel`,
  `composeRunningLine`) are exported as `inline` and covered by `test/inline.test.mjs`.
