/**
 * 单边重定向预览的测试：
 * 1. 固定场景精确断言：切换后目标隐藏、空陷阱前缀、重定向制造新陷阱、
 *    多安全候选的裁决顺序、ALREADY_SAFE / NO_SINGLE_REDIRECT / TOO_LARGE、
 *    翻转开关保留、原图不被修改、serializeGraph 往返；
 * 2. 随机小图上与“独立枚举所有单边替换”的参考实现对拍（参考实现不与
 *    src/lib/redirect.ts、src/lib/search.ts 共享代码）。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_ORDER,
  parseGraph,
  serializeGraph,
  type ActionKind,
  type FocusGraph,
} from './model';
import {
  applyCandidate,
  previewRedirect,
  redirectAllowed,
  REDIRECT_MAX_NODES,
  REDIRECT_MAX_SWITCHES,
} from './redirect';
import { SAMPLE_TEXT } from './sample';

function make(spec: unknown): FocusGraph {
  const r = parseGraph(spec);
  if (!r.ok) throw new Error(`测试图非法：${r.errors.join('；')}`);
  return r.graph;
}

// ---------------------------------------------------------------------------
// 独立参考实现：字符串状态 "node:bits"，可见性按字面量语义重算
// ---------------------------------------------------------------------------

const key = (n: number, b: number) => `${n}:${b}`;

function refNext(g: FocusGraph, n: number, b: number, a: ActionKind): [number, number] | null {
  const e = g.edges[n][a];
  if (!e) return null;
  const nb = e.flip === null ? b : b ^ (1 << e.flip);
  const ok = g.conditions[e.to].every((l) => (((nb >> l.sw) & 1) === 1) === l.value);
  return ok ? [e.to, nb] : null;
}

/** 能到达目标的状态集：从全部 (target, bits) 沿反向边 BFS */
function refGood(g: FocusGraph): Set<string> {
  const S = 1 << g.switches.length;
  const preds = new Map<string, string[]>();
  for (let n = 0; n < g.nodes.length; n++) {
    for (let b = 0; b < S; b++) {
      for (const a of ACTION_ORDER) {
        const nx = refNext(g, n, b, a);
        if (!nx) continue;
        const to = key(nx[0], nx[1]);
        if (!preds.has(to)) preds.set(to, []);
        preds.get(to)!.push(key(n, b));
      }
    }
  }
  const good = new Set<string>();
  const queue: string[] = [];
  for (let b = 0; b < S; b++) {
    const k = key(g.target, b);
    good.add(k);
    queue.push(k);
  }
  for (let head = 0; head < queue.length; head++) {
    for (const p of preds.get(queue[head]) ?? []) {
      if (!good.has(p)) {
        good.add(p);
        queue.push(p);
      }
    }
  }
  return good;
}

