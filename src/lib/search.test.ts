/**
 * 搜索实现的测试：
 * 1. 固定小图上的精确断言（含“切换后节点消失”的失效边场景）；
 * 2. 与测试内独立实现的状态搜索在随机小状态图上对拍。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_ORDER,
  parseGraph,
  visible,
  type ActionKind,
  type FocusGraph,
} from './model';
import {
  bitsOf,
  goodStates,
  isDeadEdge,
  nextState,
  nodeOf,
  shortestToTarget,
  startState,
  stateOf,
  trapPrefix,
} from './search';
import { SAMPLE_TEXT } from './sample';

function make(spec: unknown): FocusGraph {
  const r = parseGraph(spec);
  if (!r.ok) throw new Error(`测试图非法：${r.errors.join('；')}`);
  return r.graph;
}

// ---------------------------------------------------------------------------
// 独立参考实现（与 src/lib/search.ts 不共享代码）
// 状态用 "node:bits" 字符串编码，转移直接按字面量语义重算。
// ---------------------------------------------------------------------------

function refNext(g: FocusGraph, node: number, bits: number, a: ActionKind): [number, number] | null {
  const e = g.edges[node][a];
  if (!e) return null;
  const nb = e.flip === null ? bits : bits ^ (1 << e.flip);
  const ok = g.conditions[e.to].every((l) => (((nb >> l.sw) & 1) === 1) === l.value);
  return ok ? [e.to, nb] : null;
}

const key = (n: number, b: number) => `${n}:${b}`;

/** 参考最短路：反向松弛（Bellman-Ford 式）求距离，再按动作优先级贪心取词法最小路径 */
function refDistToTarget(g: FocusGraph): Map<string, number> {
  const S = 1 << g.switches.length;
  const dist = new Map<string, number>();
  for (let b = 0; b < S; b++) dist.set(key(g.target, b), 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (let n = 0; n < g.nodes.length; n++) {
      for (let b = 0; b < S; b++) {
        let best = dist.get(key(n, b)) ?? Infinity;
        for (const a of ACTION_ORDER) {
          const nx = refNext(g, n, b, a);
          if (!nx) continue;
          const d = dist.get(key(nx[0], nx[1]));
          if (d !== undefined && d + 1 < best) best = d + 1;
        }
        if (best < (dist.get(key(n, b)) ?? Infinity)) {
          dist.set(key(n, b), best);
          changed = true;
        }
      }
    }
  }
  return dist;
}

function refWitness(g: FocusGraph): ActionKind[] | null {
  const dist = refDistToTarget(g);
  let n = g.entry;
  let b = 0;
  let d = dist.get(key(n, b));
  if (d === undefined) return null;
  const acts: ActionKind[] = [];
  while (d > 0) {
    let advanced = false;
    for (const a of ACTION_ORDER) {
      const nx = refNext(g, n, b, a);
      if (!nx) continue;
      if (dist.get(key(nx[0], nx[1])) === d - 1) {
        acts.push(a);
        [n, b] = nx;
        d -= 1;
        advanced = true;
        break;
      }
    }
    if (!advanced) throw new Error('参考实现贪心失败');
  }
  return acts;
}

/** 参考陷阱前缀：独立 BFS（字符串状态、数组队列）找首个不可达目标的状态 */
function refTrap(g: FocusGraph): ActionKind[] | null {
  const dist = refDistToTarget(g);
  const start = key(g.entry, 0);
  const prev = new Map<string, { p: string; a: ActionKind }>();
  const seen = new Set([start]);
  const queue = [start];
  let goal: string | null = null;
  if (!dist.has(start)) {
    goal = start;
  } else {
    for (let head = 0; head < queue.length && !goal; head++) {
      const cur = queue[head];
      const [n, b] = cur.split(':').map(Number);
      for (const a of ACTION_ORDER) {
        const nx = refNext(g, n, b, a);
        if (!nx) continue;
        const k = key(nx[0], nx[1]);
        if (seen.has(k)) continue;
        seen.add(k);
        prev.set(k, { p: cur, a });
        if (!dist.has(k)) {
          goal = k;
          break;
        }
        queue.push(k);
      }
    }
  }
  if (goal === null) return null;
  const acts: ActionKind[] = [];
  for (let c = goal; c !== start; c = prev.get(c)!.p) acts.push(prev.get(c)!.a);
  return acts.reverse();
}

// ---------------------------------------------------------------------------
// 固定场景
// ---------------------------------------------------------------------------

