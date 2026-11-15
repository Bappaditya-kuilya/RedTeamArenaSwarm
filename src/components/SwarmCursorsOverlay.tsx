import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { CursorAgentState, CursorSpeed } from '../types/ide';

interface SwarmCursorsOverlayProps {
  agents: CursorAgentState[];
  activeFilePath: string;
  isTaskRunning: boolean;
  speed: CursorSpeed;
  containerRef: RefObject<HTMLDivElement | null>;
}

interface CursorSimState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  press: number;
  phase: number;
  radiusX: number;
  radiusY: number;
  freqX: number;
  freqY: number;
}

interface RenderedCursor {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  angle: number;
  scale: number;
  isActive: boolean;
  isWriting: boolean;
  showBox: boolean;
  task: string;
  line: number;
  boxWidth?: number;
  boxHeight?: number;
  boxLeft?: number;
  boxTop?: number;
}

// Exact SVG pointer geometry from califa/swarm-site
const SWARM_ARROW_PATH =
  'M4.6 3.9 C4.2 3.1 4.9 2.4 5.7 2.8 L20.6 9.4 C21.5 9.8 21.4 11.1 20.4 11.3 L13.9 12.9 C13.4 13 13 13.4 12.9 13.9 L11.3 20.4 C11.1 21.4 9.8 21.5 9.4 20.6 Z';

const ROAM_SPEED_FACTOR: Record<CursorSpeed, number> = {
  slow: 0.42,
  normal: 0.78,
  fast: 1.35,
};

