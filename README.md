# Terminal Dashboard

A modern, web-based terminal management dashboard built entirely with AI assistance. Manage multiple remote terminal sessions from a single browser interface, organized into connections, projects, and custom groups.

Built with **Svelte 5**, **SvelteKit**, **xterm.js**, and **Tailwind CSS**. Connects to [ttyd](https://github.com/nicm/ttyd) servers over WebSocket for real-time terminal access.

## Features

### Terminal Management
- **Hierarchical organization** — Connections → Projects → Terminals, with collapsible tree navigation
- **Multiple simultaneous terminals** — Each terminal runs in its own tmux session
- **Reconnect & clear** — Per-terminal reconnect and screen clear buttons
- **Adjustable font size** — Per-terminal font size controls with live preview
- **Connection status indicators** — Green/red dots show live connection state

### Grid View
- **Multi-terminal grid layout** — View all terminals in a project, group, or pinned set simultaneously
- **Configurable rows & columns** — Set exact grid dimensions or leave on auto-fit
- **Vertical scroll overflow** — Terminals exceeding the grid capacity are accessible by scrolling
- **Per-project grid toggle** — Switch between single and grid view per project or group

### Pinned Terminals
- **Pin any terminal** — Pin button in each terminal's header bar
- **Dedicated Pinned tab** — All pinned terminals shown in a grid, regardless of which connection or project they belong to
- **Quick access** — Jump to any pinned terminal from the sidebar

### Terminal Groups
- **Custom groupings** — Create groups that pull terminals from any connection or project
- **Independent of hierarchy** — Groups are a flat organizational layer on top of the connection tree
- **Grid view per group** — View all group terminals at once

### Saved Commands
- **Per-terminal command library** — Save frequently used commands with labels
- **Auto-execute or inject** — Choose whether a command runs immediately (sends Enter) or just injects the text
- **Send Ctrl+C first** — Optionally kill the current process before running a command
- **On-connect commands** — Auto-run commands when a terminal first connects
- **Quick action buttons** — Saved commands appear as clickable buttons in the terminal header
- **Drag-and-drop reorder** — Rearrange command order in the sidebar

### Sidebar
- **Three tabs** — Connections, Groups, and Pinned
- **Resizable** — Drag the edge to resize between 200–600px
- **Collapsible** — Toggle sidebar visibility from the header
- **Drag-and-drop** — Reorder connections, projects, terminals, groups, and commands
- **Inline controls** — Rename, add, remove, toggle grid view, toggle grid hidden, all from the tree

### Persistence & Portability
- **IndexedDB storage** — All settings saved locally in the browser
- **Export / Import** — Download your full configuration as JSON; import on another machine
- **Includes everything** — Connections, projects, terminals, groups, saved commands, grid settings

### UI
- **Dark theme** — Slate/sky color scheme with a polished, minimal interface
- **Real-time clock** — Displayed in the header
- **Keyboard-friendly dialogs** — Enter to submit, Escape to cancel
- **Responsive grid** — Auto-fit columns with a 400px minimum, or set exact dimensions

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Svelte 5 + SvelteKit |
| Terminal | xterm.js 6 (with fit, web-links addons) |
| Styling | Tailwind CSS 4 |
| Backend | [ttyd](https://github.com/nicm/ttyd) (WebSocket terminal server) |
| Persistence | IndexedDB |
| Build | Vite 7 |
| Language | TypeScript |

## Getting Started

### Prerequisites

- Node.js 18+
- One or more [ttyd](https://github.com/nicm/ttyd) instances running and accessible via WebSocket

### Install & Run

```sh
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in your browser.

### Production Build

```sh
npm run build
npm run preview
```

### Connecting to Terminals

1. Click **Add Connection** in the sidebar
2. Enter a name and the WebSocket URL of your ttyd server (e.g., `ws://localhost:7681`)
3. Add a project, then add terminals within it
4. Click a terminal in the sidebar to open it

## Project Structure

```
src/
├── routes/
│   └── +page.svelte            # Main application UI
├── lib/
│   ├── components/
│   │   └── Terminal.svelte      # xterm.js terminal wrapper
│   ├── connectionManager.ts     # WebSocket connection pool
│   ├── stores.svelte.ts         # Reactive state & persistence
│   └── db.ts                    # IndexedDB abstraction
```

## Built With AI

This project was built entirely through AI-assisted development.
