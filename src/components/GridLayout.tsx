import { onMount, onCleanup, createEffect, on, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.css';
import PlotPanel from './PlotPanel';
import type { PlotConfig } from '../models/plot-config';
import type { PlotInteractionController } from '../core/plot-interactions';

interface GridLayoutProps {
  plots: PlotConfig[];
  onClose: (plotId: string) => void;
  onOpenSignalSelector: (plotId: string) => void;
  onGridChange: (positions: Map<string, { x: number; y: number; w: number; h: number }>) => void;
  selectedPlotId: string | null;
  onSelectPlot: (plotId: string) => void;
  onClearSignals: (plotId: string) => void;
  interactionGroupId: string;
  interactionController: PlotInteractionController;
}

export default function GridLayout(props: GridLayoutProps) {
  let containerRef: HTMLDivElement | undefined;
  let grid: GridStack | undefined;
  const disposeMap = new Map<string, () => void>();
  const mountedIds = new Set<string>();

  function addPlotWidget(plotConfig: PlotConfig) {
    if (!grid || !containerRef || mountedIds.has(plotConfig.id)) return;

    // Create the grid-stack-item wrapper with required classes and gs-* attributes
    const wrapper = document.createElement('div');
    wrapper.classList.add('grid-stack-item');

    // Create the content div inside (required by gridstack)
    const content = document.createElement('div');
    content.classList.add('grid-stack-item-content');
    wrapper.appendChild(content);

    // Append to grid element, then let gridstack adopt it via makeWidget
    containerRef.appendChild(wrapper);
    grid.makeWidget(wrapper, {
      x: plotConfig.gridPos.x,
      y: plotConfig.gridPos.y,
      w: plotConfig.gridPos.w,
      h: plotConfig.gridPos.h,
      id: plotConfig.id,
    });

    // Mount SolidJS component into the content div.
    // Capture only the stable ID — look up the live config reactively from
    // props.plots so that store updates (e.g. adding a signal) propagate.
    const plotId = plotConfig.id;
    const dispose = render(
      () => {
        const config = () => props.plots.find(p => p.id === plotId);
        return (
          <Show when={config()}>
            {(c) => (
              <PlotPanel
                config={c()}
                onClose={props.onClose}
                onOpenSignalSelector={props.onOpenSignalSelector}
                isSelected={() => props.selectedPlotId === plotId}
                onSelect={() => props.onSelectPlot(plotId)}
                onClearSignals={() => props.onClearSignals(plotId)}
                interactionGroupId={props.interactionGroupId}
                interactionController={props.interactionController}
              />
            )}
          </Show>
        );
      },
      content,
    );

    disposeMap.set(plotConfig.id, dispose);
    mountedIds.add(plotConfig.id);
  }

  function removePlotWidget(plotId: string) {
    if (!grid) return;
    // Dispose SolidJS root FIRST so cleanups run against live DOM
    disposeMap.get(plotId)?.();
    disposeMap.delete(plotId);
    // Then remove the DOM node from gridstack
    const items = grid.getGridItems();
    const el = items.find(item => item.gridstackNode?.id === plotId);
    if (el) grid.removeWidget(el);
    mountedIds.delete(plotId);
  }

  onMount(() => {
    if (!containerRef) return;

    grid = GridStack.init({
      column: 12,
      animate: false,
      cellHeight: 80,
      margin: 4,
      float: true,
      removable: false,
    }, containerRef);

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

    for (const plot of props.plots) {
      addPlotWidget(plot);
    }

    // Enable animations after initial layout settles so drag/drop animates
    // but mount doesn't cause visual noise on tab switch.
    requestAnimationFrame(() => {
      grid?.el?.classList.add('grid-stack-animate');
    });
  });

  createEffect(on(
    () => props.plots.map(p => p.id),
    (currentIds) => {
      if (!grid) return;
      const currentSet = new Set(currentIds);

      // Remove widgets that are no longer in the plots list
      for (const mountedId of [...mountedIds]) {
        if (!currentSet.has(mountedId)) {
          removePlotWidget(mountedId);
        }
      }

      // Add widgets that are new
      for (const plot of props.plots) {
        if (!mountedIds.has(plot.id)) {
          addPlotWidget(plot);
        }
      }
    },
    { defer: true },
  ));

  onCleanup(() => {
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
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
    />
  );
}