/** 独立判定：是否存在入口可达却无法抵达目标的状态 */
function refTrapped(g: FocusGraph): boolean {
  const good = refGood(g);
  const start = key(g.entry, 0);
  if (!good.has(start)) return true;
  const seen = new Set([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const [n, b] = queue[head].split(':').map(Number);
    for (const a of ACTION_ORDER) {
      const nx = refNext(g, n, b, a);
      if (!nx) continue;
      const k = key(nx[0], nx[1]);
      if (seen.has(k)) continue;
      if (!good.has(k)) return true;
      seen.add(k);
      queue.push(k);
    }
  }
  return false;
}

/** 独立生成重定向后的图（不经 redirect.ts），翻转开关保留 */
function refRedirect(g: FocusGraph, from: number, a: ActionKind, to: number): FocusGraph {
  return {
    ...g,
    edges: g.edges.map((ne, i) =>
      i === from ? { ...ne, [a]: { to, flip: ne[a]!.flip } } : { ...ne }
    ),
  };
}

type RefResult =
  | { kind: 'TOO_LARGE' }
  | { kind: 'ALREADY_SAFE' }
  | { kind: 'NO_SINGLE_REDIRECT' }
  | { kind: 'FOUND'; from: number; action: ActionKind; to: number };

/** 独立枚举所有单边替换，取（源节点 id，动作优先级，目标 id）最小的安全者 */
function refPreview(g: FocusGraph): RefResult {
  if (g.nodes.length > REDIRECT_MAX_NODES || g.switches.length > REDIRECT_MAX_SWITCHES) {
    return { kind: 'TOO_LARGE' };
  }
  if (!refTrapped(g)) return { kind: 'ALREADY_SAFE' };
  for (let from = 0; from < g.nodes.length; from++) {
    for (const action of ACTION_ORDER) {
      const e = g.edges[from][action];
      if (!e) continue;
      for (let to = 0; to < g.nodes.length; to++) {
        if (to === e.to) continue;
        if (!refTrapped(refRedirect(g, from, action, to))) {
          return { kind: 'FOUND', from, action, to };
        }
      }
    }
  }
  return { kind: 'NO_SINGLE_REDIRECT' };
}

/** 用参考转移从入口重放动作序列；任一步不可走返回 null */
function refReplay(g: FocusGraph, actions: ActionKind[]): [number, number] | null {
  let n = g.entry;
  let b = 0;
  for (const a of actions) {
    const nx = refNext(g, n, b, a);
    if (!nx) return null;
    [n, b] = nx;
  }
  return [n, b];
}

// ---------------------------------------------------------------------------
// 固定场景
// ---------------------------------------------------------------------------

describe('内置示例图', () => {
  const g = make(SAMPLE_TEXT);

  it('最小安全候选为 hall —激活→ cell 改向 gate（翻转 lamp 保留）', () => {
    const p = previewRedirect(g);
    expect(p.kind).toBe('FOUND');
    if (p.kind !== 'FOUND') return;
    expect(p.candidate).toEqual({ from: 1, action: 'activate', oldTo: 3, to: 0 });
    expect(p.before!.actions).toEqual(['tab', 'tab']);
    expect(p.after.actions).toEqual(['tab', 'tab']);
    expect(p.trap.actions).toEqual(['tab', 'activate']);
    // 被改边保留翻转，其余边不变
    expect(p.graph.edges[1].activate).toEqual({ to: 0, flip: 0 });
    expect(p.graph.edges[0]).toEqual(g.edges[0]);
    // 修改后的图无陷阱（参考判定）
    expect(refTrapped(p.graph)).toBe(false);
  });
});

describe('切换后目标隐藏', () => {
  // T 仅在 s 关时可见，C 仅在 s 开时可见；B 上激活翻转 s 跳到 C 后，
  // B.tab→T 与 B.activate→C 都因目标隐藏而失效，(B,1)/(C,1) 成为陷阱。
  const g = make({
    nodes: ['A', 'B', 'C', 'T'],
    switches: ['s'],
    entry: 'A',
    target: 'T',
    conditions: { C: [['s', true]], T: [['s', false]] },
    edges: {
      A: { tab: 'B' },
      B: { tab: 'T', activate: { to: 'C', flip: 's' } },
      C: { tab: 'B' },
    },
  });

  it('翻转后指向已隐藏目标的边失效（陷阱成因）', () => {
    expect(refNext(g, 1, 1, 'tab')).toBeNull(); // B.tab→T：s 开后 T 隐藏
    expect(refNext(g, 1, 1, 'activate')).toBeNull(); // B.activate→C：翻转后 C 隐藏
    expect(refTrapped(g)).toBe(true);
  });

  it('最小安全候选为 A.tab 改向 T，返回修改前后见证与被消除的陷阱', () => {
    const p = previewRedirect(g);
    expect(p.kind).toBe('FOUND');
    if (p.kind !== 'FOUND') return;
    expect(p.candidate).toEqual({ from: 0, action: 'tab', oldTo: 1, to: 3 });
    expect(p.before!.actions).toEqual(['tab', 'tab']);
    expect(p.after.actions).toEqual(['tab']);
    expect(p.trap.actions).toEqual(['tab', 'activate']);
    expect(p.graph.edges[0].tab).toEqual({ to: 3, flip: null });
    expect(p.graph.edges[1].activate).toEqual({ to: 2, flip: 0 }); // 未被动过
  });
});

describe('空陷阱前缀（目标原本不可达）', () => {
  // T 仅在 s 开时可见；A 的激活是自环翻转 s，永远到不了 T。
  const g = make({
    nodes: ['A', 'T'],
    switches: ['s'],
    entry: 'A',
    target: 'T',
    conditions: { T: [['s', true]] },
    edges: { A: { activate: { to: 'A', flip: 's' } } },
  });

  it('修改前见证为 null，陷阱为空序列，激活动作重定向后保留翻转', () => {
    const p = previewRedirect(g);
    expect(p.kind).toBe('FOUND');
    if (p.kind !== 'FOUND') return;
    expect(p.candidate).toEqual({ from: 0, action: 'activate', oldTo: 0, to: 1 });
    expect(p.before).toBeNull();
    expect(p.trap.actions).toEqual([]);
    expect(p.after.actions).toEqual(['activate']);
    expect(p.graph.edges[0].activate).toEqual({ to: 1, flip: 0 });
    // 重放修改后见证：(A,s关) —激活→ 翻转 s 落到 (T,s开)
    expect(refReplay(p.graph, p.after.actions)).toEqual([1, 1]);
  });
});

describe('重定向制造新陷阱', () => {
  // B↔C 死循环是原陷阱；把 A.tab 改向 A/B/C 都会让入口自己也到不了 T，
  // 这些候选必须被淘汰，最小安全候选是 A.shiftTab 改向 A。
  const g = make({
    nodes: ['A', 'B', 'C', 'T'],
    entry: 'A',
    target: 'T',
    edges: {
      A: { tab: 'T', shiftTab: 'B' },
      B: { tab: 'C' },
      C: { tab: 'B' },
    },
  });

  it('更小的候选各自制造新陷阱，被逐一淘汰', () => {
    expect(refTrapped(g)).toBe(true);
    // A.tab 改向 A 自环：入口原本能 tab 到 T，改后入口自身成陷阱
    expect(refTrapped(refRedirect(g, 0, 'tab', 0))).toBe(true);
    expect(refTrapped(refRedirect(g, 0, 'tab', 1))).toBe(true);
    expect(refTrapped(refRedirect(g, 0, 'tab', 2))).toBe(true);
  });

  it('最小安全候选为 A.shiftTab 改向 A', () => {
    const p = previewRedirect(g);
    expect(p.kind).toBe('FOUND');
    if (p.kind !== 'FOUND') return;
    expect(p.candidate).toEqual({ from: 0, action: 'shiftTab', oldTo: 1, to: 0 });
    expect(p.before!.actions).toEqual(['tab']);
    expect(p.after.actions).toEqual(['tab']);
    expect(p.trap.actions).toEqual(['shiftTab']);
    expect(refTrapped(p.graph)).toBe(false);
  });
});

describe('多安全候选按（源节点 id，动作优先级，目标 id）取最小', () => {
  // A.tab→C 与 A.tab→T、A.shiftTab→C/T、B.tab→C/T 都安全；
  // 最小者是（A, tab, C）——目标 id C=2 < T=3。
  const g = make({
    nodes: ['A', 'B', 'C', 'T'],
    entry: 'A',
    target: 'T',
    edges: {
      A: { tab: 'B', shiftTab: 'B' },
      B: { tab: 'A' },
      C: { tab: 'T' },
    },
  });

  it('选中目标 id 更小的安全候选', () => {
    expect(refTrapped(refRedirect(g, 0, 'tab', 2))).toBe(false);
    expect(refTrapped(refRedirect(g, 0, 'tab', 3))).toBe(false); // 也安全但目标 id 更大
    const p = previewRedirect(g);
    expect(p.kind).toBe('FOUND');
    if (p.kind !== 'FOUND') return;
    expect(p.candidate).toEqual({ from: 0, action: 'tab', oldTo: 1, to: 2 });
    expect(p.before).toBeNull(); // 原本 A↔B 死循环，T 不可达
    expect(p.after.actions).toEqual(['tab', 'tab']);
    expect(p.trap.actions).toEqual([]);
  });
});

describe('状态分支', () => {
  it('原图已无陷阱返回 ALREADY_SAFE', () => {
    const g = make({
      nodes: ['A', 'T'],
      entry: 'A',
      target: 'T',
      edges: { A: { tab: 'T' }, T: { tab: 'A' } },
    });
    expect(previewRedirect(g).kind).toBe('ALREADY_SAFE');
  });

  it('有候选但全部失败返回 NO_SINGLE_REDIRECT', () => {
    // T 需要 s 开，但图中没有任何翻转手段；改向 T 的边全部失效
    const g = make({
      nodes: ['A', 'B', 'T'],
      switches: ['s'],
      entry: 'A',
      target: 'T',
      conditions: { T: [['s', true]] },
      edges: { A: { tab: 'B' }, B: { tab: 'A' } },
    });
    expect(previewRedirect(g).kind).toBe('NO_SINGLE_REDIRECT');
  });

  it('没有任何已定义边（零候选）返回 NO_SINGLE_REDIRECT', () => {
    const g = make({ nodes: ['A', 'T'], entry: 'A', target: 'T' });
    expect(previewRedirect(g).kind).toBe('NO_SINGLE_REDIRECT');
  });

  it('超过 12 节点或 4 开关返回 TOO_LARGE，导入与搜索上限不变', () => {
    const g13 = make({
      nodes: Array.from({ length: 13 }, (_, i) => `N${i}`),
      entry: 'N0',
      target: 'N1',
    });
    expect(redirectAllowed(g13)).toBe(false);
    expect(previewRedirect(g13).kind).toBe('TOO_LARGE');
    // 13 节点依然能导入（make 未抛错），且参考判定照常工作
    expect(refTrapped(g13)).toBe(true);

    const g5sw = make({
      nodes: ['A', 'T'],
      switches: ['s0', 's1', 's2', 's3', 's4'],
      entry: 'A',
      target: 'T',
    });
    expect(redirectAllowed(g5sw)).toBe(false);
    expect(previewRedirect(g5sw).kind).toBe('TOO_LARGE');
  });
});

describe('不可变性与序列化', () => {
  it('applyCandidate 不修改原图', () => {
    const g = make(SAMPLE_TEXT);
    const snap = JSON.stringify(g);
    const g2 = applyCandidate(g, { from: 1, action: 'activate', oldTo: 3, to: 0 });
    expect(JSON.stringify(g)).toBe(snap);
    expect(g2).not.toBe(g);
    expect(g2.edges[1].activate).toEqual({ to: 0, flip: 0 });
    expect(g.edges[1].activate).toEqual({ to: 3, flip: 0 });
  });

  it('serializeGraph 往返等价', () => {
    const specs: unknown[] = [
      SAMPLE_TEXT,
      {
        nodes: ['A', 'B', 'T'],
        switches: ['s'],
        entry: 'A',
        target: 'T',
        conditions: { T: [['s', true]] },
        edges: { A: { activate: { to: 'B', flip: 's' } }, B: { shiftTab: 'A' } },
      },
      { nodes: ['A', 'T'], entry: 'A', target: 'T' },
    ];
    for (const spec of specs) {
      const g = make(spec);
      const r = parseGraph(serializeGraph(g));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.graph).toEqual(g);
    }
  });
});

