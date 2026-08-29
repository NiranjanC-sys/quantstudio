'use client';

/**
 * The Bloch sphere instrument.
 *
 * Built entirely from procedural geometry in code, no downloaded assets: the
 * wireframe, the axes, the arrow and the trace are all generated, which keeps
 * the bundle small and lets every line inherit a design token.
 *
 * Geometry note: the Bloch sphere's y axis points into the screen in the
 * physics convention, while three.js y points up. We map (x, y, z)_bloch to
 * (x, z, -y)_three so that +z_bloch renders upward, which is what every
 * textbook figure shows.
 */

import { useMemo, useRef } from 'react';
import { Canvas, useFrame, type ThreeElements } from '@react-three/fiber';
import { OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import { useThemeColors, usePrefersReducedMotion } from '@/hooks/useThemeColors';

export interface BlochSphereProps {
  vector: { x: number; y: number; z: number };
  /** Previous vectors, oldest first, drawn as a fading trail. */
  trace?: { x: number; y: number; z: number }[];
  label?: string;
  size?: number;
  /** Purity below 1 means a mixed state: the arrow shortens and dims. */
  purity?: number;
}

const toThree = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.z, -v.y);

function Wireframe({ color }: { color: string }) {
  // 12 meridians (half circles, pole to pole) and 6 parallels. Drawing full
  // great circles instead of half ones doubles every line, and the result
  // reads as a solid ball rather than a wireframe.
  const geometry = useMemo(() => {
    const points: THREE.Vector3[] = [];
    const R = 1;
    const SEG = 72;
    // 12 meridian planes, each a full great circle, giving the 24 visible
    // meridians DESIGN.md asks for. Sweeping t over [0, pi] instead would draw
    // only half of each circle and leave the far hemisphere bare.
    for (let m = 0; m < 12; m++) {
      const phi = (m / 12) * Math.PI;
      for (let i = 0; i < SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        const b = ((i + 1) / SEG) * Math.PI * 2;
        for (const t of [a, b]) {
          points.push(
            new THREE.Vector3(R * Math.sin(t) * Math.cos(phi), R * Math.cos(t), R * Math.sin(t) * Math.sin(phi)),
          );
        }
      }
    }
    for (let p = 1; p < 6; p++) {
      const theta = (p / 6) * Math.PI;
      const r = R * Math.sin(theta);
      const y = R * Math.cos(theta);
      for (let i = 0; i < SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        const b = ((i + 1) / SEG) * Math.PI * 2;
        for (const t of [a, b]) points.push(new THREE.Vector3(r * Math.cos(t), y, r * Math.sin(t)));
      }
    }
    return new THREE.BufferGeometry().setFromPoints(points);
  }, []);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.55} />
    </lineSegments>
  );
}

function Axes({ color, textColor }: { color: string; textColor: string }) {
  const axes: { dir: THREE.Vector3; label: string; ket: string }[] = [
    { dir: new THREE.Vector3(1.3, 0, 0), label: 'x', ket: '|+⟩' },
    { dir: new THREE.Vector3(0, 0, -1.3), label: 'y', ket: '|i⟩' },
    { dir: new THREE.Vector3(0, 1.3, 0), label: 'z', ket: '|0⟩' },
  ];
  const geometry = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (const a of axes) {
      pts.push(a.dir.clone().multiplyScalar(-1), a.dir.clone());
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <group>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color={color} transparent opacity={0.8} />
      </lineSegments>
      {axes.map((a) => (
        <Text
          key={a.label}
          position={a.dir.clone().multiplyScalar(1.16).toArray()}
          fontSize={0.13}
          color={textColor}
          anchorX="center"
          anchorY="middle"
        >
          {a.ket}
        </Text>
      ))}
      <Text position={[0, -1.5, 0]} fontSize={0.13} color={textColor} anchorX="center" anchorY="middle">
        |1⟩
      </Text>
    </group>
  );
}

function StateArrow({ vector, color, purity }: { vector: THREE.Vector3; color: string; purity: number }) {
  const group = useRef<THREE.Group>(null);
  const target = useRef(vector.clone());
  target.current = vector;
  const reduced = usePrefersReducedMotion();

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const up = new THREE.Vector3(0, 1, 0);
    const dir = target.current.length() < 1e-6 ? up : target.current.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    if (reduced) g.quaternion.copy(q);
    else g.quaternion.slerp(q, Math.min(1, delta * 12));
  });

  const len = Math.max(0.001, vector.length());
  const shaft = Math.max(0, len - 0.14);

  return (
    <group ref={group}>
      <mesh position={[0, shaft / 2, 0]}>
        <cylinderGeometry args={[0.018, 0.018, shaft, 16]} />
        <meshBasicMaterial color={color} transparent opacity={0.35 + 0.65 * purity} />
      </mesh>
      <mesh position={[0, shaft + 0.07, 0]}>
        <coneGeometry args={[0.055, 0.14, 20]} />
        <meshBasicMaterial color={color} transparent opacity={0.35 + 0.65 * purity} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.03, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

function Trace({ points, color }: { points: THREE.Vector3[]; color: string }) {
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const alphas = new Float32Array(points.length);
    points.forEach((_, i) => {
      alphas[i] = (i + 1) / points.length;
    });
    g.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    return g;
  }, [points]);
  if (!geometry) return null;
  return (
    <line>
      <primitive object={geometry} attach="geometry" />
      <lineBasicMaterial color={color} transparent opacity={0.5} />
    </line>
  );
}

export function BlochSphere({ vector, trace = [], label, size = 260, purity = 1 }: BlochSphereProps) {
  const host = useRef<HTMLDivElement>(null);
  const c = useThemeColors(host);
  const reduced = usePrefersReducedMotion();
  const v = toThree(vector);
  const tracePoints = useMemo(() => trace.map(toThree), [trace]);

  return (
    <div
      ref={host}
      className="rq-bloch"
      style={{ width: size, height: size }}
      role="img"
      aria-label={
        label
          ? `${label}: Bloch vector x ${vector.x.toFixed(3)}, y ${vector.y.toFixed(3)}, z ${vector.z.toFixed(3)}`
          : `Bloch vector x ${vector.x.toFixed(3)}, y ${vector.y.toFixed(3)}, z ${vector.z.toFixed(3)}`
      }
    >
      <Canvas
        camera={{ position: [2.1, 1.5, 2.4], fov: 38 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        frameloop={reduced ? 'demand' : 'always'}
      >
        <Wireframe color={c['hairline-strong']} />
        <Axes color={c['ink-faint']} textColor={c['ink-subtle']} />
        <Trace points={tracePoints} color={c['accent-hover']} />
        <StateArrow vector={v} color={c.accent} purity={purity} />
        <OrbitControls
          enablePan={false}
          enableZoom={false}
          enableDamping={!reduced}
          dampingFactor={0.08}
          rotateSpeed={0.6}
          autoRotate={false}
        />
      </Canvas>
      {label ? <div className="rq-bloch-label">{label}</div> : null}
    </div>
  );
}

export type { ThreeElements };
