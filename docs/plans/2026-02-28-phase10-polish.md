# Phase 10: Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Polish the UI with theme-aware chart styling, keyboard shortcuts, loading states, responsive sidebar, and custom dialect import.

**Architecture:** Mostly independent CSS/component changes. Chart grid colors become theme-aware via CSS variables. Keyboard shortcuts use a global `keydown` listener in App.tsx. Sidebar gets a collapse toggle. Dialect import uses existing `parseFromFileMap()` with a file input.

**Tech Stack:** SolidJS, uPlot, existing CSS variable system, browser File API.

---

## Task 1: Theme-Aware Chart Grid and Axis Colors

PlotChart.tsx hardcodes grid `#333` and axis `#888`. Make them theme-aware using CSS variables.

**Files:**
- Modify: `src/global.css`
- Modify: `src/components/PlotChart.tsx`

**Step 1: Add chart CSS variables to global.css**

Add to the `:root` (dark) block:
```css
  --chart-grid: rgba(255, 255, 255, 0.06);
  --chart-axis: #888;
```

Add to the `.light` block:
```css
  --chart-grid: rgba(0, 0, 0, 0.08);
  --chart-axis: #666;
```

**Step 2: Update PlotChart.tsx to read CSS variables**

Replace hardcoded colors in the uPlot options with a helper that reads computed CSS variables:

```typescript
function getChartColors(): { grid: string; axis: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    grid: style.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.06)',
    axis: style.getPropertyValue('--chart-axis').trim() || '#888',
  };
}
```

