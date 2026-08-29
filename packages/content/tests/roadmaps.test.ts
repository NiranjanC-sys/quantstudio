import { describe, expect, it } from 'vitest';

import { LESSONS, getLesson, minutesFor } from '../src/catalog.js';
import { ROADMAPS, getRoadmap, roadmapLoad, roadmapNodes } from '../src/roadmaps.js';
import { RoadmapSchema } from '../src/schema.js';

const KNOWN = new Set(LESSONS.map((l) => l.id));

describe('persona roadmaps', () => {
  it('publishes the seven roadmaps of the syllabus', () => {
    expect(ROADMAPS.map((r) => r.id)).toEqual([
      'cs-student',
      'physics-student',
      'swe-to-quantum-sde',
      'data-scientist-to-qml',
      'researcher',
      'security-to-pqc',
      'technical-manager',
    ]);
  });

  it('matches the syllabus durations', () => {
    const expected: Record<string, number> = {
      'cs-student': 14,
      'physics-student': 12,
      'swe-to-quantum-sde': 16,
      'data-scientist-to-qml': 9,
      researcher: 20,
      'security-to-pqc': 7,
      'technical-manager': 4,
    };
    for (const r of ROADMAPS) expect(r.weeks).toBe(expected[r.id]);
  });

  it('validates against the Zod schema', () => {
    for (const r of ROADMAPS) expect(() => RoadmapSchema.parse(r)).not.toThrow();
  });

  it('references only lessons that exist', () => {
    const missing: string[] = [];
    for (const r of ROADMAPS) {
      for (const week of r.schedule) {
        for (const node of week.nodes) if (!KNOWN.has(node)) missing.push(`${r.id}:${node}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('never schedules the same lesson twice in one roadmap', () => {
    for (const r of ROADMAPS) {
      const nodes = roadmapNodes(r.id);
      expect(new Set(nodes).size).toBe(nodes.length);
    }
  });

  it('numbers weeks from 1 with no gaps and no empty week', () => {
    for (const r of ROADMAPS) {
      expect(r.schedule.map((w) => w.week)).toEqual(r.schedule.map((_, i) => i + 1));
      expect(r.schedule.length).toBe(r.weeks);
      for (const w of r.schedule) expect(w.nodes.length).toBeGreaterThan(0);
    }
  });

  it('respects prerequisites within the roadmap itself', () => {
    const violations: string[] = [];
    for (const r of ROADMAPS) {
      const nodes = roadmapNodes(r.id);
      const position = new Map(nodes.map((id, i) => [id, i]));
      for (const id of nodes) {
        for (const p of getLesson(id)!.prerequisites) {
          const at = position.get(p);
          if (at !== undefined && at > position.get(id)!) violations.push(`${r.id}: ${p} after ${id}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the weekly load within a plausible study budget', () => {
    for (const r of ROADMAPS) {
      for (const minutes of roadmapLoad(r.id)) {
        expect(minutes).toBeGreaterThan(0);
        expect(minutes).toBeLessThanOrEqual(1500);
      }
    }
  });

  it('accounts for every minute it schedules', () => {
    for (const r of ROADMAPS) {
      const total = roadmapLoad(r.id).reduce((a, b) => a + b, 0);
      expect(total).toBe(minutesFor(roadmapNodes(r.id)));
    }
  });

  it('resolves roadmaps by id and returns nothing for an unknown one', () => {
    expect(getRoadmap('cs-student')?.title).toBe('CS student');
    expect(getRoadmap('nope')).toBeUndefined();
    expect(roadmapNodes('nope')).toEqual([]);
  });

  it('gives the technical manager no hands-on labs or projects', () => {
    const types = new Set(roadmapNodes('technical-manager').map((id) => getLesson(id)!.type));
    expect(types.has('lab')).toBe(false);
    expect(types.has('project')).toBe(false);
    expect(types.has('concept')).toBe(true);
  });

  it('gives the data scientist the whole QML sub-track', () => {
    const nodes = new Set(roadmapNodes('data-scientist-to-qml'));
    for (const id of ['t5.m9.l1', 't5.m10.l1', 't5.m11.l1']) expect(nodes.has(id)).toBe(true);
  });
});
