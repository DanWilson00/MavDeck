# Phase 6: Gridstack Layout Management — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the CSS grid layout in TelemetryView with gridstack.js for drag-and-drop, resizable plot panels with persistent layout.

**Architecture:** Gridstack owns the DOM nodes; SolidJS renders reactive components inside them via `render()`/`dispose()`. Layout positions persist to IndexedDB per tab. Tab switching destroys and recreates the grid instance to avoid idle uPlot memory consumption.

**Tech Stack:** gridstack.js (already installed), idb-keyval (already installed), SolidJS `render()`/`dispose()`, uPlot ResizeObserver integration.

---

## Task 1: Create GridLayout Component Shell

Introduce `GridLayout.tsx` — the gridstack wrapper that manages widget lifecycle. Start with mount/unmount and basic grid initialization without any plot rendering.

**Files:**
- Create: `src/components/GridLayout.tsx`

**Step 1: Write GridLayout.tsx with gridstack init/destroy**

```tsx
// src/components/GridLayout.tsx
import { onMount, onCleanup } from 'solid-js';
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.css';

export default function GridLayout() {
  let containerRef: HTMLDivElement | undefined;
  let grid: GridStack | undefined;

  onMount(() => {
    if (!containerRef) return;
    grid = GridStack.init({
      column: 12,
      animate: true,
      cellHeight: 80,
      margin: 4,
      float: true,
      removable: false,
    }, containerRef);
  });

  onCleanup(() => {
    grid?.destroy(true);
  });

  return (
    <div
      ref={containerRef}
      class="grid-stack"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
```

**Step 2: Verify it compiles**

Run: `npm run build`
Expected: No type errors.

**Step 3: Commit**

```
Phase 6.1: Add GridLayout component shell with gridstack init
```

---

## Task 2: Wire Widget Add/Remove with SolidJS render()

Add `addPlotWidget()` and `removePlotWidget()` functions that use the Gridstack-owns-DOM pattern. Mount `PlotPanel` inside unmanaged DOM nodes via SolidJS `render()`. Track dispose functions in a Map for cleanup.

**Files:**
- Modify: `src/components/GridLayout.tsx`

**Step 1: Add widget lifecycle functions**

Update `GridLayout.tsx` to accept props and manage widgets:

```tsx
// src/components/GridLayout.tsx
import { onMount, onCleanup, createEffect, on } from 'solid-js';
import { render } from 'solid-js/web';
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.css';
import PlotPanel from './PlotPanel';
import type { PlotConfig } from '../models/plot-config';

interface GridLayoutProps {
  plots: PlotConfig[];
  onClose: (plotId: string) => void;
  onOpenSignalSelector: (plotId: string) => void;
  onGridChange: (positions: Map<string, { x: number; y: number; w: number; h: number }>) => void;
}

export default function GridLayout(props: GridLayoutProps) {
  let containerRef: HTMLDivElement | undefined;
  let grid: GridStack | undefined;
  const disposeMap = new Map<string, () => void>();
  // Track which plot IDs are currently mounted as widgets
  const mountedIds = new Set<string>();

  function addPlotWidget(plotConfig: PlotConfig) {
    if (!grid || mountedIds.has(plotConfig.id)) return;

    // 1. Create a plain container div — NOT managed by SolidJS
    const container = document.createElement('div');

    // 2. Let Gridstack own the DOM node
    grid.addWidget({
      el: container,
      x: plotConfig.gridPos.x,
      y: plotConfig.gridPos.y,
      w: plotConfig.gridPos.w,
      h: plotConfig.gridPos.h,
      id: plotConfig.id,
    });

    // 3. Find the .grid-stack-item-content inside the created widget
    const content = container.querySelector('.grid-stack-item-content') as HTMLElement | null;
    const mountTarget = content ?? container;

    // 4. Mount SolidJS component INSIDE the unmanaged node
    const dispose = render(
      () => (
        <PlotPanel
          config={plotConfig}
          onClose={props.onClose}
          onOpenSignalSelector={props.onOpenSignalSelector}
        />
      ),
      mountTarget,
    );

    // 5. Store dispose function for cleanup
    disposeMap.set(plotConfig.id, dispose);
    mountedIds.add(plotConfig.id);
  }

  function removePlotWidget(plotId: string) {
    if (!grid) return;
    const items = grid.getGridItems();
    const el = items.find(item => item.gridstackNode?.id === plotId);
    if (el) grid.removeWidget(el);
    disposeMap.get(plotId)?.();
    disposeMap.delete(plotId);
    mountedIds.delete(plotId);
  }

  onMount(() => {
    if (!containerRef) return;

    grid = GridStack.init({
      column: 12,
      animate: true,
      cellHeight: 80,
      margin: 4,
      float: true,
      removable: false,
    }, containerRef);

    // Listen for layout changes (drag/resize)
    grid.on('change', (_event, nodes) => {
      if (!nodes) return;
      const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
      for (const node of nodes) {
        if (node.id && node.x != null && node.y != null && node.w != null && node.h != null) {
          positions.set(node.id, { x: node.x, y: node.y, w: node.w, h: node.h });
        }
      }
      if (positions.size > 0) {
        props.onGridChange(positions);
      }
    });

    // Mount initial plots
    for (const plot of props.plots) {
      addPlotWidget(plot);
    }
  });

  // React to plots array changes — add new, remove deleted
  createEffect(on(
    () => props.plots.map(p => p.id),
    (currentIds) => {
      if (!grid) return;
      const currentSet = new Set(currentIds);

      // Remove widgets that are no longer in plots
      for (const mountedId of mountedIds) {
        if (!currentSet.has(mountedId)) {
          removePlotWidget(mountedId);
        }
      }

      // Add new widgets
      for (const plot of props.plots) {
        if (!mountedIds.has(plot.id)) {
          addPlotWidget(plot);
        }
      }
    },
    { defer: true },
  ));

  onCleanup(() => {
    // Dispose all SolidJS renders first
    for (const dispose of disposeMap.values()) {
      dispose();
    }
    disposeMap.clear();
    mountedIds.clear();
    grid?.destroy(true);
  });

  return (
    <div
      ref={containerRef}
      class="grid-stack"
      style={{ width: '100%', height: '100%', overflow: 'auto' }}
    />
  );
}
```

**Important note on `addWidget`:** Gridstack v12 `addWidget()` accepts a `GridStackWidget` object. To pass a pre-created DOM element, set the `el` property on the widget options object. Gridstack will use that element as the widget container and apply grid-stack classes to it.

**Step 2: Verify it compiles**

Run: `npm run build`
Expected: No type errors.

**Step 3: Commit**

```
Phase 6.1: Add widget add/remove with SolidJS render()/dispose()
```

---

## Task 3: Wire GridLayout into TelemetryView

Replace the CSS grid `<For>` loop in `TelemetryView.tsx` with `<GridLayout>`. Pass plots, callbacks, and handle grid position changes by updating the store.

**Files:**
- Modify: `src/components/TelemetryView.tsx`

**Step 1: Replace CSS grid with GridLayout**

In `TelemetryView.tsx`, replace the plot grid section (the `<div class="flex-1 overflow-auto p-2">` block) with `<GridLayout>`:

Replace this block (the `{/* Plot grid */}` section, lines ~188–223):
```tsx
        {/* Plot grid */}
        <div class="flex-1 overflow-auto p-2">
          <Show
            when={currentPlots().length > 0}
            fallback={...}
          >
            <div
              class="grid gap-2"
              style={{ 'grid-template-columns': 'repeat(auto-fill, minmax(400px, 1fr))' }}
            >
              <For each={currentPlots()}>
                {(plot) => (
                  <div style={{ height: '300px' }}>
                    <PlotPanel
                      config={plot}
                      onClose={handleClosePlot}
                      onOpenSignalSelector={handleOpenSignalSelector}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
```

With:
```tsx
        {/* Plot grid */}
        <div class="flex-1 min-h-0">
          <Show
            when={currentPlots().length > 0}
            fallback={
              <div class="flex items-center justify-center h-full">
                <div class="text-center">
                  <p class="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    No plots yet
                  </p>
                  <p class="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                    Click a field in the message monitor or use "+ Add Plot"
                  </p>
                </div>
              </div>
            }
          >
            <GridLayout
              plots={currentPlots()}
              onClose={handleClosePlot}
              onOpenSignalSelector={handleOpenSignalSelector}
              onGridChange={handleGridChange}
            />
          </Show>
        </div>
```

