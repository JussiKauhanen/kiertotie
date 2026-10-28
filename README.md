# kiertotie

A small diagram board that takes its diagrams from whatever assistant you are allowed to use. The idea: on a work machine where only Copilot is reachable, Copilot does the thinking and this page does the drawing and editing. No API keys and no calls out: the page is static and everything stays in the browser.

Open it at `https://jussikauhanen.github.io/kiertotie/` once GitHub Pages is on, or locally:

```bash
python3 -m http.server 8130
```

## How a diagram gets in

The page listens on every channel at once and the **Activity** list names the channel each change came from, so a test shows straight away which one works.

| Channel | How | Needs |
| --- | --- | --- |
| **Link** | Copilot writes `…/kiertotie/#m=flowchart LR;web[Web app] --> api[API]` and you click it. `#z=` is the compressed form **Copy link** makes for long diagrams. The diagram is in the `#` part, so it is never sent to GitHub. | Copilot can write links |
| **Paste** | Copy Mermaid from Copilot and paste anywhere on the page. Code fences are fine. | Nothing |
| **Auto-paste** | Turn on **Auto-paste**, copy Copilot's answer, come back to the tab: new diagram text on the clipboard is applied. Text that was already there when you turned it on, plain sentences and the board's own copies are ignored. | Edge allows clipboard reading |
| **Command box** | **Send to diagram** on the right. Also what an agent-mode browser would type into and click. | Nothing |
| **WebMCP (imperative)** | The page registers `get_diagram`, `set_diagram`, `update_diagram` and `remove_items` on `document.modelContext` (or the older `navigator.modelContext`). | A browser with WebMCP on **and** an assistant that calls page tools |
| **WebMCP (declarative)** | The command box is a `<form toolname="send_diagram_text">`. | Same |
| **Page reading** | A hidden text section, *Diagram for assistants*, describes every box, group, link and highlight in plain words. After that come the Mermaid and the same instructions as **Copilot setup**, so the Edge sidebar Copilot learns the link format from the page itself. | Copilot allowed to read the page |

## What works on a locked-down work machine

Tested October 2026 with Edge and Microsoft 365 Copilot, where every other AI domain is blocked:

- **Works:** Copilot in the Edge sidebar reads the board, including highlights, and its "open in Kiertotie" links apply changes when clicked.
- **Doesn't work:** WebMCP. The flag is reset by policy, and Copilot has no interactive browser, so it can't use the command box either.

So the loop is: ask the sidebar Copilot about the open board, then click the link it answers with.

## Tabs

Copilot's links open a new tab, and that tab shows the change. It also has a green **← Back to Copilot** button that closes the tab, so the browser returns to the tab you clicked from. A page can close a tab that a link opened, but it can't bring another tab to the front. If the browser keeps the tab open anyway, the board tells you to press ⌘W or Ctrl+W, which does the same thing. The diagram is saved in the browser, so the next link continues from it, and any other open board tab updates live (its title shows "● Updated" while it's in the background).

Named targets (`target="kiertotie"`) don't help here: they only reach tabs in the same browsing context group, and Copilot's links use `noopener`. Copilot can't be framed either: its sites send `frame-ancestors` and `X-Frame-Options` headers that rule it out. With Copilot in the Edge sidebar there's no tab to return to at all.

## Getting it back out

- **Copy for Copilot** copies the Mermaid plus a line naming what you highlighted, ready to paste back into Copilot with your request.
- **Highlight** (or **M**) and click boxes or group titles to mark them yellow, much like the orim highlighter. Highlights appear in the Mermaid as `class … marked` and in the page readout.
- **Copilot setup** copies a one-time instruction that teaches Copilot the format and the link pattern. Paste it at the start of a Copilot chat.

## Editing

Drag boxes and groups (a group carries its contents). **Shift**-drag from one box to another to link them. Double-click a box, group title or link to edit its text; double-click empty space to add a box. **Delete** removes the selection, **Ctrl/⌘+Z** undoes, **Tidy up** lays everything out again and **F** fits the view. Dragging the empty board pans, and the wheel or pinch zooms. The Mermaid source on the right is live in both directions. The last diagram is kept in this browser.

## Test plan on the work machine

Try these in order and note what the Activity list says each time.

1. Open the Pages URL. If it doesn't load, the domain is blocked and the test stops there. Fallbacks: a raw file share, SharePoint, or a local file (`file://`, where the link channel won't work but paste and the command box will).
2. Paste the **Copilot setup** text into Copilot and ask for a diagram ("how does an AD group end up granting access to an Azure web app?").
   - Does Copilot give a link, and does the link open the diagram? → `link`
   - If the link is mangled, does pasting its code block work? → `paste`
3. Highlight two boxes, click **Copy for Copilot**, paste into Copilot with a change request, and apply its answer. This is the round trip that replaces the built-in AI in orim.
4. With the board open in Edge, ask Copilot in the sidebar about "this page". Can it see the diagram (the readout)? Can it make a change by itself in agent or Actions mode, through the command box?
5. Check **Channels → WebMCP**. "not in this browser" means Edge has no WebMCP here. If it says tools are registered, ask Copilot to use them and look for `webmcp · … called` in the Activity list.

As of October 2026, WebMCP is a draft that has moved from `navigator.modelContext` to `document.modelContext`. Chrome has it in an origin trial and Edge behind a flag, and no mainstream assistant is confirmed to call page tools yet. So steps 2–3 are the realistic path today, and step 5 is there to catch support when it arrives.

## Files

- `index.html`: page structure, including the declarative WebMCP form
- `style.css`: light and dark themes
- `app.js`: Mermaid flowchart subset parser and writer, layered layout with group bands, SVG board, the input channels and WebMCP tools. `window.kiertotie` (`get`, `set`, `update`, `remove`) drives it from the console.