// ---------------------------------------------------------------------------
// 随机小图对拍：独立枚举所有单边替换
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

describe('与独立枚举对拍（随机小图）', () => {
  for (let seed = 1; seed <= 200; seed++) {
    it(`种子 ${seed}`, () => {
      const g = make(randomSpec(mulberry32(seed)));
      const snapshot = JSON.stringify(g);

      const got = previewRedirect(g);
      const want = refPreview(g);

      expect(got.kind).toBe(want.kind);
      // 预览不修改原图
      expect(JSON.stringify(g)).toBe(snapshot);
      // serializeGraph 往返等价
      const round = parseGraph(serializeGraph(g));
      expect(round.ok).toBe(true);
      if (round.ok) expect(round.graph).toEqual(g);

      if (got.kind !== 'FOUND' || want.kind !== 'FOUND') return;

      // 候选一致（源节点 id，动作优先级，目标 id 最小）
      expect([got.candidate.from, got.candidate.action, got.candidate.to]).toEqual([
        want.from,
        want.action,
        want.to,
      ]);
      expect(got.candidate.oldTo).toBe(g.edges[want.from][want.action]!.to);

      // 修改后的图仅该边目标不同，翻转全部保留
      const g2 = got.graph;
      for (let i = 0; i < g.nodes.length; i++) {
        for (const a of ACTION_ORDER) {
          const e1 = g.edges[i][a];
          const e2 = g2.edges[i][a];
          expect(e1 === null).toBe(e2 === null);
          if (!e1 || !e2) continue;
          expect(e2.flip).toBe(e1.flip);
          if (i === want.from && a === want.action) expect(e2.to).toBe(want.to);
          else expect(e2.to).toBe(e1.to);
        }
      }
      // 安全候选：修改后入口可达状态都能抵达目标
      expect(refTrapped(g2)).toBe(false);

      // before：原先不可达时为 null，否则可重放到目标
      const good = refGood(g);
      if (!good.has(key(g.entry, 0))) {
        expect(got.before).toBeNull();
      } else {
        expect(got.before).not.toBeNull();
        const end = refReplay(g, got.before!.actions);
        expect(end).not.toBeNull();
        expect(end![0]).toBe(g.target);
      }

      // after：可在修改后的图上重放到目标
      const end2 = refReplay(g2, got.after.actions);
      expect(end2).not.toBeNull();
      expect(end2![0]).toBe(g.target);

      // trap：可在原图上重放，且终态再也无法抵达目标
      const endTrap = refReplay(g, got.trap.actions);
      expect(endTrap).not.toBeNull();
      expect(good.has(key(endTrap![0], endTrap![1]))).toBe(false);
    });
  }
});