describe('内置示例图', () => {
  const g = make(SAMPLE_TEXT);

  it('最短到目标序列为 Tab, Tab', () => {
    const w = shortestToTarget(g);
    expect(w).not.toBeNull();
    expect(w!.actions).toEqual(['tab', 'tab']);
    expect(w!.states[0]).toBe(startState(g));
    expect(nodeOf(g, w!.states[w!.states.length - 1])).toBe(g.target);
  });

  it('最短陷阱前缀为 Tab, 激活，且终态再也无法到达目标', () => {
    const t = trapPrefix(g);
    expect(t).not.toBeNull();
    expect(t!.actions).toEqual(['tab', 'activate']);
    const good = goodStates(g);
    expect(good[t!.states[t!.states.length - 1]]).toBe(0);
    // 更短的前缀都不是陷阱
    expect(good[t!.states[0]]).toBe(1);
    expect(good[t!.states[1]]).toBe(1);
  });
});

describe('切换后节点消失（失效边）', () => {
  // B 仅在 s 关时可见，C 仅在 s 开时可见；在 B 上激活会翻转 s 并跳到 C，
  // 此后 B 消失，C 上回到 B 的 Shift+Tab 边失效。
  const g = make({
    nodes: ['A', 'B', 'C'],
    switches: ['s'],
    entry: 'A',
    target: 'C',
    conditions: { B: [['s', false]], C: [['s', true]] },
    edges: {
      A: { tab: 'B' },
      B: { activate: { to: 'C', flip: 's' } },
      C: { shiftTab: 'B' },
    },
  });

  it('翻转后源节点消失，但动作本身仍可走（焦点落在 C）', () => {
    const w = shortestToTarget(g);
    expect(w!.actions).toEqual(['tab', 'activate']);
    const after = w!.states[2];
    expect(nodeOf(g, after)).toBe(2); // C
    expect(bitsOf(g, after)).toBe(1); // s 已开
    expect(visible(g, 1, 1)).toBe(false); // B 此时隐藏
  });

  it('指向已隐藏节点的边成为失效边，搜索不会走它', () => {
    const atC = stateOf(g, 2, 1);
    expect(isDeadEdge(g, atC, 'shiftTab')).toBe(true);
    expect(nextState(g, atC, 'shiftTab')).toBeNull();
    // 全部可达状态都能到达目标，无陷阱
    expect(trapPrefix(g)).toBeNull();
  });

  it('翻转使目标隐藏时该动作直接不可走', () => {
    const h = make({
      nodes: ['A', 'B'],
      switches: ['s'],
      entry: 'A',
      target: 'B',
      conditions: { B: [['s', false]] },
      edges: { A: { activate: { to: 'B', flip: 's' } } },
    });
    // s 关时激活：翻转后 s 开，B 隐藏 → 失效
    expect(nextState(h, stateOf(h, 0, 0), 'activate')).toBeNull();
    expect(isDeadEdge(h, stateOf(h, 0, 0), 'activate')).toBe(true);
    // s 开时（不可达，但语义上）激活：翻转后 s 关，B 可见 → 可走
    expect(nextState(h, stateOf(h, 0, 1), 'activate')).toBe(stateOf(h, 1, 0));
    // 目标不可达，且入口本身就是陷阱（空前缀）
    expect(shortestToTarget(h)).toBeNull();
    const t = trapPrefix(h);
    expect(t).not.toBeNull();
    expect(t!.actions).toEqual([]);
  });
});

describe('同长度裁决顺序 Tab < Shift+Tab < 激活', () => {
  const base = { nodes: ['E', 'T'], entry: 'E', target: 'T' };

  it('三条边等长时选 Tab', () => {
    const g = make({ ...base, edges: { E: { tab: 'T', shiftTab: 'T', activate: 'T' } } });
    expect(shortestToTarget(g)!.actions).toEqual(['tab']);
  });

  it('无 Tab 时选 Shift+Tab', () => {
    const g = make({ ...base, edges: { E: { shiftTab: 'T', activate: 'T' } } });
    expect(shortestToTarget(g)!.actions).toEqual(['shiftTab']);
  });

  it('更短的路径优先于动作优先级', () => {
    const g = make({
      nodes: ['E', 'X', 'T'],
      entry: 'E',
      target: 'T',
      edges: { E: { tab: 'X', shiftTab: 'T' }, X: { tab: 'T' } },
    });
    expect(shortestToTarget(g)!.actions).toEqual(['shiftTab']);
  });
});