export function SwarmCursorsOverlay({
  agents,
  activeFilePath,
  isTaskRunning,
  speed,
  containerRef,
}: SwarmCursorsOverlayProps) {
  const [renderedCursors, setRenderedCursors] = useState<RenderedCursor[]>([]);
  const simMapRef = useRef<Map<string, CursorSimState>>(new Map());
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const activeFileRef = useRef(activeFilePath);
  activeFileRef.current = activeFilePath;
  const taskRunningRef = useRef(isTaskRunning);
  taskRunningRef.current = isTaskRunning;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const mouseRef = useRef<{ x: number; y: number; activeAt: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouseRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        activeAt: performance.now(),
      };
    };

    const handleLeave = () => {
      mouseRef.current = null;
    };

    container.addEventListener('mousemove', handleMove, { passive: true });
    container.addEventListener('mouseleave', handleLeave);
    return () => {
      container.removeEventListener('mousemove', handleMove);
      container.removeEventListener('mouseleave', handleLeave);
    };
  }, [containerRef]);

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.004, (now - lastTime) / 1000));
      lastTime = now;

      const container = containerRef.current;
      const currentAgents = agentsRef.current;
      if (!container || currentAgents.length === 0) {
        rafId = requestAnimationFrame(step);
        return;
      }

      const rect = container.getBoundingClientRect();
      const width = Math.max(320, rect.width);
      const height = Math.max(240, rect.height);
      const tSec = now / 1000;
      const speedFactor = ROAM_SPEED_FACTOR[speedRef.current] ?? 0.42;
      const running = taskRunningRef.current;
      const openFile = activeFileRef.current;

      const editorPaneEl =
        container.querySelector<HTMLElement>('[data-editor-pane="primary"]') ?? container;
      const editorRect = editorPaneEl.getBoundingClientRect();
      const editorRelLeft = editorRect.left - rect.left;
      const editorRelTop = editorRect.top - rect.top;
      const editorWidth = Math.max(240, editorRect.width);
      const editorHeight = Math.max(180, editorRect.height);
      const editorCenterX = editorRelLeft + editorWidth * 0.48;
      const editorCenterY = editorRelTop + editorHeight * 0.5;

      // Global flocking target anchored over the open editor canvas
      const mouseRecent =
        mouseRef.current && now - mouseRef.current.activeAt < 3500 ? mouseRef.current : null;
      const clampedMouseX = mouseRecent
        ? Math.max(editorRelLeft + 36, Math.min(editorRelLeft + editorWidth - 95, mouseRecent.x))
        : editorCenterX;
      const clampedMouseY = mouseRecent
        ? Math.max(editorRelTop + 64, Math.min(editorRelTop + editorHeight - 36, mouseRecent.y))
        : editorCenterY;

      const flockCenterX = mouseRecent
        ? clampedMouseX
        : editorCenterX + Math.sin(tSec * 0.42 * speedFactor) * Math.min(190, editorWidth * 0.28);
      const flockCenterY = mouseRecent
        ? clampedMouseY
        : editorCenterY + Math.cos(tSec * 0.57 * speedFactor + 0.8) * Math.min(130, editorHeight * 0.26);

      const lineNodes = running
        ? Array.from(editorPaneEl.querySelectorAll<HTMLElement>('[data-line]'))
        : [];
      const lineElMap = new Map<number, HTMLElement>();
      for (const el of lineNodes) {
        const ln = Number(el.dataset.line);
        if (ln > 0) lineElMap.set(ln, el);
      }

      const nextRendered: RenderedCursor[] = [];
      let renderedBoxes = 0;

      for (let idx = 0; idx < currentAgents.length; idx++) {
        const agent = currentAgents[idx];
        let sim = simMapRef.current.get(agent.id);
        if (!sim) {
          const ringAngle = (idx / Math.max(1, currentAgents.length)) * Math.PI * 2;
          sim = {
            x: editorCenterX + Math.cos(ringAngle) * Math.min(170, editorWidth * 0.28),
            y: editorCenterY + Math.sin(ringAngle) * Math.min(130, editorHeight * 0.25),
            vx: 0,
            vy: 0,
            angle: 0,
            press: 0,
            phase: ringAngle + idx * 0.618,
            radiusX: 54 + (idx % 5) * 34,
            radiusY: 40 + ((idx * 3) % 5) * 26,
            freqX: 0.38 + (idx % 7) * 0.06,
            freqY: 0.49 + ((idx + 2) % 6) * 0.06,
          };
          simMapRef.current.set(agent.id, sim);
        }

        const isWorkingStatus = ['scanning', 'navigating', 'writing', 'editing', 'verifying'].includes(
          agent.status
        );
        const isWriting = agent.status === 'writing' || agent.status === 'editing';

        let targetX = sim.x;
        let targetY = sim.y;
        let showBox = false;
        let boxWidth: number | undefined;
        let boxHeight: number | undefined;
        let boxLeft: number | undefined;
        let boxTop: number | undefined;

        if (running && isWorkingStatus) {
          const targetLineEl =
            (agent.filePath === openFile ? lineElMap.get(agent.line) : undefined) ??
            lineElMap.get(Math.max(1, (idx % Math.max(1, lineElMap.size)) + 1)) ??
            lineNodes[idx % Math.max(1, lineNodes.length)];

          if (targetLineEl) {
            const lRect = targetLineEl.getBoundingClientRect();
            // Stagger horizontal positions cleanly across the line when multiple cursors share the file
            const baseCol = Math.max(4, agent.column - 1);
            const spreadCol = isWriting ? baseCol : (baseCol + ((idx * 11) % 42));
            const codeTextOffset = 58 + Math.min(editorWidth - 150, spreadCol * 7.4);
            targetX = lRect.left - rect.left + codeTextOffset;
            targetY = lRect.top - rect.top + Math.min(lRect.height * 0.55, 11);

            if ((isWriting || idx === 0) && renderedBoxes < 3) {
              renderedBoxes++;
              showBox = true;
              boxLeft = lRect.left - rect.left + 48;
              boxTop = lRect.top - rect.top;
              boxWidth = Math.min(Math.max(140, editorWidth - 110), 460);
              boxHeight = Math.max(20, lRect.height);
            }
          } else {
            const spreadAngle = (idx / Math.max(1, currentAgents.length)) * Math.PI * 2;
            targetX = editorCenterX + Math.cos(spreadAngle + tSec * 0.4) * Math.min(150, editorWidth * 0.25);
            targetY = editorCenterY + Math.sin(spreadAngle + tSec * 0.4) * Math.min(100, editorHeight * 0.22);
          }
        } else {
          const tMove = tSec * speedFactor;
          const orbitAngle = sim.phase + tMove * (0.45 + (idx % 4) * 0.08);
          const localDriftX = Math.cos(orbitAngle * sim.freqX) * sim.radiusX;
          const localDriftY = Math.sin(orbitAngle * sim.freqY + idx * 0.4) * sim.radiusY;
          const flockPull = mouseRecent ? 0.55 : 0.35;

          const homeX = editorCenterX + Math.cos(sim.phase) * Math.min(editorWidth * 0.3, 210);
          const homeY = editorCenterY + Math.sin(sim.phase) * Math.min(editorHeight * 0.28, 150);

          targetX = homeX * (1 - flockPull) + flockCenterX * flockPull + localDriftX;
          targetY = homeY * (1 - flockPull) + flockCenterY * flockPull + localDriftY;

          // Keep roaming comfortably inside the open editor / workspace canvas without covering right buttons
          const minX = Math.max(24, editorRelLeft + 18);
          const maxX = Math.min(width - 100, editorRelLeft + editorWidth - 90);
          const minY = Math.max(76, editorRelTop + 62);
          const maxY = Math.min(height - 40, editorRelTop + editorHeight - 30);
          targetX = Math.max(minX, Math.min(Math.max(minX + 40, maxX), targetX));
          targetY = Math.max(minY, Math.min(Math.max(minY + 40, maxY), targetY));
        }

        const stiffness = running ? 11.5 : 4.2 * Math.max(0.75, speedFactor);
        const damping = running ? 0.78 : 0.85;
        const ax = (targetX - sim.x) * stiffness;
        const ay = (targetY - sim.y) * stiffness;

        sim.vx = (sim.vx + ax * dt) * Math.pow(damping, dt * 60);
        sim.vy = (sim.vy + ay * dt) * Math.pow(damping, dt * 60);
        sim.x += sim.vx * dt * 10;
        sim.y += sim.vy * dt * 10;

        const desiredAngle = Math.max(-14, Math.min(14, sim.vx * 0.45));
        sim.angle += (desiredAngle - sim.angle) * Math.min(1, dt * 12);

        if (isWriting) {
          sim.press = 0.5 + 0.5 * Math.sin(tSec * 14 + idx);
        } else {
          sim.press = Math.max(0, sim.press - dt * 4);
        }

        nextRendered.push({
          id: agent.id,
          name: agent.name,
          color: agent.color,
          x: Math.round(sim.x * 10) / 10,
          y: Math.round(sim.y * 10) / 10,
          angle: Math.round(sim.angle * 10) / 10,
          scale: 1 - sim.press * 0.1,
          isActive: running && isWorkingStatus,
          isWriting,
          showBox,
          task: agent.task,
          line: agent.line,
          boxLeft,
          boxTop,
          boxWidth,
          boxHeight,
        });
      }

      setRenderedCursors(nextRendered);
      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [containerRef]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
    >
      {/* Active Figma-style selection rectangles (capped cleanly to writing/lead cursors) */}
      {renderedCursors.map((c) =>
        c.showBox && c.boxLeft !== undefined && c.boxTop !== undefined && c.boxWidth && c.boxHeight ? (
          <div
            key={`${c.id}-box`}
            style={{
              transform: `translate3d(${c.boxLeft}px, ${c.boxTop}px, 0)`,
              width: `${c.boxWidth}px`,
              height: `${c.boxHeight}px`,
              borderColor: c.isWriting ? '#0D99FF' : c.color,
              backgroundColor: c.isWriting ? 'rgba(13, 153, 255, 0.08)' : 'transparent',
            }}
            className="absolute top-0 left-0 border pointer-events-none transition-[width,height] duration-150"
          >
            <span className="absolute -top-[3px] -left-[3px] w-[5px] h-[5px] bg-white border border-[#0D99FF]" />
            <span className="absolute -top-[3px] -right-[3px] w-[5px] h-[5px] bg-white border border-[#0D99FF]" />
            <span className="absolute -bottom-[3px] -left-[3px] w-[5px] h-[5px] bg-white border border-[#0D99FF]" />
            <span className="absolute -bottom-[3px] -right-[3px] w-[5px] h-[5px] bg-white border border-[#0D99FF]" />
          </div>
        ) : null
      )}

      {/* All 20 Animated Figma-Style SVG Pointer Cursors */}
      {renderedCursors.map((c) => (
        <div
          key={c.id}
          data-swarm-cursor={c.id}
          style={{
            transform: `translate3d(${c.x}px, ${c.y}px, 0)`,
            willChange: 'transform',
          }}
          className="absolute top-0 left-0"
        >
          <svg
            width={26}
            height={26}
            viewBox="0 0 28 28"
            className="swarm-pointer-svg block"
            style={{
              transform: `translate(-4px, -3px) rotate(${c.angle}deg) scale(${c.scale})`,
              transformOrigin: '4px 3px',
            }}
          >
            <path
              d={SWARM_ARROW_PATH}
              fill={c.color}
              stroke="#FFFFFF"
              strokeWidth={1.6}
              strokeLinejoin="round"
            />
          </svg>

          <div
            style={{ backgroundColor: c.color }}
            className="swarm-cursor-label absolute left-[14px] top-[15px] px-1.5 py-[1px] text-white flex items-center gap-1"
          >
            <span>{c.name}</span>
            {c.isActive && (
              <span className="opacity-85 font-mono text-[9.5px]">:{c.line}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
