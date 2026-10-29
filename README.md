# kiertotie

A diagram board for an assistant that can only chat. It's built for a work machine where Copilot is the only AI you're allowed, and it works the same with Claude. The assistant does the thinking and answers with a link; the board does the drawing and editing. There's no backend and no API key, and the diagram travels in the `#` part of the link, so it never reaches GitHub.

https://jussikauhanen.github.io/kiertotie/

## The loop

1. **Start:** open Kiertotie, pick your assistant (Microsoft 365 Copilot, Copilot, ChatGPT, Claude, Gemini or another chat), optionally type what to draw, and press **Start with …**. That click copies the instructions and floats the board. The floating board then shows **Open …** for your chat, with a simple picture of that chat window and arrows to where you paste, send and click. (The browser only lets one click open one window, and the float takes that one.) In the chat, press Ctrl+V (⌘V) and send.
2. **The assistant answers** with one line saying what it drew, an **Open in Kiertotie** link, and a short footer. Click the link. The floating board updates, the link's tab closes itself, and you stay in the chat.
3. **Edit** on the board if you like: drag, double-click to rename, Delete to remove, Shift-drag to connect. **Highlight** marks the boxes your request is about.
4. **Type your next request** at the bottom of the board and press Enter or **Send to …**. Then paste it into the chat and send. Back to step 2.

Only the first paste carries the instructions. Later pastes carry the diagram, your highlights, the request and one line, "Reply in the same Kiertotie format".

The banner at the top shows the assistant's line about what changed, and warns when part of a link couldn't be read. A line that doesn't read to the end is skipped completely.

Colours work the Mermaid way: `style web fill:#dbeafe,stroke:#2563eb`, or `classDef blue …` plus `class web,api blue`. Text switches between dark and light to stay readable on the fill.

The assistant you pick is remembered. Change it under **More**. It only sets the names on the buttons and which chat **Start** opens; the links work the same with any chat.

## Floating board (Chrome and Edge)

**Start** floats the board for you. **⧉ Float** does it later, for example on a tab that a link opened. The board moves into a small window that stays on top of every other window (Document Picture-in-Picture), so it stays in view while you work in the chat. A link tab hands its diagram to the floating board and closes itself, and the browser returns you to the chat.

Keep the Kiertotie tab open (in the background is fine), because closing it closes the floating board. **Bring it back here** in that tab, or closing the floating window, puts the board back in the tab. If no floating board is open, a link tab becomes the board, and **Send** closes that tab again.

**With Copilot in the Edge sidebar** you can skip the paste in step 4: just ask. The sidebar reads the open board directly, through a hidden text description that includes the highlights and the reply rules.

## Details

- The link is `#note=<the assistant's line>&m=<the whole diagram as Mermaid>`, percent-encoded, with `;` between lines. The assistant always sends the whole diagram. Boxes you moved by hand keep their place if they're still in it.
- A shape that's missing its closing bracket at the end of the link is still read, because chat apps often cut a trailing `]` or `)` off a link.
- If a link comes out broken, paste the diagram text anywhere on the board instead.
- The diagram is kept in the browser. Open board tabs update each other live.
- **More** holds Tidy up, Fit, Copy starter, Show source and activity (the Mermaid editor and a log of changes), and Start a new diagram.

## Drawing by hand

The rail on the left adds things; click a tool, then click the board.
- **Sticky note** (N), **Text** (T), **Shapes** (R): box, rounded, pill, circle, decision, database and hexagon.
- **Frame:** a group you can drop boxes into. Drag a box in or out of it to change its group. Boxes already under a new frame join it.
- **Icons** (I): the Azure, Power Platform and Dynamics 365 icons from orim, with search.

Select something to get its toolbar:
- **Boxes and frames:** colour, shape, highlight and delete.
- **Lines:** straight, curved or elbow, solid, dotted or thick, and the arrow head.

A selected box has four dots: drag one onto another box to link them, or onto empty board for a new linked box. The corner square resizes boxes and frames, and the text wraps to fit.

In Mermaid, icons are `kv@{ icon: "azure:key-vaults", label: "Secrets" }`, text is `t1@{ shape: text, label: "…" }` and sticky notes are `n1["…"]:::sticky`. The assistant's instructions teach it all three. When an assistant gets an icon name slightly wrong, the board picks the closest match, for example `azure:key-vault` finds `azure:key-vaults`. Positions, sizes, line routes, zones, tables, docs, images, ink and comments are saved as `%% @…` canvas lines, which Mermaid ignores.

## Editing

- **Select:** drag on empty board, or inside a frame, to select everything the rectangle touches. Shift-click adds or removes items, and Ctrl+A selects all. A frame is picked up by its title bar.
- **Pan:** two fingers on a trackpad, the scroll wheel, Space-drag or the middle mouse button.
- **Several items:** move, colour, align (left, centre, right, top, middle, bottom), space evenly, put in a frame, or delete them together.
- **Keys:** Ctrl+C / X / V copy, cut and paste, also between boards. Ctrl+D duplicates. Arrow keys nudge (Shift for 10). Ctrl+Z undoes and Ctrl+Shift+Z or Ctrl+Y redoes. V select, N note, T text, R shape, P pen, C comment, I icons, M highlight, F fit.
- A copied selection also lands on the clipboard as Mermaid, so you can paste part of a board into the chat.
- **Snap to grid** and the **Minimap** are on by default; switch them off in More. Alt-drag moves freely.

