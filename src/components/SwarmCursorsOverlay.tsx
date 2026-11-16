import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { CursorAgentState, CursorSpeed } from '../types/ide';
import { SWARM_CURSOR_PROFILES } from '../engine/swarmProfiles';

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
  phase: number;
  orbit: number;
  curl: number;
  speed: number;
  force: number;
  press: number;
  spin: number;
  animLine: number;
  animCol: number;
}

interface RenderedCursor {
  id: string;
  color: string;
  x: number;
  y: number;
  angle: number;
  scale: number;
  status: CursorAgentState['status'];
  press: number;
}

const SWARM_ARROW_PATH =
  'M4.6 3.9 C4.2 3.1 4.9 2.4 5.7 2.8 L20.6 9.4 C21.5 9.8 21.4 11.1 20.4 11.3 L13.9 12.9 C13.4 13 13 13.4 12.9 13.9 L11.3 20.4 C11.1 21.4 9.8 21.5 9.4 20.6 Z';

const POINTER_KEEPOUT_PX = 48;
const SPEED_FACTOR: Record<CursorSpeed, number> = {
  slow: 0.75,
  normal: 1,
  fast: 1.35,
};

const ACTIVE_STATUSES = new Set([
  'scanning',
  'navigating',
  'writing',
  'editing',
  'verifying',
]);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function getWorkTarget(
  container: HTMLElement,
  activeFilePath: string,
  agent: CursorAgentState | undefined,
  slotIdx: number,
  tSec: number,
  animLine?: number,
  animCol?: number,
  forceActiveWork = false,
): { x: number; y: number; press: number } | null {
  if (!activeFilePath) return null;

  const pane = container.querySelector<HTMLElement>('[data-editor-pane="primary"]');
  if (!pane) return null;
  const paneRect = pane.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const relPane = {
    left: paneRect.left - containerRect.left,
    top: paneRect.top - containerRect.top,
    width: paneRect.width,
    height: paneRect.height,
  };

  const line = Math.max(1, Math.round(animLine ?? agent?.line ?? 1));
  const col = Math.max(1, animCol ?? agent?.column ?? 1);
  const rawStatus = agent?.status ?? 'scanning';
  const isWorkStatus = rawStatus === 'scanning' || rawStatus === 'navigating' || rawStatus === 'writing' || rawStatus === 'editing' || rawStatus === 'verifying';
  // During active fix, never let cursors look idle/stuck - show them working
  const status = forceActiveWork && !isWorkStatus ? (slotIdx % 3 === 0 ? 'writing' : 'scanning') : rawStatus;

  const lineEl =
    pane.querySelector<HTMLElement>(`[data-line="${line}"]`) ??
    pane.querySelector<HTMLElement>('[data-line]');
  if (!lineEl) {
    const fx = relPane.left + relPane.width * 0.55 + (slotIdx - 4.5) * 10;
    const fy = relPane.top + relPane.height * 0.35 + (slotIdx - 4.5) * 14;
    return { x: fx, y: fy, press: 0.12 };
  }

  const lineRect = lineEl.getBoundingClientRect();
  const baseX = lineRect.left - containerRect.left + 88 + Math.min(col - 1, 90) * 6.2;
  const baseY = lineRect.top - containerRect.top + lineRect.height * 0.52;

  const p = tSec * 2.1 + slotIdx * 0.83;
  let ox = (slotIdx - 4.5) * 1.4;
  let oy = ((slotIdx % 3) - 1) * 1.0;
  let press = 0.03;

  if (status === 'scanning') {
    // Precise scan: gentle horizontal sweep near target, minimal jitter
    ox += Math.sin(p * 0.7) * 1.8;
    oy += Math.cos(p * 0.35 + slotIdx) * 0.8;
    press = 0.03 + 0.03 * Math.max(0, Math.sin(p * 0.9));
  } else if (status === 'navigating') {
    ox += Math.sin(p * 0.8) * 1.2;
    oy += Math.cos(p * 0.9) * 0.6;
    press = 0.04;
  } else if (status === 'writing' || status === 'editing') {
    // Precise typing: stay on the caret/target with tiny micro-movement and clear keypress pulse
    ox += Math.sin(p * 1.8) * 0.35;
    oy += Math.sin(p * 2.6) * 0.2;
    press = 0.18 + 0.42 * Math.max(0, Math.sin(p * 6.2 + slotIdx * 0.18));
  } else if (status === 'verifying') {
    ox += Math.sin(p * 0.45) * 1.2;
    oy += Math.cos(p * 0.4) * 0.6;
    press = 0.05 + 0.03 * Math.max(0, Math.sin(p * 1.0));
  } else {
    // subtle idle-at-work presence, no erratic motion
    ox += Math.sin(p * 0.6) * 0.6;
    oy += Math.cos(p * 0.5) * 0.4;
    press = 0.04 + 0.02 * Math.max(0, Math.sin(p * 1.2 + slotIdx * 0.2));
  }

  const x = clamp(baseX + ox, relPane.left + 28, relPane.left + relPane.width - 20);
  const y = clamp(baseY + oy, relPane.top + 36, relPane.top + relPane.height - 20);
  return { x, y, press };
}

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
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const mouseVelRef = useRef({ x: 0, y: 0 });
  const smoothedVelRef = useRef({ x: 0, y: 0 });
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const prev = lastPointerRef.current;
      if (prev) {
        mouseVelRef.current.x = (x - prev.x) * 60;
        mouseVelRef.current.y = (y - prev.y) * 60;
      }
      lastPointerRef.current = { x, y };
      pointerRef.current = { x, y };
    };
    const handleLeave = () => {
      pointerRef.current = null;
      lastPointerRef.current = null;
      mouseVelRef.current.x = 0;
      mouseVelRef.current.y = 0;
    };

    container.addEventListener('pointermove', handleMove, { passive: true });
    container.addEventListener('pointerleave', handleLeave);
    container.addEventListener('pointercancel', handleLeave);
    return () => {
      container.removeEventListener('pointermove', handleMove);
      container.removeEventListener('pointerleave', handleLeave);
      container.removeEventListener('pointercancel', handleLeave);
    };
  }, [containerRef]);

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const container = containerRef.current;
      if (!container) {
        rafId = requestAnimationFrame(step);
        return;
      }
      const rect = container.getBoundingClientRect();
      const width = Math.max(240, rect.width);
      const height = Math.max(200, rect.height);
      const tSec = now / 1000;
      const speedFactor = SPEED_FACTOR[speedRef.current] ?? 1;

      // smoothed mouse velocity (tv, factor min(1,dt*18))
      const tvFactor = Math.min(1, dt * 18);
      const sv = smoothedVelRef.current;
      const mv = mouseVelRef.current;
      sv.x += (mv.x - sv.x) * tvFactor;
      sv.y += (mv.y - sv.y) * tvFactor;
      mv.x *= Math.exp(-dt * 10);
      mv.y *= Math.exp(-dt * 10);

      const currentAgents = agentsRef.current.slice(0, 10);
      // Exactly 10 cursors
      const cursorSlots = SWARM_CURSOR_PROFILES.slice(0, 10).map((profile, idx) => ({
        profile,
        agent: currentAgents.find((a) => a.id === profile.id) ?? currentAgents[idx],
      }));

      const taskRunning = taskRunningRef.current;
      const hasActiveWork =
        taskRunning &&
        !!activeFileRef.current &&
        (currentAgents.some(
          (a) =>
            ACTIVE_STATUSES.has(a.status) &&
            (!a.filePath || a.filePath === activeFileRef.current),
        ) || currentAgents.length > 0);

      const pointer = pointerRef.current;
      const lissajous = {
        x: width * 0.5 + Math.sin(tSec * 0.7) * width * 0.22 + Math.sin(tSec * 0.33) * 40,
        y: height * 0.5 + Math.sin(tSec * 0.9 + 1.2) * height * 0.18 + Math.cos(tSec * 0.41) * 30,
      };

      const ringBase = 135 * (1 + 0.18 * Math.sin(tSec * 0.55));
      const swirl = Math.tanh(Math.cos(tSec * 0.11) * 3);

      const desired: Array<{ x: number; y: number; press: number }> = [];

      for (let idx = 0; idx < cursorSlots.length; idx++) {
        const { profile, agent } = cursorSlots[idx];
        let sim = simMapRef.current.get(profile.id);
        if (!sim) {
          const baseAngle = (idx / 10) * Math.PI * 2;
          sim = {
            x: lissajous.x + Math.cos(baseAngle) * (ringBase + 30),
            y: lissajous.y + Math.sin(baseAngle) * (ringBase + 30),
            vx: 0,
            vy: 0,
            angle: 0,
            phase: baseAngle + idx * 0.618,
            orbit: 70 + (idx % 5) * 22,
            curl: ((idx % 3) - 1) * 0.55,
            speed: 320 + (idx % 4) * 90,
            force: 900 + (idx % 5) * 180,
            press: 0,
            spin: 0.8 + (idx % 4) * 0.25,
            animLine: agent?.line ?? 1,
            animCol: agent?.column ?? 1,
          };
          simMapRef.current.set(profile.id, sim);
        }

        // Animate work position. During active fix, keep ALL cursors moving (no one stands still).
        const effectiveAgent = agent;
        const status = effectiveAgent?.status ?? 'scanning';
        const isWorkStatus = status === 'writing' || status === 'editing' || status === 'scanning' || status === 'navigating' || status === 'verifying';
        const workingNow = hasActiveWork;

        let targetLine = Math.max(1, effectiveAgent?.line ?? 1);
        let targetCol = Math.max(1, effectiveAgent?.column ?? 1);

        if (workingNow) {
          // Keep helpers near real work, but move precisely (no wide synthetic sweeps)
          const anchor = currentAgents.find((a) => ACTIVE_STATUSES.has(a.status) && a.filePath === activeFileRef.current)
            ?? currentAgents.find((a) => ACTIVE_STATUSES.has(a.status))
            ?? effectiveAgent;
          const anchorLine = Math.max(1, anchor?.line ?? targetLine);
          const anchorCol = Math.max(1, anchor?.column ?? targetCol);
          if (!effectiveAgent || !isWorkStatus) {
            // helper cursors: hold nearby positions with subtle, purposeful motion
            const lane = (idx % 5) - 2;
            targetLine = Math.max(1, anchorLine + lane);
            targetCol = Math.max(1, anchorCol + (idx % 3) - 1);
          } else {
            // trust reported targets for actual working agents
            targetLine = Math.max(1, targetLine);
            targetCol = Math.max(1, targetCol);
          }
        }

        const lineDiff = targetLine - sim.animLine;
        sim.animLine += clamp(lineDiff, -dt * (workingNow ? 10 : 18), dt * (workingNow ? 10 : 18));
        if (Math.abs(lineDiff) > 0.5) {
          sim.animCol += (targetCol - sim.animCol) * Math.min(1, dt * 5);
        }

        const colDiff = targetCol - sim.animCol;
        if (workingNow && (!isWorkStatus || status === 'navigating')) {
          // helper: stay near active work and keep gentle forward motion
          if (Math.abs(colDiff) > 0.15) sim.animCol += clamp(colDiff, -dt * 12, dt * 12);
          sim.animCol += dt * (1.2 + (idx % 3) * 0.25);
        } else if (status === 'writing' || status === 'editing') {
          // typing: follow reported target quickly and keep advancing along the typing place
          const typeRate = (9 + (idx % 4)) * speedFactor;
          if (colDiff > 0.12) {
            // move toward newer/reported cursor position (including jumps forward as typing progresses)
            sim.animCol += Math.min(colDiff, dt * (14 + colDiff * 8));
          } else if (colDiff < -0.12) {
            sim.animCol += Math.max(colDiff, -dt * 18);
          } else {
            // when target updates are sparse, continue typing forward smoothly on the same line
            sim.animCol += dt * typeRate * (0.7 + 0.3 * Math.max(0, Math.sin(tSec * 7 + idx)));
          }
        } else if (status === 'scanning') {
          if (Math.abs(colDiff) > 0.15) sim.animCol += clamp(colDiff, -dt * 18, dt * 18);
          sim.animCol += dt * (2.2 + (idx % 3) * 0.4) * (0.6 + 0.4 * Math.sin(tSec * 1.2 + idx));
        } else if (status === 'verifying') {
          if (Math.abs(colDiff) > 0.15) sim.animCol += clamp(colDiff, -dt * 14, dt * 14);
          sim.animCol += dt * 1.4 * (0.5 + 0.5 * Math.sin(tSec * 1.1 + idx));
        } else {
          if (workingNow) {
            if (Math.abs(colDiff) > 0.2) sim.animCol += clamp(colDiff, -dt * 10, dt * 10);
            sim.animCol += dt * 0.8;
          } else {
            sim.animCol += clamp(colDiff, -dt * 16, dt * 16);
          }
        }
        sim.animLine = clamp(sim.animLine, 1, 9999);
        sim.animCol = clamp(sim.animCol, 1, 140);

        let target = hasActiveWork ? lissajous : (pointer ?? lissajous);
        let targetPress = 0;
        if (hasActiveWork) {
          const pane = container.querySelector<HTMLElement>('[data-editor-pane="primary"]');
          const paneRect = pane?.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const workFallback = paneRect
            ? {
                x: (paneRect.left - containerRect.left) + paneRect.width * 0.55 + (idx - 4.5) * 8,
                y: (paneRect.top - containerRect.top) + paneRect.height * 0.4 + (idx % 5) * 18,
              }
            : lissajous;
          target = workFallback;
          const wt = getWorkTarget(container, activeFileRef.current, agent, idx, tSec, sim.animLine, sim.animCol, true);
          if (wt) {
            target = { x: wt.x, y: wt.y };
            targetPress = wt.press;
          }
        } else if (!pointer) {
          target = lissajous;
        }

        const dx = sim.x - target.x;
        const dy = sim.y - target.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const nx = dx / dist;
        const ny = dy / dist;
        const ang = Math.atan2(dy, dx);

        let dvx = 0;
        let dvy = 0;
        if (hasActiveWork) {
          // Precise work motion: strong attraction to exact target, minimal orbit/roam
          const workDesiredDist = 4 + (idx % 3) * 1.5;
          const radial = clamp((workDesiredDist - dist) * 10, -4200, 3200);
          const tangential = Math.sin(tSec * 0.9 + sim.phase) * 4 * speedFactor;
          dvx = nx * radial - ny * tangential;
          dvy = ny * radial + nx * tangential;
        } else {
          // Swarm-site-style flock/orbit around target
          const orbitBias = (sim.orbit - 120) * 0.45;
          const desiredDist = ringBase + orbitBias + 16 * Math.sin(3 * ang + tSec * 0.7 + sim.phase);
          const tangential = 260 * (0.7 + sim.spin * 0.15) * swirl * speedFactor;
          const radial = clamp((desiredDist - dist) * 4, -2600, 1400);
          const proximity = clamp((dist - desiredDist) / 600, 0, 1);
          dvx = -ny * tangential + nx * radial - ny * sim.curl * 320 * proximity;
          dvy = nx * tangential + ny * radial + nx * sim.curl * 320 * proximity;
        }
        desired.push({ x: dvx, y: dvy, press: targetPress });
      }

      // Steering integration with neighbor alignment within 90px (70/30), speed/force caps and distance boost, Euler integration
      const ids = cursorSlots.map((s) => s.profile.id);
      for (let i = 0; i < cursorSlots.length; i++) {
        const id = ids[i];
        const sim = simMapRef.current.get(id)!;

        let avx = 0;
        let avy = 0;
        let neighbors = 0;
        for (let j = 0; j < cursorSlots.length; j++) {
          if (i === j) continue;
          const other = simMapRef.current.get(ids[j])!;
          const d = Math.hypot(other.x - sim.x, other.y - sim.y);
          if (d > 90) continue;
          const w = 1 - d / 90;
          avx += other.vx * w;
          avy += other.vy * w;
          neighbors += w;
        }

        let ax = desired[i].x;
        let ay = desired[i].y;
        if (neighbors > 0) {
          // In work mode stay goal-directed and precise; in idle keep flock cohesion
          const targetW = hasActiveWork ? 0.97 : 0.7;
          const neighW = hasActiveWork ? 0.03 : 0.3;
          ax = ax * targetW + (avx / neighbors) * neighW;
          ay = ay * targetW + (avy / neighbors) * neighW;
        }

        // press decay dt*6 and apply
        sim.press = Math.max(0, sim.press - dt * 6);
        sim.press = Math.max(sim.press, desired[i].press);

        const boostAgent = cursorSlots[i]?.agent;
        const targetForBoost = hasActiveWork
          ? getWorkTarget(container, activeFileRef.current, boostAgent, i, tSec, sim.animLine, sim.animCol, true) ?? lissajous
          : pointer ?? lissajous;
        const away = Math.max(0, Math.hypot(sim.x - targetForBoost.x, sim.y - targetForBoost.y) - 180);
        const speedBoost = hasActiveWork ? (1.0 + Math.min(1.2, away / 140)) : (1.25 + Math.min(3.0, away / 90));
        const maxSpeed = sim.speed * speedFactor * speedBoost;
        const speedMag = Math.hypot(ax, ay);
        if (speedMag > maxSpeed) {
          ax *= maxSpeed / speedMag;
          ay *= maxSpeed / speedMag;
        }

        let steerX = (ax - sim.vx) * (hasActiveWork ? 8 : 6);
        let steerY = (ay - sim.vy) * (hasActiveWork ? 8 : 6);
        const forceBoost = hasActiveWork ? (1.1 + Math.min(2.0, away / 80)) : (1.3 + Math.min(4.5, away / 55));
        const maxForce = sim.force * speedFactor * forceBoost;
        const steerMag = Math.hypot(steerX, steerY);
        if (steerMag > maxForce) {
          steerX *= maxForce / steerMag;
          steerY *= maxForce / steerMag;
        }

        sim.vx += steerX * dt;
        sim.vy += steerY * dt;
        if (hasActiveWork) {
          // damp overshoot near target for precise, "precious" cursor placement
          sim.vx *= Math.exp(-dt * 2.2);
          sim.vy *= Math.exp(-dt * 2.2);
        }
        sim.x += sim.vx * dt;
        sim.y += sim.vy * dt;

        // 48px keepout ring with outward impulse/damping (around pointer when following mouse; around target in idle mouse follow)
        const keepoutCenter = !hasActiveWork && pointer ? pointer : null;
        if (keepoutCenter) {
          const kdx = sim.x - keepoutCenter.x;
          const kdy = sim.y - keepoutCenter.y;
          const kdist = Math.hypot(kdx, kdy) || 0.01;
          if (kdist < POINTER_KEEPOUT_PX) {
            const knx = kdx / kdist;
            const kny = kdy / kdist;
            sim.x = keepoutCenter.x + knx * POINTER_KEEPOUT_PX;
            sim.y = keepoutCenter.y + kny * POINTER_KEEPOUT_PX;
            const inward = (sim.vx - sv.x) * knx + (sim.vy - sv.y) * kny;
            if (inward < 0) {
              sim.vx -= knx * inward * 1.6;
              sim.vy -= kny * inward * 1.6;
            }
            sim.vx += knx * 220;
            sim.vy += kny * 220;
          }
        }

        const pad = 18;
        if (sim.x < -pad) sim.x = -pad;
        if (sim.y < -pad) sim.y = -pad;
        if (sim.x > width + pad) sim.x = width + pad;
        if (sim.y > height + pad) sim.y = height + pad;

        const vmag = Math.hypot(sim.vx, sim.vy);
        if (vmag >= 25) {
          const desiredAngle = (Math.atan2(sim.vy, sim.vx) * 180) / Math.PI + 128;
          let delta = ((desiredAngle - sim.angle + 540) % 360) - 180;
          sim.angle += delta * Math.min(1, dt * 8);
        }
      }

      const nextRendered: RenderedCursor[] = cursorSlots.map(({ profile, agent }) => {
        const sim = simMapRef.current.get(profile.id)!;
        const status = agent?.status ?? 'idle';
        const isTyping = status === 'writing' || status === 'editing';
        const isActive = ACTIVE_STATUSES.has(status);
        const pressDip = isTyping ? 0.13 : isActive ? 0.1 : 0.07;
        return {
          id: profile.id,
          color: profile.color,
          x: Math.round(sim.x * 10) / 10,
          y: Math.round(sim.y * 10) / 10,
          angle: Math.round(sim.angle * 10) / 10,
          scale: 1 - Math.min(isTyping ? 0.16 : 0.12, sim.press * pressDip),
          status,
          press: sim.press,
        };
      });

      // Drop stale sims if profiles changed (unlikely)
      if (simMapRef.current.size > cursorSlots.length) {
        const live = new Set(ids);
        for (const id of simMapRef.current.keys()) {
          if (!live.has(id)) simMapRef.current.delete(id);
        }
      }

      setRenderedCursors(nextRendered);
      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [containerRef]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {renderedCursors.map((c) => {
        const isTyping = c.status === 'writing' || c.status === 'editing';
        const isScanning = c.status === 'scanning' || c.status === 'navigating';
        const isVerifying = c.status === 'verifying';
        const isActive = ACTIVE_STATUSES.has(c.status);
        const isIdle = c.status === 'idle' || c.status === 'done' || c.status === 'error';
        const stateClass = isTyping
          ? 'swarm-cursor--typing'
          : isScanning
            ? 'swarm-cursor--scanning'
            : isVerifying
              ? 'swarm-cursor--verifying'
              : isIdle
                ? 'swarm-cursor--idle'
                : 'swarm-cursor--active';
        const pulse = isTyping ? 0.35 + Math.min(0.65, c.press * 1.4) : isActive ? 0.22 : 0;
        const glow = isTyping
          ? `0 0 0 ${3 + c.press * 4}px ${c.color}33, 0 0 10px ${c.color}55`
          : isVerifying
            ? `0 0 0 3px ${c.color}22, 0 0 8px ${c.color}44`
            : isActive
              ? `0 0 0 2px ${c.color}1f`
              : 'none';

        return (
          <div
            key={c.id}
            data-swarm-cursor={c.id}
            data-swarm-status={c.status}
            style={{
              transform: `translate3d(${c.x}px, ${c.y}px, 0)`,
              willChange: 'transform',
              opacity: c.status === 'error' ? 0.55 : c.status === 'done' || c.status === 'idle' ? 0.82 : 1,
            }}
            className="absolute top-0 left-0"
          >
            <div
              className={`swarm-cursor-state ${stateClass}`}
              style={{
                transform: `translate(-5px, -4px) rotate(${c.angle}deg) scale(${c.scale})`,
                transformOrigin: '5px 4px',
              }}
            >
              {isActive && (
                <span
                  aria-hidden="true"
                  className="swarm-cursor-halo"
                  style={{
                    backgroundColor: c.color,
                    opacity: pulse,
                    transform: `scale(${isTyping ? 1 + c.press * 0.25 : 1})`,
                  }}
                />
              )}
              <svg
                width={30}
                height={30}
                viewBox="0 0 28 28"
                className="swarm-pointer-svg block"
                style={{
                  filter:
                    glow !== 'none'
                      ? `drop-shadow(0 1px 1.5px rgba(18, 20, 23, 0.22)) drop-shadow(${glow})`
                      : undefined,
                }}
              >
                <path
                  d={SWARM_ARROW_PATH}
                  fill={c.color}
                  stroke="#FFFFFF"
                  strokeWidth={1.7}
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}