Add the `handleGridChange` function and import:

```tsx
import GridLayout from './GridLayout';

// ... inside TelemetryView():

function handleGridChange(positions: Map<string, { x: number; y: number; w: number; h: number }>) {
  const tabIdx = appState.plotTabs.findIndex(t => t.id === appState.activeSubTab);
  if (tabIdx === -1) return;

  for (const [plotId, pos] of positions) {
    const plotIdx = appState.plotTabs[tabIdx].plots.findIndex(p => p.id === plotId);
    if (plotIdx !== -1) {
      setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'gridPos', pos);
    }
  }
}
```

Remove the `For` import if it's no longer used elsewhere in TelemetryView (check — it is still used for time window `<select>` options, so keep it).

Remove the `PlotPanel` import from TelemetryView since GridLayout now handles it.

**Step 2: Verify it compiles**

Run: `npm run build`
Expected: No type errors.

**Step 3: Verify visually with Playwright**

Run: `npm run dev` (background)

```
browser_navigate → http://localhost:5173
browser_snapshot → verify page loads without errors
browser_click → "Connect Spoof"
browser_wait_for → text="HEARTBEAT" (or any message name)
```

Click a field to create a plot, then:
```
browser_snapshot → verify a .grid-stack-item exists
browser_console_messages(level="error") → no JS errors
```

**Step 4: Commit**

```
Phase 6.1: Wire GridLayout into TelemetryView, replace CSS grid
```

---

## Task 4: Layout Persistence with IndexedDB

Save and restore grid positions to IndexedDB so layouts survive page reload.

**Files:**
- Modify: `src/components/TelemetryView.tsx`

**Step 1: Add persistence to TelemetryView**

Add save/restore functions using `idb-keyval`. The layout is keyed per tab.

```tsx
import { get, set } from 'idb-keyval';

const LAYOUT_KEY = 'mavdeck-layout-v1';

interface SavedLayout {
  [tabId: string]: Array<{ id: string; x: number; y: number; w: number; h: number }>;
}

// Inside TelemetryView():

// Save current tab's layout to IndexedDB
async function saveLayout() {
  const saved = (await get<SavedLayout>(LAYOUT_KEY)) ?? {};
  const tabId = appState.activeSubTab;
  const plots = currentPlots();
  saved[tabId] = plots.map(p => ({
    id: p.id,
    x: p.gridPos.x,
    y: p.gridPos.y,
    w: p.gridPos.w,
    h: p.gridPos.h,
  }));
  await set(LAYOUT_KEY, saved);
}
```

Then update `handleGridChange` to also call `saveLayout()`:

```tsx
function handleGridChange(positions: Map<string, { x: number; y: number; w: number; h: number }>) {
  const tabIdx = appState.plotTabs.findIndex(t => t.id === appState.activeSubTab);
  if (tabIdx === -1) return;

  for (const [plotId, pos] of positions) {
    const plotIdx = appState.plotTabs[tabIdx].plots.findIndex(p => p.id === plotId);
    if (plotIdx !== -1) {
      setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'gridPos', pos);
    }
  }

  saveLayout();
}
```

Also restore layout on mount by loading saved positions and applying them to the store before rendering plots. Add to the top-level of TelemetryView:

```tsx
onMount(async () => {
  const saved = await get<SavedLayout>(LAYOUT_KEY);
  if (!saved) return;
  const tabId = appState.activeSubTab;
  const positions = saved[tabId];
  if (!positions) return;

  const tabIdx = appState.plotTabs.findIndex(t => t.id === tabId);
  if (tabIdx === -1) return;

  for (const pos of positions) {
    const plotIdx = appState.plotTabs[tabIdx].plots.findIndex(p => p.id === pos.id);
    if (plotIdx !== -1) {
      setAppState('plotTabs', tabIdx, 'plots', plotIdx, 'gridPos', {
        x: pos.x, y: pos.y, w: pos.w, h: pos.h,
      });
    }
  }
});
```

Add `onMount` to the imports from `solid-js`.

**Step 2: Verify it compiles**

Run: `npm run build`
Expected: No type errors.

**Step 3: Verify persistence with Playwright**