## Architecture

- **Zones:** frames for kinds of boundary: Internet, On-premises, Management group, Azure subscription, Resource group, Virtual network, Subnet, Perimeter / DMZ, Power Platform environment and External system. Each has its own colour, line style and title icon. A frame whose title names a kind, such as "Resource group: prod" or "VNet", becomes that zone by itself. A selected frame's toolbar sets the kind by hand.
- **Line types:** a selected line's toolbar has HTTPS, sign-in / token, private link, VPN / ExpressRoute, event, two-way sync and SQL. Each sets the style, colour and label. Lines can also take one of seven colours; they're saved as Mermaid `linkStyle` lines.
- **Flow steps:** **More → Number the steps** puts ① ② ③ on the line labels in flow order, or only on the selected line. **Add a step legend** makes a table of the steps next to the diagram and updates it when run again.

## More kinds of content

- **Shapes** now include a table, a doc (a card with a title and longer text), a phone screen and a browser window. Double-click a table to edit it as lines of cells split by `|`. Double-click a doc to edit its title line and text.
- **Images:** paste a picture or drop one on the board. It's shrunk to at most 1200 pixels and kept with the board. Share links leave images out, since they would make the link too long.
- **Pen, highlighter, arrow and eraser** are under the pencil on the rail. Ink can be selected, moved, recoloured and deleted like anything else.
- **Comments:** a numbered pin with text that shows on hover. Comments, doc text and tables travel to the chat in the Send packet, below the diagram. Exports leave comments out.

## Files

- **Download for draw.io:** a `.drawio` file. Frames become containers, boxes keep their shapes and colours, icons and images come along, and lines keep their routes. Pen drawings and comments stay on the board.
- **Download this board (.mmd):** Mermaid with a title line, plus the canvas lines that keep the layout.
- **Save all boards to a folder…:** one `.mmd` per board, in a folder you pick (Chrome and Edge).
- **Open files…**, or drop files on the board: `.mmd`, `.mermaid`, `.md` and `.txt` files open as new boards, and pictures go onto the current one.

## Boards, templates and styles

- **Boards:** click the board name next to Kiertotie, or **More → Boards…**, to see every board saved in this browser. From there you can make a new board, open, rename, duplicate or delete one. A new tab, and a link from the chat, open on the board you used last. Boards live in this browser only; a share link moves one to another computer.
- **Templates:** the rail's grid button, **More → Templates…** or the start card. There are five architecture templates (Azure web app, event-driven orders, Power Platform, field inspections, analytics), an approval flowchart, and five workshop boards: retrospective, kanban, start/stop/continue, SWOT and brainstorm. An empty board takes the template; otherwise it opens as a new board.
- **Board styles:** **More → Board style:** Classic, Pastel, Midnight, Blueprint and Sketch. Classic follows day and night; the others keep their own canvas colours. Pastel and Midnight give each top-level frame its own colour. The style is saved per board as `%% @theme <name>`.

## Share and export

**More** has these:
- **Share link and QR code:** a compressed `#z=` link that carries the whole diagram, including colours and boxes moved by hand, plus a QR code when the link is short enough. Nothing is uploaded.
- **Download PNG** (at 2×) and **Download SVG:** the board with its current day or night colours written into the file.
- **Copy as Mermaid:** the plain Mermaid source.

Assistants keep writing plain `#m=` links, because they can't compress reliably. The board reads both kinds.

The QR code uses [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT), in `vendor/qrcode.js`.

## Floating window size

The browser remembers where you last put the floating board. **Reset its size and place** in the Kiertotie tab reopens it at the default size and position.

## Limits we found (October 2026)

- **WebMCP:** no use here. It's a draft API behind a flag, Edge resets the flag by policy on the work machine, and no assistant calls page tools yet.
- **Copilot acting on the page:** it has no interactive browser, so it can't click or type on the board.
- **Bringing the Copilot tab to the front:** a page can't do that. Named targets only reach related tabs, and Copilot's links use `noopener`. What a page can do is close a tab that a link opened, which is how Done works.
- **Framing:** the Copilot sites send `frame-ancestors` and `X-Frame-Options` headers that rule out embedding them, and chat can't embed the board either.
- **Sharing storage:** localStorage, IndexedDB and BroadcastChannel are per site, so Copilot's pages can't read the board's data.

## Files

- `index.html`: toolbar, start screen, banner and the hidden panel
- `style.css`: light and dark themes
- `app.js`: Mermaid flowchart subset parser and writer, layered layout with group bands, SVG board and editing, the link and Done loop, and the starter text
- `vendor/icons.json`: the icon pack, loaded the first time a board needs an icon. See `THIRD_PARTY_NOTICES.md`.
- `vendor/qrcode.js`: the QR code generator

## Releasing

`index.html` loads `style.css?v=…` and `app.js?v=…`. Bump both version strings whenever either file changes. GitHub Pages lets browsers cache files for 10 minutes, and without the bump a new tab can pair the new page with an old script: links then stop working until the cache expires.
