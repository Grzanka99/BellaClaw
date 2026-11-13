/** @jsxImportSource hono/jsx/dom */
import type { TOption } from "@bellaclaw/shared";
import type { ForceGraph3DInstance, NodeObject } from "3d-force-graph";
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { TFactNode, TFactsResponse } from "../api-types";
import { api, chatPath } from "./api";

const MAX_LABEL_LENGTH = 80;

export function FactsTab({ chatId }: { chatId: string }) {
  const [facts, setFacts] = useState<TOption<TFactsResponse>>(undefined);
  const [error, setError] = useState<TOption<string>>(undefined);
  const [selected, setSelected] = useState<TOption<TFactNode>>(undefined);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<TFactsResponse>("GET", chatPath(chatId, "facts")).then((result) => {
      if ("error" in result) {
        setError(result.error);
      } else {
        setFacts(result.data);
      }
    });
  }, []);

  useEffect(() => {
    const element = container.current;

    if (facts === undefined || element === null) {
      return;
    }

    let graph: TOption<ForceGraph3DInstance>;
    let disposed = false;
    const observer = new ResizeObserver(() => {
      graph?.width(element.clientWidth).height(element.clientHeight);
    });

    // NOTE: a chunk of its own. three.js is far larger than the rest of the client.
    void import("3d-force-graph").then(({ default: ForceGraph3D }) => {
      if (disposed) {
        return;
      }

      // the theme at mount; a later scheme change keeps these colours
      const theme = getComputedStyle(element);
      const dotColor = theme.getPropertyValue("--muted-foreground").trim();
      const selectedColor = theme.getPropertyValue("--foreground").trim();
      const factsById = new Map<NodeObject["id"], TFactNode>(
        facts.nodes.map((fact) => [fact.id, fact]),
      );
      let selectedId: NodeObject["id"];
      const created = new ForceGraph3D(element)
        .width(element.clientWidth)
        .height(element.clientHeight)
        .backgroundColor(theme.getPropertyValue("--background").trim())
        .showNavInfo(false)
        .nodeRelSize(5)
        .nodeResolution(12)
        .nodeOpacity(1)
        .nodeColor((node) => {
          if (node.id === selectedId) {
            return selectedColor;
          }

          return dotColor;
        })
        // NOTE: an element, not a string. The graph renders a string label as HTML.
        .nodeLabel((node) => {
          const label = document.createElement("span");
          let text = factsById.get(node.id)?.text ?? "";

          if (text.length > MAX_LABEL_LENGTH) {
            text = `${text.slice(0, MAX_LABEL_LENGTH)}…`;
          }

          label.textContent = text;

          return label;
        })
        .linkColor(() => dotColor)
        .linkOpacity(0.25)
        .linkWidth(0)
        // NOTE: the layout is computed before the first frame and then stands still, so the view
        // can be fitted once and no dot moves under the pointer
        .enableNodeDrag(false)
        .warmupTicks(150)
        .cooldownTicks(0)
        .onEngineStop(() => created.zoomToFit(0))
        .onNodeClick((node) => {
          selectedId = node.id;
          setSelected(factsById.get(node.id));
          // repaints the dots
          created.nodeColor(created.nodeColor());
        })
        // NOTE: copies. The graph writes positions into its nodes and node objects into its links.
        .graphData({
          nodes: facts.nodes.map((fact) => ({ ...fact })),
          links: facts.links.map((link) => ({ ...link })),
        });
      graph = created;
      observer.observe(element);
    });

    return () => {
      disposed = true;
      observer.disconnect();
      graph?._destructor();
    };
  }, [facts]);

  if (error !== undefined) {
    return (
      <p class="alert" role="alert">
        {error}
      </p>
    );
  }

  if (facts === undefined) {
    return <p class="muted">Loading…</p>;
  }

  if (facts.nodes.length === 0) {
    return <p class="muted">No facts yet. The bot learns them from your conversations.</p>;
  }

  let details = <p class="muted">Select a dot to read the fact.</p>;

  if (selected !== undefined) {
    details = (
      <>
        <time class="muted">{new Date(selected.createdAt).toLocaleString()}</time>
        <p class="text">{selected.text}</p>
      </>
    );
  }

  return (
    <div class="facts">
      <div class="graph" ref={container} />
      <aside class="card">{details}</aside>
    </div>
  );
}