```
browser_navigate → http://localhost:5173
browser_click → "Connect Spoof"
browser_wait_for → text="HEARTBEAT"
```

Click a field to add a plot, then:
```
browser_snapshot → verify gridstack item exists
browser_evaluate → "location.reload()"
browser_wait_for → time=2
browser_snapshot → verify plot panel still present after reload (layout restored)
```

Note: Plot *data* won't persist (ring buffers are in-memory), but the *layout positions* should be restored. The plot panels will show up empty until the spoof reconnects.

**Step 4: Commit**

```
Phase 6.1: Add layout persistence to IndexedDB
```

---

## Task 5: Gridstack CSS Fixes and Theme Integration

Gridstack's default CSS needs overrides to look correct with the MavDeck dark/light theme. The `.grid-stack-item-content` needs to fill its container and not fight with PlotPanel's styling.

**Files:**
- Modify: `src/global.css` (or create a gridstack override section)

**Step 1: Add gridstack style overrides**

Add to `src/global.css`:

```css
/* Gridstack overrides */
.grid-stack-item-content {
  inset: 0;
  overflow: hidden;
}

/* Make grid-stack-item-content fill the item and display flex for PlotPanel */
.grid-stack > .grid-stack-item > .grid-stack-item-content {
  display: flex;
  flex-direction: column;
}

/* Override gridstack placeholder to match theme */
.grid-stack > .grid-stack-placeholder > .placeholder-content {
  border: 1px dashed var(--accent) !important;
  background-color: transparent !important;
}
```

**Step 2: Verify visually with Playwright**

```
browser_navigate → http://localhost:5173
browser_click → "Connect Spoof"
browser_wait_for → text="HEARTBEAT"
```

Add a couple of plots, then:
```
browser_take_screenshot → verify plots render cleanly in grid cells, no overflow issues
```

**Step 3: Commit**

```
Phase 6.1: Add gridstack CSS overrides for theme integration
```

---

## Task 6: Visual and Functional Verification

End-to-end verification of all acceptance criteria using Playwright MCP.

**Files:** None (verification only)

**Step 1: Run all existing tests**

Run: `npx vitest run`
Expected: All tests pass. No regressions.

**Step 2: Run build**

Run: `npm run build`
Expected: No type errors.

**Step 3: Start dev server and verify all acceptance criteria**

Run: `npm run dev` (background)

**Acceptance criteria checklist:**

1. **Plots appear as gridstack items in a 12-column grid**
```
browser_navigate → http://localhost:5173
browser_click → "Connect Spoof"
browser_wait_for → text="HEARTBEAT"
```
Click multiple fields to create plots:
```
browser_snapshot → verify .grid-stack-item elements exist, class="grid-stack" container present
```

2. **Drag to reposition works**
```
browser_take_screenshot → capture before
```
Drag a plot header to a new position (use browser_drag or manually verify the drag handle cursor appears on header).

3. **Resize updates uPlot chart size**
Resize a gridstack item → verify the uPlot canvas resizes (ResizeObserver already handles this in PlotChart.tsx).

4. **Layout persists across page reload**
```
browser_evaluate → "location.reload()"
browser_wait_for → time=2
browser_snapshot → verify plots still in same positions
```

5. **Adding/removing plots updates grid correctly**
Add a new plot → verify it appears in grid.
Close a plot → verify it's removed from grid.

**Step 4: Final commit (if any fixes needed)**

```
Phase 6: Fix [issue] found during verification
```

---

## Notes

- **No `<For>` for grid items**: This is the critical pattern. GridLayout uses `addWidget()` + `render()`, never `<For each={plots}>`.
- **`el` property**: Gridstack v12 `addWidget({ el: container, ... })` uses the `el` property to pass a pre-created DOM element.
- **Grid-stack-item-content**: Gridstack wraps widget content in `.grid-stack-item-content`. We mount PlotPanel into that wrapper.
- **Tab switching**: Currently TelemetryView only has one tab. The grid destroys/creates on mount/unmount naturally through SolidJS `<Show>` — when the active tab changes, the old component unmounts (calling onCleanup), and a new instance mounts. No special tab code needed yet.
- **PlotPanel already handles resize**: `PlotChart.tsx` already has a `ResizeObserver` that calls `chart.setSize()`. When gridstack resizes a widget, the observer fires automatically.