Use these in the axes config where `#333` and `#888` are currently hardcoded. Also recreate the chart when the theme changes (since uPlot doesn't support dynamic option updates).

Add a `createEffect` that watches `appState.theme` and recreates the chart:

```typescript
import { appState } from '../store/app-store';

createEffect(() => {
  // Track theme changes
  const _theme = appState.theme;
  // Recreate chart with new colors on next tick
  if (chart) {
    chart.destroy();
    chart = createChart();
  }
});
```

**Step 3: Verify**

Run: `npm run build` — no errors
Run: `npx vitest run` — all pass

**Step 4: Commit**

```
Phase 10.1: Make chart grid and axis colors theme-aware
```

---

## Task 2: Keyboard Shortcuts

Add global keyboard shortcuts: Space for pause/resume, Escape for deselect.

**Files:**
- Modify: `src/App.tsx`

**Step 1: Add keyboard listener in App.tsx**

Inside the App component, add an `onMount`/`onCleanup` pair for keyboard handling:

```typescript
onMount(() => {
  function handleKeyDown(e: KeyboardEvent) {
    // Don't handle shortcuts when typing in inputs
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    switch (e.key) {
      case ' ': {
        e.preventDefault();
        if (appState.connectionStatus !== 'connected') return;
        if (appState.isPaused) {
          connectionManager.resume();
          setAppState('isPaused', false);
        } else {
          connectionManager.pause();
          setAppState('isPaused', true);
        }
        break;
      }
    }
  }

  window.addEventListener('keydown', handleKeyDown);
  onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
});
```

Note: This needs to be a SEPARATE `onMount` from the existing async one (which does settings/dialect loading). The keyboard listener should be set up immediately, not after async loading.

**Step 2: Verify**

Run: `npm run build`
Run: `npx vitest run`

**Step 3: Commit**

```
Phase 10.2: Add keyboard shortcuts (Space for pause/resume)
```

---

## Task 3: Loading State

Show a loading indicator while the dialect JSON loads and the worker initializes.

**Files:**
- Modify: `src/App.tsx`

**Step 1: Add loading state**

Add a `loading` signal and show a centered spinner/message while `isReady` is false:

```typescript
const [loading, setLoading] = createSignal(true);

// In onMount, after init completes:
setLoading(false);

// In JSX, wrap the main content:
<Show when={!loading()} fallback={
  <div class="flex items-center justify-center h-screen" style={{ 'background-color': 'var(--bg-primary)' }}>
    <div class="text-center">
      <div class="text-lg font-medium" style={{ color: 'var(--text-primary)' }}>MavDeck</div>
      <div class="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>Loading dialect...</div>
    </div>
  </div>
}>
  {/* existing app content */}
</Show>
```

**Step 2: Verify**

Run: `npm run build`
Run: `npx vitest run`

**Step 3: Commit**

```
Phase 10.3: Add loading state while dialect initializes
```

---

## Task 4: Custom Dialect Import

Add a file picker button in the toolbar to import custom `.xml` MAVLink dialect files.

**Files:**
- Modify: `src/components/Toolbar.tsx`

**Step 1: Add dialect import handler and button**

The XML parser already exists at `src/mavlink/xml-parser.ts` with `parseFromFileMap()`. However, looking at the architecture, the registry is initialized in the worker. For a custom dialect, we need to:

1. Read the XML file on the main thread
2. Parse it to JSON using the XML parser
3. Re-initialize the worker with the new dialect

Actually — the simpler approach: read the file, parse to JSON string, call `workerBridge.init(jsonString)` to reinitialize the worker's registry.

Add to Toolbar.tsx:

```typescript
import { workerBridge, registry } from '../store/app-store';
import { parseFromFileMap } from '../mavlink/xml-parser';

let fileInputRef: HTMLInputElement | undefined;

function handleDialectImport() {
  fileInputRef?.click();
}

async function handleFileSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  input.value = ''; // reset for re-import

  try {
    const text = await file.text();
    // Create a file map with single entry
    const fileMap = new Map<string, string>();
    fileMap.set(file.name, text);
    const parsed = parseFromFileMap(fileMap, file.name);
    const jsonString = JSON.stringify(parsed);

    // Reinitialize worker with new dialect
    await workerBridge.init(jsonString);

    // Update main-thread registry too
    registry.loadFromJsonString(jsonString);
  } catch (err) {
    console.error('[Dialect Import]', err);
  }
}
```

Add to JSX (near the theme toggle):

```tsx
<button
  onClick={handleDialectImport}
  class="p-1.5 rounded transition-colors"
  style={{
    'background-color': 'var(--bg-hover)',
    color: 'var(--text-secondary)',
  }}
  title="Import custom dialect XML"
>
  <UploadIcon />
</button>
<input
  ref={fileInputRef}
  type="file"
  accept=".xml"
  class="hidden"
  onChange={handleFileSelected}
/>
```

Add a simple upload icon SVG function.

**Step 2: Verify**

Run: `npm run build`
Run: `npx vitest run`

**Step 3: Commit**

```
Phase 10.4: Add custom dialect XML import button
```

---

## Task 5: Responsive Sidebar Collapse

Add a toggle to collapse the MessageMonitor sidebar to save horizontal space.

**Files:**
- Modify: `src/components/TelemetryView.tsx`
- Modify: `src/components/MessageMonitor.tsx`

**Step 1: Add collapsed state to TelemetryView**

```typescript
const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
```

Pass to MessageMonitor:
```tsx
<MessageMonitor
  onFieldSelected={handleFieldSelected}
  collapsed={sidebarCollapsed()}
  onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
/>
```

**Step 2: Update MessageMonitor to support collapsed mode**

When collapsed, show only a thin vertical bar with a toggle button. When expanded, show the full sidebar as-is.

```tsx
// In MessageMonitor props:
interface MessageMonitorProps {
  onFieldSelected: (messageName: string, fieldName: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

// In JSX:
<Show when={!props.collapsed} fallback={
  <div class="flex flex-col items-center py-2 border-r"
    style={{ width: '40px', 'background-color': 'var(--bg-panel)', 'border-color': 'var(--border)' }}>
    <button onClick={props.onToggleCollapse} title="Expand sidebar">
      <ChevronRightIcon />
    </button>
  </div>
}>
  {/* existing sidebar content with collapse button in header */}
</Show>
```

Add a collapse button to the existing sidebar header.

**Step 3: Verify**

Run: `npm run build`
Run: `npx vitest run`

**Step 4: Commit**

```
Phase 10.5: Add collapsible sidebar toggle to MessageMonitor
```

---

## Task 6: Playwright Visual Verification

Verify all polish changes via Playwright MCP.

**Files:** None (verification only)

**Step 1: Start dev server**

Run: `npm run dev` (background)

**Step 2: Verify theme-aware chart colors**

```
browser_navigate → http://localhost:5173
browser_click → "Connect Spoof"
browser_wait_for → time=3
browser_take_screenshot → verify dark theme chart styling
browser_click → theme toggle
browser_wait_for → time=1
browser_take_screenshot → verify light theme chart styling
browser_click → theme toggle (back to dark)
```

**Step 3: Verify keyboard shortcuts**

```
browser_press_key → " " (space)
browser_snapshot → verify paused state
browser_press_key → " " (space)
browser_snapshot → verify resumed
```

**Step 4: Verify loading state**

Navigate fresh (disconnect first):
```
browser_click → "Disconnect"
browser_navigate → http://localhost:5173 (hard reload)
— loading state should flash briefly (may be too fast to capture)
browser_snapshot → verify app loaded normally
```

**Step 5: Verify sidebar collapse**

```
browser_snapshot → find collapse toggle button
browser_click → collapse button
browser_snapshot → verify sidebar collapsed
browser_click → expand button
browser_snapshot → verify sidebar expanded
```

**Step 6: Verify dialect import button exists**

```
browser_snapshot → verify upload/import button in toolbar
```

**Step 7: Check console for errors**

```
browser_console_messages(level="error") → no JS errors
```

**Acceptance criteria:**

| Criterion | Verification |
|-----------|-------------|
| Chart grids change with theme | Screenshots in dark + light |
| Space pauses/resumes | Keyboard test |
| Loading state shown | App renders loading briefly |
| Dialect import button exists | Snapshot |
| Sidebar collapses | Toggle test |
| No JS errors | Console check |

---

## Notes

- **Task 10.2 (dark glow effects) and 10.3 (light trace colors) from PLAN.md**: Deferred — the CSS variable approach in Task 1 handles the grid/axis. Glow effects and alternate trace colors are aesthetic polish that can be added incrementally.
- **Font (D-DIN)**: Deferred — requires font files or CDN link. System monospace is adequate for now.
- **uPlot theme switching**: uPlot doesn't support dynamic option updates. Must destroy and recreate the chart when theme changes.
