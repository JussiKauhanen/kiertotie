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

## Releasing

`index.html` loads `style.css?v=…` and `app.js?v=…`. Bump both version strings whenever either file changes. GitHub Pages lets browsers cache files for 10 minutes, and without the bump a new tab can pair the new page with an old script: links then stop working until the cache expires.
