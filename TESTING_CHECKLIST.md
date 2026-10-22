Final Testing Checklist
Record results on your own machine. Mark each checkbox only after verifying it.
Build and tests
- [ ] npm.cmd run build completes without errors.
- [ ] npm.cmd test passes.
- [ ] npm.cmd run dev starts the app.
- [ ] Browser console shows no new errors during the demonstration.
Challenge 1 — Selection and fill
- [ ] Drag across A1:B3: rectangular range highlights.
- [ ] Shift+click extends the selection.
- [ ] Enter 1 and 2 in A1:A2; fill to A5 gives 3, 4, 5.
- [ ] Fill a formula down and verify its relative references change correctly.
- [ ] Releasing the fill handle outside the grid does not leave it stuck.
- [ ] Undo a fill operation and confirm expected behavior.
Challenge 2 — Sort/filter
- [ ] Sort numeric scores ascending and descending.
- [ ] Filter names with a case-insensitive substring.
- [ ] Hide empty rows, then reset view.
- [ ] Check source row numbers and formulas remain associated with original data.
Challenge 3 — Virtualization
- [ ] Load Sample 3k and scroll to the middle and bottom.
- [ ] Mounted row count is much smaller than the visible row total.
- [ ] No blank gaps or overlapping rows during scrolling.
- [ ] Edit a cell after scrolling and confirm the correct row was updated.
- [ ] Apply a filter and scroll the resulting view.
Challenge 4 — Ask the Sheet
- [ ] sum column B reports a result.
- [ ] average column B and count column A work.
- [ ] sort column B descending changes the view.
- [ ] filter column A for Alice filters the view (using matching test data).
- [ ] reset view restores all rows.
- [ ] Unsupported input gives a helpful message rather than crashing.
Challenge 5 — Formatting
- [ ] 1250.5 with Currency (USD) displays $1,250.50.
- [ ] 0.25 with Percentage displays 25.0%.
- [ ] A1:B3 Highlight range changes all six cells.
- [ ] A1:B3 All borders applies visible borders.
- [ ] Clear formatting restores default appearance but retains values.
- [ ] Formula results remain numerically correct after formatting.
Submission hygiene
- [ ] Final src/App.jsx is the working Challenge 5 version.
- [ ] Final src/engine/core.js is the working fill-enabled version.
- [ ] README matches the actual implementation and limitations.
- [ ] No secrets, API keys, or private credentials are committed.
- [ ] git status reviewed; changes committed.
- [ ] Repository link and demo recording ready, if required by the challenge.