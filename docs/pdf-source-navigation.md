# PDF-to-source navigation

In the editor, a normal click on a rendered PDF page asks the host to resolve that page coordinate through the SyncTeX data belonging to the displayed PDF artifact. A successful lookup opens the mapped project-relative text file, selects the reported line and column, focuses the code editor, and shows the location beside the PDF controls.

Navigation state is intentionally local to each browser window. The source-position HTTP response is returned only to its requester, and the collaboration `open_file` acknowledgement is unicast to that participant. Other connected users may see the participant's active file in presence, but their selected file, cursor, and editor focus are not changed.

Reliability rules:

- Each click carries the rendered PDF artifact ID and version. A response for a replaced artifact is rejected as stale instead of opening the wrong source.
- While a replacement compile is pending, the still-displayed last-good PDF can continue to map against its own SyncTeX data.
- A failed compile that retains a last-good PDF also retains its matching SyncTeX map and labels the navigation as stale context.
- Resolver paths are revalidated against current editable project files before they reach the browser.
- Per-client navigation controllers discard superseded lookups and serialize editor reveals so the latest click wins.
- The host runs `synctex edit` asynchronously without a shell, with a 2.5-second deadline and a 64 KiB combined-output cap. Slow lookups do not block unrelated HTTP requests, collaboration heartbeats, or another participant's lookup.
- The host permits at most four simultaneous SyncTeX processes. Additional clicks receive a visible, retryable busy state, and every timeout, failure, or rejected runner releases its slot.
- Safe HTTPS link annotations are rendered as real links above the PDF page. Normal link clicks open the destination and bypass inverse search; page-area clicks continue to reveal source.

Current limitations:

- A successful PDF compile must produce `.synctex.gz`, and the host must have a usable `synctex` command. Otherwise the UI reports that no source map is available.
- SyncTeX maps source boxes, not arbitrary visual semantics. Blank margins, some generated content, and some embedded graphics may have no editable source location.
- External HTTPS annotations are supported. Internal named-destination links are not yet rendered by the lightweight preview link layer.
- A last-good PDF maps to the source snapshot used for that PDF. If the live project changed after compilation, the reported line is opened in the current file and may have shifted; recompiling refreshes the map.
- This is inverse search only. It does not synchronize selections or cursors between participants and does not replace conflict-safe collaborative editing.
