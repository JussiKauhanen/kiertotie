# kiertotie

A diagram board for an assistant that can only chat. It's built for a work machine where Copilot is the only AI you're allowed, and it works the same with Claude. The assistant does the thinking and answers with a link; the board does the drawing and editing. There's no backend and no API key, and the diagram travels in the `#` part of the link, so it never reaches GitHub.

https://jussikauhanen.github.io/kiertotie/

## The loop

1. **Start:** open Kiertotie and press **Copy starter for Copilot**. Paste it into Copilot (or Claude) and say what you want drawn.
2. **The assistant answers** with one line saying what it drew, an **Open in Kiertotie** link, and a footer saying what to do next. Every answer has the same three parts.
3. **The board opens** in a new tab, showing the assistant's line in a banner. New and changed boxes flash.
4. **You edit:** drag, double-click to rename, Delete to remove, Shift-drag to connect. **Highlight** marks the boxes your next request is about.
5. **Done – back to Copilot** copies the diagram (with your highlights and a short reminder of the reply format), then closes the tab. The browser returns to the chat.
6. **In the chat:** press Ctrl+V (⌘V), type your request and send. Back to step 2.

Every paste carries the reply rules again, so even a long chat doesn't drift from the format.

**With Copilot in the Edge sidebar** you can skip steps 5 and 6. The sidebar reads the open board directly, through a hidden text description that includes the highlights and the reply rules.

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