describe('导入校验', () => {
  const valid = {
    nodes: ['A', 'B'],
    switches: ['s'],
    entry: 'A',
    target: 'B',
    conditions: { B: [['s', true]] },
    edges: { A: { activate: { to: 'B', flip: 's' } } },
  };

  it('合法图可导入', () => {
    const r = parseGraph(valid);
    expect(r.ok).toBe(true);
  });

  const invalidCases: Array<[string, unknown]> = [
    ['非 JSON 文本', '{not json'],
    ['根不是对象', [1, 2]],
    ['节点数不足', { ...valid, nodes: ['A'] }],
    ['节点数超限', { ...valid, nodes: Array.from({ length: 41 }, (_, i) => `N${i}`) }],
    ['节点名重复', { ...valid, nodes: ['A', 'A'] }],
    ['开关超限', { ...valid, switches: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }],
    ['开关名重复', { ...valid, switches: ['s', 's'] }],
    ['未知入口', { ...valid, entry: 'ZZ' }],
    ['未知目标', { ...valid, target: 'ZZ' }],
    ['入口即目标', { ...valid, target: 'A' }],
    ['条件引用未知节点', { ...valid, conditions: { ZZ: [['s', true]] } }],
    ['条件引用未知开关', { ...valid, conditions: { B: [['nope', true]] } }],
    ['条件字面量形状错误', { ...valid, conditions: { B: ['s'] } }],
    ['边指向未知节点', { ...valid, edges: { A: { tab: 'ZZ' } } }],
    ['未知动作', { ...valid, edges: { A: { jump: 'B' } } }],
    ['flip 引用未知开关', { ...valid, edges: { A: { activate: { to: 'B', flip: 'nope' } } } }],
    ['tab 目标不是字符串', { ...valid, edges: { A: { tab: { to: 'B' } } } }],
    ['入口初始不可见', { ...valid, entry: 'B', target: 'A' }],
  ];

  it.each(invalidCases)('拒绝：%s', (_name, spec) => {
    const r = parseGraph(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('解析失败不抛异常（调用方据此保留当前图）', () => {
    expect(() => parseGraph('{oops')).not.toThrow();
    const r = parseGraph('{oops');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 随机小状态图对拍
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSpec(rnd: () => number): unknown {
  const n = 2 + Math.floor(rnd() * 5); // 2..6 节点
  const s = Math.floor(rnd() * 4); // 0..3 开关
  const nodes = Array.from({ length: n }, (_, i) => `N${i}`);
  const switches = Array.from({ length: s }, (_, i) => `S${i}`);
  const conditions: Record<string, Array<[string, boolean]>> = {};
  for (let i = 0; i < n; i++) {
    if (s === 0 || rnd() < 0.5) continue;
    const lits: Array<[string, boolean]> = [];
    const count = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < count; k++) {
      const sw = switches[Math.floor(rnd() * s)];
      // 入口节点只允许“关”字面量，保证初始可见
      const value = i === 0 ? false : rnd() < 0.5;
      lits.push([sw, value]);
    }
    conditions[nodes[i]] = lits;
  }
  const edges: Record<string, Record<string, unknown>> = {};
  for (const node of nodes) {
    const e: Record<string, unknown> = {};
    for (const a of ACTION_ORDER) {
      if (rnd() < 0.45) continue;
      const to = nodes[Math.floor(rnd() * n)];
      if (a === 'activate' && s > 0 && rnd() < 0.5) {
        e[a] = { to, flip: switches[Math.floor(rnd() * s)] };
      } else {
        e[a] = to;
      }
    }
    if (Object.keys(e).length > 0) edges[node] = e;
  }
  return { nodes, switches, entry: nodes[0], target: nodes[1], conditions, edges };
}

describe('与独立实现对拍（随机小状态图）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    it(`种子 ${seed}`, () => {
      const g = make(randomSpec(mulberry32(seed)));

      // 最短到目标序列
      const got = shortestToTarget(g);
      const want = refWitness(g);
      expect(got ? got.actions : null).toEqual(want);

      // 见证可重放：states 与逐步 nextState 一致
      if (got) {
        expect(got.states[0]).toBe(startState(g));
        let cur = got.states[0];
        got.actions.forEach((a, i) => {
          cur = nextState(g, cur, a)!;
          expect(cur).toBe(got.states[i + 1]);
        });
      }

      // 最短陷阱前缀
      const gotTrap = trapPrefix(g);
      const wantTrap = refTrap(g);
      expect(gotTrap ? gotTrap.actions : null).toEqual(wantTrap);

      // good 标记与参考距离一致
      const dist = refDistToTarget(g);
      const good = goodStates(g);
      const S = 1 << g.switches.length;
      for (let n = 0; n < g.nodes.length; n++) {
        for (let b = 0; b < S; b++) {
          expect(good[stateOf(g, n, b)]).toBe(dist.has(key(n, b)) ? 1 : 0);
        }
      }
    });
  }
});
